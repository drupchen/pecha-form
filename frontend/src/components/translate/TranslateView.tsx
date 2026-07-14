import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Check, GitBranch, Undo2, ArrowUpToLine, MoveRight, Plus, Trash2 } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore, rangeKey, ovKey } from '../../store/useTranslationStore';
import { TreePane } from '../workspace/TreePane';
import { deriveChunks, applyMoves, insertTitleChunks, insertPassageChunks, type DerivedChunk } from './chunks';
import { usePassageStore } from '../../store/usePassageStore';
import { readTokenSelection } from '../workspace/segments';
import { ChunkEditor } from './ChunkEditor';
import { sanitizeTranslationHtml } from './sanitize';
import { splitParagraphs } from '../documents/compile';
import type { TranslationChunk } from '../../api/client';

/** Group a chunk's tokens into printed lines (a token whose render carries a
 *  newline ends its line), so each line can be numbered — matching the Tibetan
 *  line count the paginator pairs 1:1 with the translation's paragraphs. */
type RenderToken = { id: string; render: string; small?: boolean };
function tibetanLines(tokens: RenderToken[]): RenderToken[][] {
  const lines: RenderToken[][] = [];
  let cur: RenderToken[] = [];
  for (const t of tokens) {
    cur.push(t);
    if (t.render.includes('\n')) { lines.push(cur); cur = []; }
  }
  // Trailing remainder: a real final line if it has visible text; a whitespace-only
  // tail (e.g. a dangling tsheg) rides on the last line instead of a spurious row.
  if (cur.length) {
    const visible = cur.some(t => t.render.replace(/\n/g, '').trim() !== '');
    if (visible || lines.length === 0) lines.push(cur);
    else lines[lines.length - 1].push(...cur);
  }
  return lines;
}

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
  const refreshNonce = useUIStore(s => s.refreshNonce);
  const fetchNodes = useTreeNodeStore(s => s.fetchNodes);
  const treeNodes = useTreeNodeStore(s => s.nodes);
  const setSelectedTreeNodeId = useUIStore(s => s.setSelectedTreeNodeId);

  const languages = useTranslationStore(s => s.languages);
  const serverChunks = useTranslationStore(s => s.chunks);
  const overrides = useTranslationStore(s => s.overrides);
  const seen = useTranslationStore(s => s.seen);
  const suggestions = useTranslationStore(s => s.suggestions);
  const layouts = useTranslationStore(s => s.layouts);
  const passages = usePassageStore(s => s.passages);
  const fetchPassages = usePassageStore(s => s.fetchPassages);
  const editPassage = usePassageStore(s => s.editPassage);
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

  // On-screen text size (Translate tab only) — Tibetan and translation resize
  // independently and persist across reloads. Booklet output is untouched.
  const [boSize, setBoSize] = useState(() => Number(localStorage.getItem('tr-size-bo')) || 1.25);
  const [trSize, setTrSize] = useState(() => Number(localStorage.getItem('tr-size-tr')) || 0.875);
  useEffect(() => { localStorage.setItem('tr-size-bo', String(boSize)); }, [boSize]);
  useEffect(() => { localStorage.setItem('tr-size-tr', String(trSize)); }, [trSize]);
  const clampSize = (n: number) => Math.max(0.75, Math.min(3, Math.round(n * 1000) / 1000));

  // Sapche scroll-spy: as the chunk list scrolls, highlight (and scroll into view)
  // the outline section that owns the chunk currently at the top of the viewport.
  const linkedNodes = useMemo(
    () => treeNodes.filter(n => n.segment_start != null)
      .sort((a, b) => a.segment_start! - b.segment_start!),
    [treeNodes],
  );
  const spyNodeId = useRef<number | null>(null);
  const spyRaf = useRef<number | null>(null);
  const onListScroll = () => {
    if (spyRaf.current != null) return;
    spyRaf.current = requestAnimationFrame(() => {
      spyRaf.current = null;
      const list = listRef.current;
      if (!list || linkedNodes.length === 0) return;
      const top = list.getBoundingClientRect().top;
      const rows = list.querySelectorAll<HTMLElement>('[data-link-key]');
      let curOffset: number | null = null;
      for (const r of rows) {
        if (r.getBoundingClientRect().top - top <= 8) curOffset = Number(r.dataset.linkKey);
        else break;
      }
      if (curOffset == null && rows.length) curOffset = Number(rows[0].dataset.linkKey);
      if (curOffset == null) return;
      let node = null as (typeof linkedNodes)[number] | null;
      for (const n of linkedNodes) { if (n.segment_start! <= curOffset) node = n; else break; }
      if (!node || node.id === spyNodeId.current) return;
      spyNodeId.current = node.id;
      setSelectedTreeNodeId(node.id);
      document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  };

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
    fetchPassages(id);
    fetchLanguages();
    fetchChunks(id);
    fetchCollab(id);
    setArmedMove(null);
  }, [currentText, refreshNonce, fetchTokens, fetchSpans, fetchMarkers, fetchBreaks, fetchNodes, fetchPassages, fetchLanguages, fetchChunks, fetchCollab]);

  // The translator's units: scramble MOVES rearrange the token stream first, the
  // stream chunks naturally, then synthetic TITLE chunks are spliced in. `movedBy`
  // (syl → layout id) marks moved-in tokens and drives the per-chunk undo pills.
  const { chunks, movedBy, movedFromBy, streamIds } = useMemo(() => {
    if (!tokens.length) {
      return { chunks: [], movedBy: new Map<string, number>(),
               movedFromBy: new Map<string, number>(), streamIds: [] as string[] };
    }
    const markerOffsets = new Set(markers.map(m => m.position));
    const { tokens: rearranged, movedBy, movedFromBy } = applyMoves(tokens, layouts);
    const derived = deriveChunks(rearranged, markerOffsets, spans, breakOverrides, lineBreakGroups, movedBy);
    return {
      chunks: insertPassageChunks(
        insertTitleChunks(derived, layouts), passages,
        tokens, markerOffsets, spans, breakOverrides, lineBreakGroups),
      movedBy,
      movedFromBy,
      streamIds: rearranged.map(t => t.id),
    };
  }, [tokens, markers, spans, breakOverrides, lineBreakGroups, layouts, passages]);

  /** Per-unit matching. THE TIBETAN IS THE HARD REFERENCE: one row per derived
   *  unit, always showing its own Tibetan. A unit-exact canonical chunk attaches
   *  normally. A COARSER canonical chunk (e.g. an imported sheet segment spanning
   *  several units) attaches as a COPY: each covered unit's editor pre-fills with
   *  the full translation, badged for trimming — a human removes what doesn't
   *  correspond, and the save lands on the UNIT's own range, materializing the
   *  unit-level canonical chunk that other languages and booklets reference. */
  type DisplayRow = {
    key: string; u: DerivedChunk;
    match: TranslationChunk | null;   // unit-exact chunk
    cover: TranslationChunk | null;   // wider chunk supplying a copy
  };
  const displayRows = useMemo<DisplayRow[]>(() => {
    const pos = new Map(streamIds.map((id, i) => [id, i] as const));
    const byRange = new Map<string, TranslationChunk>();
    for (const c of serverChunks) byRange.set(rangeKey(c.start_syl_id, c.end_syl_id), c);
    const intervals = serverChunks
      .map(c => {
        const s = pos.get(c.start_syl_id), e = pos.get(c.end_syl_id);
        return s != null && e != null && e >= s ? { c, s, e } : null;
      })
      .filter((x): x is { c: TranslationChunk; s: number; e: number } => x != null)
      .sort((a, b) => a.s - b.s);
    return chunks.map((u): DisplayRow => {
      if (u.titleLayout || !u.startSylId) return { key: u.key, u, match: null, cover: null };
      const exact = byRange.get(rangeKey(u.startSylId, u.endSylId)) ?? null;
      const uS = pos.get(u.startSylId), uE = pos.get(u.endSylId);
      let cover = uS != null && uE != null
        ? intervals.find(iv => iv.s <= uE && iv.e >= uS
            && !(iv.s === uS && iv.e === uE))?.c ?? null
        : null;
      if (!exact && !cover) {
        // Out-of-stream canonical (cross-booklet partial): endpoint lookup.
        const ids = new Set(u.sylIds);
        cover = serverChunks.find(c => ids.has(c.start_syl_id) || ids.has(c.end_syl_id)) ?? null;
      }
      return { key: u.key, u, match: exact, cover };
    });
  }, [chunks, serverChunks, streamIds]);

  const translationOf = (chunk: TranslationChunk | null, lang: string) =>
    chunk?.translations.find(t => t.lang === lang);
  // Retrieve a passage's translation from the segments it repeats: for each member run,
  // the source translation chunk COVERING its start syllable (covering, not exact, so a
  // passage that reuses part of a paragraph still pulls that paragraph's translation as a
  // starting point). Consecutive duplicates are collapsed.
  const posById = useMemo(() => {
    const m = new Map<string, number>();
    streamIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [streamIds]);
  // Retrieved translation for a passage group: concat (dedup consecutive) the translations
  // of every source chunk overlapping the group's [start..end] source range.
  const retrievedForGroup = (u: DerivedChunk, lang: string): string => {
    const s0 = u.passageUnitStart ? posById.get(u.passageUnitStart) : undefined;
    const e0 = u.passageUnitEnd ? posById.get(u.passageUnitEnd) : undefined;
    if (s0 == null || e0 == null) return '';
    const bodies: string[] = [];
    serverChunks
      .map(c => ({ c, s: posById.get(c.start_syl_id), e: posById.get(c.end_syl_id) }))
      .filter((x): x is { c: TranslationChunk; s: number; e: number } =>
        x.s != null && x.e != null && x.s <= e0 && x.e >= s0)
      .sort((a, b) => a.s - b.s)
      .forEach(x => {
        const b = translationOf(x.c, lang)?.body ?? '';
        if (b && b !== bodies[bodies.length - 1]) bodies.push(b);
      });
    return bodies.join('');
  };
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
    let updates = 0, stale = 0, copies = 0;
    for (const row of displayRows) {
      const unitBody = translationOf(row.match, targetLang)?.body;
      if (!unitBody && translationOf(row.cover, targetLang)?.body && row.u.tagType !== 'mantra') copies++;
      if (updateAvailable(row.match, targetLang)) updates++;
      if (staleOverride(row.match, targetLang)) stale++;
    }
    return { updates, stale, copies, pending: suggestions.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRows, overrides, seen, suggestions, targetLang]);

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

  const tibetanTokens = (u: DerivedChunk, interactive = true) => {
    const lines = tibetanLines(u.tokens);
    let ti = -1; // running token index across lines, preserved for move selection
    const move = interactive && movable(u);
    return (
      <div
        className={`tibetan-text ${u.tagType === 'mantra' ? 'opacity-40' : ''} ${
          armedMove && move ? 'cursor-crosshair' : ''}`}
        onMouseUp={!armedMove && move ? handleChunkMouseUp : undefined}
        onMouseMove={armedMove && move ? handlePlacementMove : undefined}
        onClick={armedMove && move ? handlePlacementClick : undefined}
      >
        {lines.map((line, li) => (
          <div key={`${u.key}-l${li}`} className="tibetan-line">
            <span className="tibetan-line-no" contentEditable={false}>{li + 1}</span>
            <span className="tibetan-line-text">
              {line.map((t) => {
                ti += 1;
                const mv = movedBy.get(t.id);
                return (
                  <span
                    key={`${u.key}-${ti}`}
                    data-syl-id={t.id}
                    data-ro={ti}
                    data-reo={ti + 1}
                    className={[mv != null ? 'moved-syl' : '',
                                t.small ? (u.tagType === 'mantra' ? 'tib-small implicit-mantra' : 'tib-small') : '']
                                .filter(Boolean).join(' ') || undefined}
                    title={mv != null ? 'Moved here for translation flow — its original place is elsewhere in the Tibetan'
                      : t.small && u.tagType === 'mantra' ? 'Small connector between mantras — implicit mantras to fill in' : undefined}
                  >
                    {/* Break is structural now (line div), so drop the render's trailing newline. */}
                    {t.render.replace(/\n/g, '')}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    );
  };

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
        {/* On-screen size — Tibetan and translation resize independently. */}
        {([
          { label: 'བོ', title: 'Tibetan size', val: boSize, set: setBoSize },
          { label: 'Aa', title: 'Translation size', val: trSize, set: setTrSize },
        ] as const).map(s => (
          <span key={s.title} className="flex items-center gap-0.5" title={s.title}>
            <span className="text-ink-soft mr-0.5">{s.label}</span>
            <button type="button" onClick={() => s.set(v => clampSize(v - 0.125))}
                    className="px-1.5 py-0.5 rounded-md hover:bg-cream leading-none"
                    style={{ border: '1px solid var(--cline)' }}>−</button>
            <button type="button" onClick={() => s.set(v => clampSize(v + 0.125))}
                    className="px-1.5 py-0.5 rounded-md hover:bg-cream leading-none"
                    style={{ border: '1px solid var(--cline)' }}>+</button>
          </span>
        ))}
        <div className="flex-1" />
        {/* Notification strip: what needs the owner's attention in this booklet. */}
        {(counts.updates > 0 || counts.stale > 0 || counts.pending > 0 || counts.copies > 0) && (
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
            {counts.copies > 0 && (
              <span className="px-1.5 rounded-full bg-cream text-ink-soft" title="Units pre-filled with a copy of a wider unit's translation — trim each to fit">
                {counts.copies} to trim
              </span>
            )}
          </span>
        )}
        {saveError && <span className="text-vermilion truncate max-w-md" title={saveError}>{saveError}</span>}
        <span className="text-ink-soft">{displayRows.length} rows · {chunks.length} chunks</span>
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
        <div ref={listRef} onScroll={onListScroll}
             className="translate-list flex-1 overflow-y-auto px-5 py-4 relative"
             style={{ ['--tr-size-bo' as any]: `${boSize}rem`, ['--tr-size-tr' as any]: `${trSize}rem` }}>
          {/* Insertion caret for in-chunk placement (hairline mechanism). */}
          {hairline && (
            <div
              className="scramble-hairline"
              style={{ left: hairline.left, top: hairline.top, height: hairline.height }}
            />
          )}
          <div className="max-w-6xl mx-auto flex flex-col gap-3">
            {displayRows.map((row, i) => {
              const u = row.u;
              // ── Synthetic PASSAGE group (a same-type run of repeated content) ──
              if (u.passage) {
                const p = u.passage;
                const key = u.passageUnitKey ?? '';
                const jump = u.passageSrcOffset != null;
                const goOrigin = () => {
                  const el = document.querySelector<HTMLElement>(`[data-link-key="${u.passageSrcOffset}"]`);
                  if (!el) return;
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  el.classList.add('link-pulse');
                  setTimeout(() => el.classList.remove('link-pulse'), 1300);
                };
                const header = (
                  <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft">
                    <span className="px-1.5 rounded-full font-medium bg-cream">passage · repeated</span>
                    {jump && (
                      <button type="button" onClick={goOrigin} className={`${miniBtn} text-lapis`}
                              style={miniStyle} title="Scroll to the original occurrence">
                        <MoveRight size={10} /> go to original
                      </button>
                    )}
                  </div>
                );
                // Mantra run: kept as is (Sanskrit), no translation.
                if (u.tagType === 'mantra') {
                  return (
                    <div key={u.key} className="grid grid-cols-2 gap-4 rounded-xl bg-cream-hi/50 p-4"
                         style={{ border: '1px dashed var(--cline)' }}>
                      <div className="min-w-0 opacity-60">{header}{tibetanTokens(u, false)}</div>
                      <div className="min-w-0 flex items-center text-xs text-ink-soft italic">
                        Sanskrit — kept as is (phonetics handled in the phonetics bench).
                      </div>
                    </div>
                  );
                }
                // Translatable run: grayed Tibetan + retrieved, passage-local editable translation.
                const retrieved = retrievedForGroup(u, targetLang);
                const local = p.translations?.[targetLang]?.[key];
                const editable = !p.inherited;
                return (
                  <div key={u.key} className="grid grid-cols-2 gap-4 rounded-xl bg-cream-hi/50 p-4"
                       style={{ border: '1px dashed var(--cline)' }}>
                    <div className="min-w-0 opacity-60">{header}{tibetanTokens(u, false)}</div>
                    <div className="min-w-0 flex flex-col gap-1.5">
                      {editable ? (
                        <ChunkEditor
                          value={local ?? retrieved}
                          placeholder={`${targetLang} translation…`}
                          onSave={(html) => {
                            if (html === (local ?? retrieved)) return;
                            const tr = p.translations ?? {};
                            void editPassage(p.id, { translations: { ...tr, [targetLang]: { ...tr[targetLang], [key]: html } } })
                              .catch((e: any) => setSaveError(e.message || 'Passage translation save failed'));
                          }}
                        />
                      ) : (
                        <TranslationBody body={local ?? retrieved} className="whitespace-pre-wrap text-sm opacity-70" />
                      )}
                      <div className="flex items-center gap-2 text-[10px] text-ink-soft flex-wrap">
                        {local != null ? (
                          <>
                            <span className="px-1.5 rounded-full bg-lapis/15 text-lapis flex items-center gap-1"
                                  title="This passage carries its own wording; the original occurrence is untouched">
                              <GitBranch size={9} /> passage-local
                            </span>
                            <button type="button" className={miniBtn} style={miniStyle}
                              onClick={() => {
                                const tr = { ...(p.translations ?? {}) };
                                const langMap = { ...(tr[targetLang] ?? {}) };
                                delete langMap[key];
                                if (Object.keys(langMap).length) tr[targetLang] = langMap; else delete tr[targetLang];
                                void editPassage(p.id, { translations: tr })
                                  .catch((e: any) => setSaveError(e.message));
                              }}
                              title="Discard the local edit and use the original's translation">
                              <Undo2 size={10} /> revert to original
                            </button>
                          </>
                        ) : (
                          <span className="italic">retrieved from its first occurrence — edit here for this passage only</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }
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
              const match = row.match;
              const existing = translationOf(match, targetLang);
              const ov = overrideFor(match?.id, targetLang);
              const pending = pendingFor(match?.id, targetLang);
              // A wider canonical chunk supplies a COPY when the unit has no exact
              // translation yet — a human trims it; the save lands on THE UNIT.
              const copiedBody = !existing && !ov ? translationOf(row.cover, targetLang)?.body : undefined;
              const isCopy = !!copiedBody;
              const effectiveBody = ov?.body ?? existing?.body ?? copiedBody ?? '';
              const hasUpdate = updateAvailable(match, targetLang);
              const isStale = staleOverride(match, targetLang);
              // Writes ALWAYS target the unit's own range — the Tibetan chunking is
              // the hard reference (a unit-exact chunk is created on first save).
              const canonSyl = { start: u.startSylId, end: u.endSylId };
              // Line-count parity: pagination pairs each Tibetan line with the
              // translation's i-th paragraph, so the two counts should match.
              const boLines = tibetanLines(u.tokens).length;
              const trLines = splitParagraphs(effectiveBody).length;
              const showParity = u.tagType !== 'mantra';
              const parityOk = boLines === trLines;
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
                        {showParity && (
                          <span
                            className={`px-1.5 rounded-full font-mono ${
                              parityOk ? 'bg-cream text-ink-soft' : 'bg-vermilion/15 text-vermilion'}`}
                            title={parityOk
                              ? 'Tibetan lines and translation lines match — they pair 1:1 on the printed page'
                              : 'Line-count mismatch — pagination pairs each Tibetan line with the translation’s line, so these should be equal'}
                          >
                            bo {boLines} · {targetLang} {trLines}
                          </span>
                        )}
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
                        {[...new Set(u.tokens.map(t => movedFromBy.get(t.id)).filter((x): x is number => x != null))]
                          .map(layoutId => (
                            <span
                              key={`mvf-${layoutId}`}
                              className="px-1.5 rounded-full bg-gold/20 text-amber-robe flex items-center gap-1"
                              title="Part of this segment was moved elsewhere for translation flow"
                            >
                              moved from here
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
                        {isCopy && u.tagType !== 'mantra' && (
                          <span
                            className="px-1.5 rounded-full bg-gold/20 text-amber-robe"
                            title="Pre-filled with a COPY of a wider unit's translation — remove what doesn't correspond to this passage; saving creates this unit's own translation"
                          >
                            copy — trim to fit
                          </span>
                        )}
                      </div>
                      {sourceContent(u, match ?? row.cover)}
                      {extraLangs.size > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          {[...extraLangs].map(code => {
                            const ovX = overrideFor(match?.id, code);
                            const tr = translationOf(match, code) ?? translationOf(row.cover, code);
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
