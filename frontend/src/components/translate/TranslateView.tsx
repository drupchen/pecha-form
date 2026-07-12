import React, { useEffect, useMemo, useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore, rangeKey } from '../../store/useTranslationStore';
import { TreePane } from '../workspace/TreePane';
import { deriveChunks, type DerivedChunk } from './chunks';
import { ChunkEditor } from './ChunkEditor';
import { sanitizeTranslationHtml, translationText } from './sanitize';
import type { TranslationChunk } from '../../api/client';

/** Read-only rendering of a stored translation body (sanitized HTML subset). */
const TranslationBody: React.FC<{ body: string; className?: string }> = ({ body, className }) => (
  <div
    className={className ?? 'whitespace-pre-wrap text-sm'}
    dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }}
  />
);

/**
 * Translator bench (Phase T1). Left: the booklet's Tibetan chunked by empty
 * lines / segment boundaries (mantra chunks greyed — context only, no
 * translation needed). Right: one text zone per chunk in the target language.
 * The translator picks a SOURCE (the Tibetan or an existing translation) and
 * any number of extra languages for inspiration. Translations are canonical —
 * anchored at the origin text, shared by every booklet reusing the passage.
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
  const fetchLanguages = useTranslationStore(s => s.fetchLanguages);
  const fetchChunks = useTranslationStore(s => s.fetchChunks);
  const save = useTranslationStore(s => s.save);
  const setLevel = useTranslationStore(s => s.setLevel);

  const [targetLang, setTargetLang] = useState('en');
  const [sourceLang, setSourceLang] = useState<'bo' | string>('bo');
  const [extraLangs, setExtraLangs] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);

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
    setDrafts(new Map());
  }, [currentText, fetchTokens, fetchSpans, fetchMarkers, fetchBreaks, fetchNodes, fetchLanguages, fetchChunks]);

  // The translator's units, derived from the same stream the Workspace renders.
  const chunks = useMemo(() => {
    if (!tokens.length) return [];
    const markerOffsets = new Set(markers.map(m => m.position));
    return deriveChunks(tokens, markerOffsets, spans, breakOverrides, lineBreakGroups);
  }, [tokens, markers, spans, breakOverrides, lineBreakGroups]);

  // Server chunks matched to derived units: exact range first, else overlap
  // (partial inclusion still shows the FULL canonical chunk + its translations).
  const matchFor = useMemo(() => {
    const byRange = new Map<string, TranslationChunk>();
    for (const c of serverChunks) byRange.set(rangeKey(c.start_syl_id, c.end_syl_id), c);
    const find = (u: DerivedChunk): { chunk: TranslationChunk | null; partial: boolean } => {
      const exact = byRange.get(rangeKey(u.startSylId, u.endSylId));
      if (exact) return { chunk: exact, partial: false };
      const ids = new Set(u.sylIds);
      const overlapping = serverChunks.find(c => ids.has(c.start_syl_id) || ids.has(c.end_syl_id));
      return overlapping ? { chunk: overlapping, partial: true } : { chunk: null, partial: false };
    };
    return find;
  }, [serverChunks]);

  const translationOf = (chunk: TranslationChunk | null, lang: string) =>
    chunk?.translations.find(t => t.lang === lang);

  if (!currentText) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        No text selected. Pick one from the Texts tab.
      </div>
    );
  }

  const sourceContent = (u: DerivedChunk, match: TranslationChunk | null): React.ReactNode => {
    if (sourceLang === 'bo') {
      return (
        <div className={`tibetan-text whitespace-pre-wrap ${u.tagType === 'mantra' ? 'opacity-40' : ''}`}>
          {u.text}
        </div>
      );
    }
    const tr = translationOf(match, sourceLang);
    if (tr?.body) return <TranslationBody body={tr.body} />;
    return (
      <div>
        <div className="text-xs text-ink-soft italic mb-1">no {sourceLang} yet — Tibetan:</div>
        <div className={`tibetan-text whitespace-pre-wrap ${u.tagType === 'mantra' ? 'opacity-40' : ''}`}>{u.text}</div>
      </div>
    );
  };

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
        {saveError && <span className="text-vermilion truncate max-w-md" title={saveError}>{saveError}</span>}
        <span className="text-ink-soft">{chunks.length} chunks</span>
      </div>

      {/* Body: read-only sapche pane (orientation) + chunk rows */}
      <div className="flex-1 flex overflow-hidden">
        <div
          className="w-80 shrink-0 h-full overflow-hidden"
          style={{ borderRight: '1px solid var(--cline)' }}
        >
          <TreePane forceConsult />
        </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-6xl mx-auto flex flex-col gap-3">
          {chunks.map((u, i) => {
            const { chunk: match, partial } = matchFor(u);
            const existing = translationOf(match, targetLang);
            const draftKey = `${u.key}:${targetLang}`;
            const value = drafts.get(draftKey) ?? existing?.body ?? '';
            const dirty = drafts.has(draftKey) && drafts.get(draftKey) !== (existing?.body ?? '');
            const doSave = async (status?: 'draft' | 'final') => {
              const body = drafts.get(draftKey) ?? existing?.body ?? '';
              if (!translationText(body).trim() && !existing) return;
              setSaveError(null);
              try {
                await save({
                  contextTextId: currentText.id,
                  // Partial inclusion: the canonical chunk range wins — the
                  // translation belongs to the FULL unit, not our fragment of it.
                  startSylId: match && partial ? match.start_syl_id : u.startSylId,
                  endSylId: match && partial ? match.end_syl_id : u.endSylId,
                  lang: targetLang, body,
                  status: status ?? existing?.status ?? 'draft',
                  translatedFrom: sourceLang === 'bo' ? null : sourceLang,
                });
                setDrafts(prev => { const next = new Map(prev); next.delete(draftKey); return next; });
              } catch (e: any) {
                setSaveError(e.message || 'Save failed');
              }
            };
            return (
              <div
                key={u.key}
                data-link-key={u.startOffset}
                className="grid grid-cols-2 gap-4 rounded-xl bg-white p-4"
                style={{ border: '1px solid var(--cline)' }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft">
                    <span className="font-mono">#{i + 1}</span>
                    <span
                      className="px-1.5 rounded-full font-medium"
                      style={u.tagColor
                        ? { backgroundColor: `${u.tagColor}33`, color: 'var(--ink, #1f2937)' }
                        : { backgroundColor: 'var(--cline, #e5e0d5)' }}
                    >
                      {u.tagType}
                    </span>
                    {/* Title level for heading chunks — whole chunk, language-
                        independent; feeds the TOC and PDF heading styles. */}
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
                                startSylId: match && partial ? match.start_syl_id : u.startSylId,
                                endSylId: match && partial ? match.end_syl_id : u.endSylId,
                                level: active ? null : lv,
                              }).catch((e: any) => setSaveError(e.message || 'Level save failed'))}
                              className={`px-1 rounded font-mono ${
                                active ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'
                              }`}
                              style={{ border: '1px solid var(--cline)' }}
                              title={active ? `Heading level ${lv} — click to clear` : `Set heading level ${lv}`}
                            >
                              H{lv}
                            </button>
                          );
                        })}
                      </span>
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
                    ? <div className="tibetan-text whitespace-pre-wrap">{match.text}</div>
                    : sourceContent(u, match)}
                  {extraLangs.size > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {[...extraLangs].map(code => {
                        const tr = translationOf(match, code);
                        return (
                          <div key={code} className="text-xs">
                            <span className="font-mono text-ink-soft mr-1.5">{code}</span>
                            {tr?.body
                              ? <TranslationBody body={tr.body} className="inline-block whitespace-pre-wrap text-xs" />
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
                        value={value}
                        placeholder={`${targetLang} translation…`}
                        onSave={(html) => {
                          if (html === (existing?.body ?? '')) return;
                          setDrafts(prev => new Map(prev).set(draftKey, html));
                          // Commit immediately — the editor already debounces by
                          // only reporting on focus-out.
                          void (async () => {
                            setSaveError(null);
                            try {
                              await save({
                                contextTextId: currentText.id,
                                startSylId: match && partial ? match.start_syl_id : u.startSylId,
                                endSylId: match && partial ? match.end_syl_id : u.endSylId,
                                lang: targetLang, body: html,
                                status: existing?.status ?? 'draft',
                                translatedFrom: sourceLang === 'bo' ? null : sourceLang,
                              });
                              setDrafts(prev => { const next = new Map(prev); next.delete(draftKey); return next; });
                            } catch (e: any) {
                              setSaveError(e.message || 'Save failed');
                            }
                          })();
                        }}
                      />
                      <div className="flex items-center gap-2 text-[10px] text-ink-soft">
                        {existing && (
                          <span className={existing.status === 'final' ? 'text-jade' : ''}>
                            {existing.status}{dirty ? ' · unsaved' : ''}
                          </span>
                        )}
                        {!existing && dirty && <span>unsaved</span>}
                        <div className="flex-1" />
                        {(existing || dirty) && existing?.status !== 'final' && (
                          <button
                            type="button"
                            onClick={() => void doSave('final')}
                            className="px-2 py-0.5 rounded-md flex items-center gap-1 text-jade hover:bg-jade/10"
                            style={{ border: '1px solid var(--cline)' }}
                          >
                            <Check size={10} /> mark final
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
};
