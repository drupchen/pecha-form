import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Check, GitBranch, Undo2, ArrowUpToLine, MoveRight, Plus, X, Trash2 } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore, rangeKey, ovKey } from '../../store/useTranslationStore';
import { TreePane } from '../workspace/TreePane';
import { deriveChunks, applyMoves, insertTitleChunks, type DerivedChunk } from './chunks';
import { readTokenSelection } from '../workspace/segments';
import { ChunkEditor } from './ChunkEditor';
import { sanitizeTranslationHtml } from './sanitize';
import type { TranslationChunk } from '../../api/client';

/** Read-only rendering of a stored translation body (sanitized HTML subset). */
const TranslationBody: React.FC<{ body: string; className?: string }> = ({ body, className }) => (
  <div
    className={className ?? 'whitespace-pre-wrap text-sm'}
    dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }}
  />
);

/**
 * Translator bench. Phase T1: chunked Tibetan + canonical per-chunk translations
 * (ripple everywhere). Phase T2: booklet-local overrides with staleness tracking,
 * update notifications (seen watermarks), suggest-upstream with accept/reject, and
 * the scramble layer — moving small/sapche instruction chunks and inserting
 * synthetic title chunks (global default or booklet-only).
 */
export const TranslateView: React.FC = () => {
  const { currentText } = useTextStore();
  const tokens = useEditorTokenStore(s => s.tokens);
  const fetchTokens = useEditorTokenStore(s => s.fetchTokens);
  const spans = useTagStore(s => s.spans);
  const fetchSpans = useTagStore(s => s.fetchSpans);
  const markers = useMarkerStore(s => s.markers);
  const fetchMarkers = useMarkerStore(s => s.fetchMarkers);
  const breakOverrides = useDisplayBreakStore(s => s.breaks);
  const fetchBreaks = useDisplayBreakStore(s => s.fetchBreaks);
  const lineBreakGroups = useUIStore(s => s.lineBreakGroups);
  const fetchNodes = useTreeNodeStore(s => s.fetchNodes);

  const languages = useTranslationStore(s => s.languages);
  const serverChunks = useTranslationStore(s => s.chunks);
  const overrides = useTranslationStore(s => s.overrides);
  const seen = useTranslationStore(s => s.seen);
  const suggestions = useTranslationStore(s => s.suggestions);
  const layouts = useTranslationStore(s => s.layouts);
  const fetchLanguages = useTranslationStore(s => s.fetchLanguages);
  const fetchChunks = useTranslationStore(s => s.fetchChunks);
  const fetchCollab = useTranslationStore(s => s.fetchCollab);
  const save = useTranslationStore(s => s.save);
  const setLevel = useTranslationStore(s => s.setLevel);
  const saveOverride = useTranslationStore(s => s.saveOverride);
  const revertOverride = useTranslationStore(s => s.revertOverride);
  const acknowledgeBase = useTranslationStore(s => s.acknowledgeBase);
  const doMarkSeen = useTranslationStore(s => s.markSeen);
  const suggestUpstream = useTranslationStore(s => s.suggestUpstream);
  const resolve = useTranslationStore(s => s.resolve);
  const addMove = useTranslationStore(s => s.addMove);
  const addTitle = useTranslationStore(s => s.addTitle);
  const setTitleBody = useTranslationStore(s => s.setTitleBody);
  const setTitleLevel = useTranslationStore(s => s.setTitleLevel);
  const removeLayout = useTranslationStore(s => s.removeLayout);

  const [targetLang, setTargetLang] = useState('en');
  const [sourceLang, setSourceLang] = useState<'bo' | string>('bo');
  const [extraLangs, setExtraLangs] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Armed scramble move: the fragment being placed + scope. */
  const [armedMove, setArmedMove] = useState<{
    srcStart: string; srcEnd: string; bookletOnly: boolean; label: string;
  } | null>(null);
  /** Floating "move selection" button over a syllable-snapped selection. */
  const [selMove, setSelMove] = useState<{
    startSylId: string; endSylId: string; label: string; x: number; y: number;
  } | null>(null);
  /** Insertion caret while placing INSIDE a chunk (hairline mechanism). */
  const [hairline, setHairline] = useState<{
    left: number; top: number; height: number; sylId: string; side: 'before' | 'after';
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Esc cancels an armed placement or a pending selection button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setArmedMove(null);
      setSelMove(null);
      setHairline(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!currentText) return;
    const id = currentText.id;
    fetchTokens(id);
    fetchSpans(id);
    fetchMarkers(id);
    fetchBreaks(id);
    fetchNodes(id);
    fetchLanguages();
    fetchChunks(id);
    fetchCollab(id);
    setArmedMove(null);
  }, [currentText, fetchTokens, fetchSpans, fetchMarkers, fetchBreaks, fetchNodes, fetchLanguages, fetchChunks, fetchCollab]);

  // The translator's units: scramble MOVES rearrange the token stream first, the
  // stream chunks naturally, then synthetic TITLE chunks are spliced in. `movedBy`
  // (syl → layout id) marks moved-in tokens and drives the per-chunk undo pills.
  const { chunks, movedBy, streamIds, renderById } = useMemo(() => {
    if (!tokens.length) {
      return { chunks: [], movedBy: new Map<string, number>(), streamIds: [] as string[],
               renderById: new Map<string, string>() };
    }
    const markerOffsets = new Set(markers.map(m => m.position));
    const { tokens: rearranged, movedBy } = applyMoves(tokens, layouts);
    const derived = deriveChunks(rearranged, markerOffsets, spans, breakOverrides, lineBreakGroups, movedBy);
    // Per-token render strings (incl. the synthesized verse/sapche/mantra line
    // breaks) — reused to display CANONICAL chunk ranges (partial matches) with
    // the same layout as derived units.
    const renderById = new Map<string, string>();
    for (const c of derived) for (const t of c.tokens) renderById.set(t.id, t.render);
    return {
      chunks: insertTitleChunks(derived, layouts),
      movedBy,
      streamIds: rearranged.map(t => t.id),
      renderById,
    };
  }, [tokens, markers, spans, breakOverrides, lineBreakGroups, layouts]);

  /** A canonical chunk's Tibetan rendered from the LOCAL stream with the same
   *  line-break rules as derived units — server text is a plain join. Falls back
   *  to the server text when the range isn't fully in this stream. */
  const canonicalTibetan = (match: TranslationChunk): React.ReactNode => {
    const si = streamIds.indexOf(match.start_syl_id);
    const ei = streamIds.indexOf(match.end_syl_id);
    if (si < 0 || ei < 0 || ei < si) {
      return <div className="tibetan-text whitespace-pre-wrap">{match.text}</div>;
    }
    return (
      <div className="tibetan-text whitespace-pre-wrap">
        {streamIds.slice(si, ei + 1).map((id, i) => (
          <span key={i} data-syl-id={id}>{renderById.get(id) ?? ''}</span>
        ))}
      </div>
    );
  };

  // Server chunks matched to derived units: exact range first, else overlap
  // (partial inclusion still shows the FULL canonical chunk + its translations).
  const matchFor = useMemo(() => {
    const byRange = new Map<string, TranslationChunk>();
    for (const c of serverChunks) byRange.set(rangeKey(c.start_syl_id, c.end_syl_id), c);
    return (u: DerivedChunk): { chunk: TranslationChunk | null; partial: boolean } => {
      if (!u.startSylId) return { chunk: null, partial: false };
      const exact = byRange.get(rangeKey(u.startSylId, u.endSylId));
      if (exact) return { chunk: exact, partial: false };
      const ids = new Set(u.sylIds);
      const overlapping = serverChunks.find(c => ids.has(c.start_syl_id) || ids.has(c.end_syl_id));
      return overlapping ? { chunk: overlapping, partial: true } : { chunk: null, partial: false };
    };
  }, [serverChunks]);

  const translationOf = (chunk: TranslationChunk | null, lang: string) =>
    chunk?.translations.find(t => t.lang === lang);
  const overrideFor = (chunkId: number | undefined, lang: string) =>
    chunkId == null ? undefined : overrides.find(o => o.chunk_id === chunkId && o.lang === lang);
  const pendingFor = (chunkId: number | undefined, lang: string) =>
    chunkId == null ? [] : suggestions.filter(s => s.chunk_id === chunkId && s.lang === lang && s.status === 'pending');

  // "Update available": the canonical moved past this booklet's watermark. A
  // watermark is written whenever THIS booklet saves the canonical, so the badge
  // fires only for changes made elsewhere (another booklet, a suggestion accept).
  const updateAvailable = (match: TranslationChunk | null, lang: string): boolean => {
    const tr = translationOf(match, lang);
    if (!match || !tr) return false;
    if (overrideFor(match.id, lang)) return false;  // overridden: staleness handles it
    const at = seen.get(ovKey(match.id, lang));
    return at != null && tr.updated_at > at;
  };
  const staleOverride = (match: TranslationChunk | null, lang: string) => {
    const tr = translationOf(match, lang);
    const ov = overrideFor(match?.id, lang);
    return !!(tr && ov && ov.base_updated_at && tr.updated_at > ov.base_updated_at);
  };

  // Notification counts for the strip.
  const counts = useMemo(() => {
    let updates = 0, stale = 0, partials = 0;
    for (const u of chunks) {
      const { chunk: match, partial } = matchFor(u);
      if (partial) partials++;
      if (updateAvailable(match, targetLang)) updates++;
      if (staleOverride(match, targetLang)) stale++;
    }
    return { updates, stale, partials, pending: suggestions.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks, matchFor, overrides, seen, suggestions, targetLang]);

  if (!currentText) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        No text selected. Pick one from the Texts tab.
      </div>
    );
  }

  const movable = (u: DerivedChunk) => u.tagType === 'small' || u.tagType === 'sapche';

  /** Syllable-snapped selection inside a movable chunk → floating "move selection"
   *  button (the Workspace's edge-snapping via readTokenSelection). */
  const handleChunkMouseUp = (e: React.MouseEvent) => {
    const container = e.currentTarget as HTMLElement;
    const sel = readTokenSelection(container);
    if (!sel) { setSelMove(null); return; }
    const text = window.getSelection()?.toString() ?? '';
    setSelMove({
      startSylId: sel.startSylId, endSylId: sel.endSylId,
      label: text.slice(0, 24) + (text.length > 24 ? '…' : ''),
      x: sel.rect.left + sel.rect.width / 2, y: sel.rect.bottom,
    });
  };

  /** Hairline caret while a move is armed: snaps before/after the hovered syllable
   *  (by pointer half), positioned inside the scrollable chunk list. */
  const handlePlacementMove = (e: React.MouseEvent) => {
    if (!armedMove) return;
    const el = (e.target as HTMLElement).closest('[data-syl-id]') as HTMLElement | null;
    const list = listRef.current;
    if (!el || !el.dataset.sylId || !list) { setHairline(null); return; }
    const r = el.getBoundingClientRect();
    const cr = list.getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    setHairline({
      left: (side === 'before' ? r.left : r.right) - cr.left + list.scrollLeft,
      top: r.top - cr.top + list.scrollTop,
      height: r.height,
      sylId: el.dataset.sylId,
      side,
    });
  };

  const handlePlacementClick = () => {
    if (!armedMove || !hairline) return;
    let anchor: string | null = hairline.sylId;
    if (hairline.side === 'after') {
      const at = streamIds.indexOf(hairline.sylId);
      anchor = at >= 0 && at + 1 < streamIds.length ? streamIds[at + 1] : null;
    }
    const m = armedMove;
    setArmedMove(null);
    setHairline(null);
    void addMove({
      textId: m.bookletOnly ? currentText!.id : null,
      srcStart: m.srcStart, srcEnd: m.srcEnd, anchor,
    }).catch((e: any) => setSaveError(e.message || 'Move failed'));
  };

  const tibetanTokens = (u: DerivedChunk) => (
    <div
      className={`tibetan-text whitespace-pre-wrap ${u.tagType === 'mantra' ? 'opacity-40' : ''} ${
        armedMove && movable(u) ? 'cursor-crosshair' : ''}`}
      onMouseUp={!armedMove && movable(u) ? handleChunkMouseUp : undefined}
      onMouseMove={armedMove && movable(u) ? handlePlacementMove : undefined}
      onClick={armedMove && movable(u) ? handlePlacementClick : undefined}
    >
      {u.tokens.map((t, ti) => {
        const mv = movedBy.get(t.id);
        return (
          <span
            key={`${u.key}-${ti}`}
            data-syl-id={t.id}
            data-ro={ti}
            data-reo={ti + 1}
            className={mv != null ? 'moved-syl' : undefined}
            title={mv != null ? 'Moved here for translation flow — its original place is elsewhere in the Tibetan' : undefined}
          >
            {t.render}
          </span>
        );
      })}
    </div>
  );

  const sourceContent = (u: DerivedChunk, match: TranslationChunk | null): React.ReactNode => {
    if (sourceLang === 'bo') {
      return tibetanTokens(u);
    }
    const ovSrc = overrideFor(match?.id, sourceLang);
    const tr = translationOf(match, sourceLang);
    const bodySrc = ovSrc?.body ?? tr?.body;
    if (bodySrc) return <TranslationBody body={bodySrc} />;
    return (
      <div>
        <div className="text-xs text-ink-soft italic mb-1">no {sourceLang} yet — Tibetan:</div>
        {tibetanTokens(u)}
      </div>
    );
  };

  /** Thin placement bar shown while a move is armed; also carries "+ title". */
  const placeBar = (anchor: string | null, key: string) => (
    <div key={key} className="flex items-center gap-2 -my-1.5 h-4 group">
      {armedMove ? (
        <button
          type="button"
          onClick={() => {
            const m = armedMove;
            setArmedMove(null);
            void addMove({
              textId: m.bookletOnly ? currentText.id : null,
              srcStart: m.srcStart, srcEnd: m.srcEnd, anchor,
            }).catch((e: any) => setSaveError(e.message || 'Move failed'));
          }}
          className="flex-1 h-2 rounded-full bg-lapis/30 hover:bg-lapis transition-colors"
          title="Place the instruction here"
        />
      ) : (
        <button
          type="button"
          onClick={() => void addTitle({ textId: null, anchor, level: 1 })
            .catch((e: any) => setSaveError(e.message || 'Title failed'))}
          className="mx-auto opacity-0 group-hover:opacity-100 px-2 rounded-full text-[10px] text-ink-soft hover:text-lapis hover:bg-cream transition-opacity flex items-center gap-1"
          style={{ border: '1px solid var(--cline)' }}
          title="Insert an explicit title chunk here (implied in the Tibetan, made explicit in translation)"
        >
          <Plus size={9} /> title
        </button>
      )}
    </div>
  );

  const miniBtn = "px-1.5 py-0.5 rounded-md flex items-center gap-1 hover:bg-cream transition-colors";
  const miniStyle = { border: '1px solid var(--cline)' } as const;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div
        className="px-5 py-2.5 shrink-0 flex items-center gap-4 bg-cream-hi text-xs"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <h2 className="font-display text-xl text-lapis truncate max-w-xs flex items-center gap-2">
          <Languages size={18} /> {currentText.title}
        </h2>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-soft">Translating into</span>
          <select
            value={targetLang}
            onChange={e => setTargetLang(e.target.value)}
            className="px-2 py-1 rounded-md bg-white font-medium"
            style={{ border: '1px solid var(--cline)' }}
          >
            {languages.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-soft">from</span>
          <select
            value={sourceLang}
            onChange={e => setSourceLang(e.target.value)}
            className="px-2 py-1 rounded-md bg-white font-medium"
            style={{ border: '1px solid var(--cline)' }}
          >
            <option value="bo">Tibetan</option>
            {languages.filter(l => l.code !== targetLang).map(l =>
              <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-ink-soft">also show</span>
          {languages.filter(l => l.code !== targetLang && l.code !== sourceLang).map(l => (
            <button
              key={l.code}
              type="button"
              onClick={() => setExtraLangs(prev => {
                const next = new Set(prev);
                if (next.has(l.code)) next.delete(l.code); else next.add(l.code);
                return next;
              })}
              className={`px-2 py-0.5 rounded-full transition-colors ${
                extraLangs.has(l.code)
                  ? 'bg-lapis text-cream-hi'
                  : 'text-ink-soft hover:bg-cream'
              }`}
              style={{ border: '1px solid var(--cline)' }}
            >
              {l.code}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Notification strip: what needs the owner's attention in this booklet. */}
        {(counts.updates > 0 || counts.stale > 0 || counts.pending > 0 || counts.partials > 0) && (
          <span className="flex items-center gap-2">
            {counts.updates > 0 && (
              <span className="px-1.5 rounded-full bg-lapis/15 text-lapis" title="Shared translations updated elsewhere since you last saw them">
                {counts.updates} updated
              </span>
            )}
            {counts.stale > 0 && (
              <span className="px-1.5 rounded-full bg-gold/25 text-amber-robe" title="Shared translations moved on since your booklet-local fork">
                {counts.stale} stale
              </span>
            )}
            {counts.pending > 0 && (
              <span className="px-1.5 rounded-full bg-jade/15 text-jade" title="Pending upstream suggestions to review">
                {counts.pending} suggested
              </span>
            )}
            {counts.partials > 0 && (
              <span className="px-1.5 rounded-full bg-cream text-ink-soft" title="Chunks only partially included in this booklet">
                {counts.partials} partial
              </span>
            )}
          </span>
        )}
        {saveError && <span className="text-vermilion truncate max-w-md" title={saveError}>{saveError}</span>}
        <span className="text-ink-soft">{chunks.length} chunks</span>
      </div>

      {/* Armed-move banner */}
      {armedMove && (
        <div
          className="px-5 py-1.5 shrink-0 flex items-center gap-3 text-xs bg-lapis/10"
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <MoveRight size={12} className="text-lapis" />
          <span>Placing <span className="tibetan-text-sm">{armedMove.label}</span> — click a position between chunks.</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={armedMove.bookletOnly}
              onChange={e => setArmedMove({ ...armedMove, bookletOnly: e.target.checked })}
            />
            this booklet only
          </label>
          <button
            type="button"
            onClick={() => setArmedMove(null)}
            className="underline underline-offset-2 hover:opacity-80"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Body: read-only sapche pane (orientation) + chunk rows */}
      <div className="flex-1 flex overflow-hidden">
        <div
          className="w-80 shrink-0 h-full overflow-hidden"
          style={{ borderRight: '1px solid var(--cline)' }}
        >
          <TreePane forceConsult />
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-4 relative">
          {/* Insertion caret for in-chunk placement (hairline mechanism). */}
          {hairline && (
            <div
              className="scramble-hairline"
              style={{ left: hairline.left, top: hairline.top, height: hairline.height }}
            />
          )}
          <div className="max-w-6xl mx-auto flex flex-col gap-3">
            {chunks.map((u, i) => {
              // ── Synthetic TITLE chunk (scramble layer) ──
              if (u.titleLayout) {
                const l = u.titleLayout;
                return (
                  <React.Fragment key={u.key}>
                    <div
                      className="grid grid-cols-2 gap-4 rounded-xl bg-cream-hi/60 p-4"
                      style={{ border: '1px dashed var(--cline)' }}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft">
                          <span className="px-1.5 rounded-full font-medium bg-cream">title · translation-only</span>
                          <span className="flex items-center gap-0.5" title="Heading level">
                            {[1, 2, 3, 4].map(lv => (
                              <button
                                key={lv}
                                type="button"
                                onClick={() => void setTitleLevel(l.id, lv)
                                  .catch((e: any) => setSaveError(e.message))}
                                className={`px-1 rounded font-mono ${
                                  l.level === lv ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'
                                }`}
                                style={miniStyle}
                              >
                                H{lv}
                              </button>
                            ))}
                          </span>
                          {l.text_id != null && <span className="px-1.5 rounded-full bg-cream">this booklet only</span>}
                          <button
                            type="button"
                            onClick={() => void removeLayout(l.id).catch((e: any) => setSaveError(e.message))}
                            className={`${miniBtn} text-vermilion ml-auto`}
                            style={miniStyle}
                            title="Remove this title chunk"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                        <div className="text-xs italic text-ink-soft">
                          Implied in the Tibetan — made explicit in translation.
                        </div>
                      </div>
                      <div className="min-w-0">
                        <ChunkEditor
                          value={l.titles[targetLang] ?? ''}
                          placeholder={`${targetLang} title…`}
                          onSave={(html) => {
                            if (html === (l.titles[targetLang] ?? '')) return;
                            void setTitleBody(l.id, targetLang, html)
                              .catch((e: any) => setSaveError(e.message || 'Title save failed'));
                          }}
                        />
                      </div>
                    </div>
                  </React.Fragment>
                );
              }

              // ── Regular chunk row ──
              const { chunk: match, partial } = matchFor(u);
              const existing = translationOf(match, targetLang);
              const ov = overrideFor(match?.id, targetLang);
              const pending = pendingFor(match?.id, targetLang);
              const effectiveBody = ov?.body ?? existing?.body ?? '';
              const hasUpdate = updateAvailable(match, targetLang);
              const isStale = staleOverride(match, targetLang);
              const canonSyl = {
                start: match && partial ? match.start_syl_id : u.startSylId,
                end: match && partial ? match.end_syl_id : u.endSylId,
              };
              return (
                <React.Fragment key={u.key}>
                  {placeBar(u.sylIds[0] ?? null, `bar-${u.key}`)}
                  <div
                    data-link-key={u.startOffset}
                    className="grid grid-cols-2 gap-4 rounded-xl bg-white p-4"
                    style={{ border: '1px solid var(--cline)' }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft flex-wrap">
                        <span className="font-mono">#{i + 1}</span>
                        <span
                          className="px-1.5 rounded-full font-medium"
                          style={u.tagColor
                            ? { backgroundColor: `${u.tagColor}33`, color: 'var(--ink, #1f2937)' }
                            : { backgroundColor: 'var(--cline, #e5e0d5)' }}
                        >
                          {u.tagType}
                        </span>
                        {(u.tagType === 'sapche' || u.tagType === 'title') && (
                          <span className="flex items-center gap-0.5" title="Title level (whole chunk)">
                            {[1, 2, 3, 4].map(lv => {
                              const active = match?.level === lv;
                              return (
                                <button
                                  key={lv}
                                  type="button"
                                  onClick={() => void setLevel({
                                    contextTextId: currentText.id,
                                    startSylId: canonSyl.start,
                                    endSylId: canonSyl.end,
                                    level: active ? null : lv,
                                  }).catch((e: any) => setSaveError(e.message || 'Level save failed'))}
                                  className={`px-1 rounded font-mono ${
                                    active ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'
                                  }`}
                                  style={miniStyle}
                                >
                                  H{lv}
                                </button>
                              );
                            })}
                          </span>
                        )}
                        {[...new Set(u.tokens.map(t => movedBy.get(t.id)).filter((x): x is number => x != null))]
                          .map(layoutId => (
                            <span
                              key={`mv-${layoutId}`}
                              className="px-1.5 rounded-full bg-lapis/15 text-lapis flex items-center gap-1"
                              title="Syllables moved here for translation flow — their original place is elsewhere in the Tibetan"
                            >
                              {layoutId === u.movedLayoutId ? 'moved here' : 'moved in'}
                              <button
                                type="button"
                                onClick={() => void removeLayout(layoutId)
                                  .catch((e: any) => setSaveError(e.message))}
                                className="underline underline-offset-2"
                                title="Undo the move"
                              >
                                undo
                              </button>
                            </span>
                          ))}
                        {(u.tagType === 'small' || u.tagType === 'sapche') && !u.movedLayoutId && !armedMove && (
                          <button
                            type="button"
                            onClick={() => setArmedMove({
                              srcStart: u.sylIds[0], srcEnd: u.sylIds[u.sylIds.length - 1],
                              bookletOnly: false, label: u.text.slice(0, 24) + (u.text.length > 24 ? '…' : ''),
                            })}
                            className={`${miniBtn} text-ink-soft`}
                            style={miniStyle}
                            title="Move this instruction elsewhere in the translation flow (display only — the Tibetan is untouched)"
                          >
                            <MoveRight size={10} /> move…
                          </button>
                        )}
                        {partial && match && (
                          <span
                            className="px-1.5 rounded-full bg-gold/20 text-amber-robe"
                            title="This booklet includes only part of this unit — the full canonical chunk is shown"
                          >
                            partial — full chunk shown
                          </span>
                        )}
                      </div>
                      {partial && match
                        ? canonicalTibetan(match)
                        : sourceContent(u, match)}
                      {extraLangs.size > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          {[...extraLangs].map(code => {
                            const ovX = overrideFor(match?.id, code);
                            const tr = translationOf(match, code);
                            const b = ovX?.body ?? tr?.body;
                            return (
                              <div key={code} className="text-xs">
                                <span className="font-mono text-ink-soft mr-1.5">{code}</span>
                                {b
                                  ? <TranslationBody body={b} className="inline-block whitespace-pre-wrap text-xs" />
                                  : <span className="italic text-ink-soft/60">—</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex flex-col gap-1.5">
                      {u.tagType === 'mantra' ? (
                        <div className="flex-1 flex items-center text-xs text-ink-soft italic">
                          Sanskrit — kept as is (phonetics handled in the phonetics bench).
                        </div>
                      ) : (
                        <>
                          <ChunkEditor
                            value={effectiveBody}
                            placeholder={`${targetLang} translation…`}
                            onSave={(html) => {
                              if (html === effectiveBody) return;
                              setSaveError(null);
                              void (async () => {
                                try {
                                  if (ov && match) {
                                    // Booklet-local: edits stay on the override.
                                    await saveOverride(currentText.id, match.id, targetLang, html);
                                  } else {
                                    await save({
                                      contextTextId: currentText.id,
                                      startSylId: canonSyl.start,
                                      endSylId: canonSyl.end,
                                      lang: targetLang, body: html,
                                      status: existing?.status ?? 'draft',
                                      translatedFrom: sourceLang === 'bo' ? null : sourceLang,
                                    });
                                    // Own saves acknowledge themselves: badges then fire
                                    // only for changes made ELSEWHERE.
                                    const fresh = useTranslationStore.getState().chunks
                                      .find(c => c.start_syl_id === canonSyl.start && c.end_syl_id === canonSyl.end);
                                    const tr = fresh?.translations.find(t => t.lang === targetLang);
                                    if (fresh && tr) await doMarkSeen(currentText.id, fresh.id, targetLang, tr.updated_at);
                                  }
                                } catch (e: any) {
                                  setSaveError(e.message || 'Save failed');
                                }
                              })();
                            }}
                          />
                          <div className="flex items-center gap-2 text-[10px] text-ink-soft flex-wrap">
                            {ov ? (
                              <>
                                <span className="px-1.5 rounded-full bg-lapis/15 text-lapis flex items-center gap-1"
                                      title="This booklet shows its own wording; the shared translation is untouched">
                                  <GitBranch size={9} /> booklet-local
                                </span>
                                <button
                                  type="button"
                                  onClick={() => match && void revertOverride(currentText.id, match.id, targetLang)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className={miniBtn}
                                  style={miniStyle}
                                  title="Discard the local wording and return to the shared translation"
                                >
                                  <Undo2 size={10} /> revert to shared
                                </button>
                                <button
                                  type="button"
                                  onClick={() => match && void suggestUpstream(match.id, targetLang, ov.body, currentText.id)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className={`${miniBtn} text-jade`}
                                  style={miniStyle}
                                  title="Propose this wording for the shared translation — the origin's owner accepts or rejects; accepted changes ripple everywhere"
                                >
                                  <ArrowUpToLine size={10} /> suggest upstream
                                </button>
                              </>
                            ) : (
                              existing && match && (
                                <button
                                  type="button"
                                  onClick={() => void saveOverride(currentText.id, match.id, targetLang, existing.body)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className={miniBtn}
                                  style={miniStyle}
                                  title="Fork a booklet-local variant — your edits will stay in this booklet"
                                >
                                  <GitBranch size={10} /> make booklet-local
                                </button>
                              )
                            )}
                            {existing && (
                              <span className={existing.status === 'final' ? 'text-jade' : ''}>
                                {ov ? '' : existing.status}
                              </span>
                            )}
                            <div className="flex-1" />
                            {existing && !ov && existing.status !== 'final' && (
                              <button
                                type="button"
                                onClick={() => void save({
                                  contextTextId: currentText.id,
                                  startSylId: canonSyl.start, endSylId: canonSyl.end,
                                  lang: targetLang, body: existing.body, status: 'final',
                                }).catch((e: any) => setSaveError(e.message))}
                                className={`${miniBtn} text-jade`}
                                style={miniStyle}
                              >
                                <Check size={10} /> mark final
                              </button>
                            )}
                          </div>
                          {hasUpdate && existing && match && (
                            <div className="text-[10px] flex items-center gap-2 px-2 py-1 rounded-md bg-lapis/10">
                              <span>The shared translation was updated elsewhere.</span>
                              <button
                                type="button"
                                onClick={() => void doMarkSeen(currentText.id, match.id, targetLang, existing.updated_at)
                                  .catch((e: any) => setSaveError(e.message))}
                                className="underline underline-offset-2"
                              >
                                mark seen
                              </button>
                            </div>
                          )}
                          {isStale && existing && match && (
                            <div className="text-[10px] flex flex-col gap-1 px-2 py-1 rounded-md bg-gold/15">
                              <div className="flex items-center gap-2">
                                <span>The shared translation moved on since your fork:</span>
                                <button
                                  type="button"
                                  onClick={() => void acknowledgeBase(currentText.id, match.id, targetLang)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className="underline underline-offset-2"
                                  title="Keep your booklet-local wording and dismiss this notice"
                                >
                                  keep mine
                                </button>
                              </div>
                              <TranslationBody body={existing.body} className="whitespace-pre-wrap text-[11px] opacity-80" />
                            </div>
                          )}
                          {pending.map(s => (
                            <div key={s.id} className="text-[10px] flex flex-col gap-1 px-2 py-1 rounded-md bg-jade/10">
                              <div className="flex items-center gap-2">
                                <span className="text-jade font-medium">suggested wording</span>
                                {s.from_text_id != null && <span className="text-ink-soft">from text {s.from_text_id}</span>}
                                <div className="flex-1" />
                                <button
                                  type="button"
                                  onClick={() => void resolve(s.id, true, currentText.id)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className="underline underline-offset-2 text-jade"
                                >
                                  accept
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void resolve(s.id, false, currentText.id)
                                    .catch((e: any) => setSaveError(e.message))}
                                  className="underline underline-offset-2 text-vermilion"
                                >
                                  reject
                                </button>
                              </div>
                              <TranslationBody body={s.body} className="whitespace-pre-wrap text-[11px]" />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            {placeBar(null, 'bar-end')}
          </div>
        </div>
      </div>

      {/* Floating "move selection" button over a syllable-snapped selection. */}
      {selMove && !armedMove && (
        <button
          type="button"
          className="fixed z-50 px-2 py-1 rounded-md text-xs bg-lapis text-cream-hi shadow-lg flex items-center gap-1"
          style={{ left: selMove.x, top: selMove.y + 6, transform: 'translateX(-50%)' }}
          onClick={() => {
            setArmedMove({
              srcStart: selMove.startSylId, srcEnd: selMove.endSylId,
              bookletOnly: false, label: selMove.label,
            });
            setSelMove(null);
            window.getSelection()?.removeAllRanges();
          }}
          title="Move the selected syllables — place them anywhere in another small/sapche chunk (display only; translated once at their new place)"
        >
          <MoveRight size={11} /> move selection
        </button>
      )}
    </div>
  );
};
