import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Volume2, Zap, Check, ChevronUp, ChevronDown } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { usePhoneticsStore, phonKey } from '../../store/usePhoneticsStore';
import { deriveLines, type PhoneticLine } from './lines';
import { useCan } from '../../store/usePermissions';
import { generateBo, generateSkt, STYLE_LANGS, type BoStyle, type BoLang } from './generate';
import type { SktLang } from './sanskrit';
import type { Phonetic } from '../../api/client';

const BO_STYLES: BoStyle[] = ['padmakara', 'thl', 'lotsawahouse', 'rigpa', 'lhasey'];

/** The booklet languages phonetics are authored in (matches the languages table). */
type DocLang = 'en' | 'fr' | 'de' | 'pt';
const DOC_LANGS: DocLang[] = ['en', 'fr', 'de', 'pt'];
const LANG_NAME: Record<DocLang, string> = {
  en: 'English', fr: 'Français', de: 'Deutsch', pt: 'Português',
};

const STATUS_PILL: Record<Phonetic['status'], { label: string; cls: string }> = {
  auto: { label: 'auto', cls: 'bg-gold/25 text-amber-robe' },
  edited: { label: 'edited', cls: 'bg-lapis/15 text-lapis' },
  reviewed: { label: 'reviewed', cls: 'bg-jade/15 text-jade' },
};

/**
 * Phonetics bench (Phase P), language-specific. A document-language selector scopes
 * which stored phonetics are shown/edited/saved (the booklets ship distinct
 * phonetics per language). Two sub-tabs over the document's recited LINES: Tibetan
 * (verse/prose → phonetics via the chosen style) and Sanskrit (mantra → romanization;
 * en/de/pt share a base, fr is rule-derived, IAST optional). Rows anchor to origin
 * syllables, so anything saved auto-populates every document that includes the same
 * primary/secondary.
 */
export const PhoneticsView: React.FC = () => {
  const canEditPhonetics = useCan('phonetics').canModify;
  const currentText = useTextStore(s => s.currentText);
  const tokens = useEditorTokenStore(s => s.tokens);
  const fetchTokens = useEditorTokenStore(s => s.fetchTokens);
  const spans = useTagStore(s => s.spans);
  const fetchSpans = useTagStore(s => s.fetchSpans);
  const markers = useMarkerStore(s => s.markers);
  const fetchMarkers = useMarkerStore(s => s.fetchMarkers);
  const breakOverrides = useDisplayBreakStore(s => s.breaks);
  const fetchBreaks = useDisplayBreakStore(s => s.fetchBreaks);

  const rows = usePhoneticsStore(s => s.rows);
  const fetchPhonetics = usePhoneticsStore(s => s.fetchPhonetics);
  const save = usePhoneticsStore(s => s.save);
  const refreshNonce = useUIStore(s => s.refreshNonce);

  const [tab, setTab] = useState<'bo' | 'skt'>('bo');
  const [docLang, setDocLang] = useState<DocLang>('en');
  const [style, setStyle] = useState<BoStyle>('padmakara');
  const [iast, setIast] = useState(false);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Structural data (language-independent).
  useEffect(() => {
    if (!currentText) return;
    const id = currentText.id;
    fetchTokens(id);
    fetchSpans(id);
    fetchMarkers(id);
    fetchBreaks(id);
  }, [currentText, refreshNonce, fetchTokens, fetchSpans, fetchMarkers, fetchBreaks]);

  // Phonetics are per-language: refetch and drop drafts on a document or language change.
  useEffect(() => {
    if (!currentText) return;
    fetchPhonetics(currentText.id, docLang);
    setDrafts(new Map());
  }, [currentText, docLang, refreshNonce, fetchPhonetics]);

  const lines = useMemo<PhoneticLine[]>(() => {
    if (!tokens.length) return [];
    const markerOffsets = new Set(markers.map(m => m.position));
    return deriveLines(tokens, markerOffsets, spans, breakOverrides);
  }, [tokens, markers, spans, breakOverrides]);

  // Default to the tab that actually has content (a mantra-only text has no `bo` lines,
  // so open it on Sanskrit); leave a mixed-kind text on whatever the user picked.
  useEffect(() => {
    const hasBo = lines.some(l => l.kind === 'bo');
    const hasSkt = lines.some(l => l.kind === 'skt');
    if (!hasBo && hasSkt) setTab('skt');
    else if (hasBo && !hasSkt) setTab('bo');
  }, [lines]);

  // Server rows keyed by kind+range; plus an interval index for overlap fallback.
  const { byRange, pos, intervals } = useMemo(() => {
    const byRange = new Map<string, Phonetic>();
    for (const r of rows) byRange.set(phonKey(r.kind, r.start_syl_id, r.end_syl_id), r);
    const pos = new Map(tokens.map((t, i) => [t.id, i] as const));
    const intervals = rows
      .map(r => {
        const s = pos.get(r.start_syl_id), e = pos.get(r.end_syl_id);
        return s != null && e != null && e >= s ? { r, s, e } : null;
      })
      .filter((x): x is { r: Phonetic; s: number; e: number } => x != null);
    return { byRange, pos, intervals };
  }, [rows, tokens]);

  const shown = useMemo(() => lines.filter(l => l.kind === tab), [lines, tab]);

  // Progress nav: walk the lines still needing phonetics on this tab (they carry `data-empty`).
  // Same interaction as the translate bench's "N to trim" pill: down = first below the
  // viewport midline, up = last above it, wrapping; a short memory after a jump so rapid
  // clicks advance instead of re-finding the row mid-scroll.
  const listRef = useRef<HTMLDivElement>(null);
  const emptyNav = useRef<{ el: HTMLElement | null; at: number; pulse: number }>({ el: null, at: 0, pulse: 0 });
  // 1-based position within the run so the pill can read "3/12" — where you are. 0 = not
  // walking; reset when the set changes (see the effect below).
  const [emptyPos, setEmptyPos] = useState(0);
  const gotoEmpty = (dir: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const els = [...list.querySelectorAll<HTMLElement>('[data-empty]')];
    if (!els.length) { setEmptyPos(0); return; }
    const nav = emptyNav.current;
    const prevIdx = nav.el ? els.indexOf(nav.el) : -1;
    let target: HTMLElement;
    if (prevIdx >= 0 && performance.now() - nav.at < 1600) {
      target = els[(prevIdx + dir + els.length) % els.length];
    } else {
      const mid = list.getBoundingClientRect().top + list.clientHeight / 2;
      target = dir === 1
        ? els.find(el => el.getBoundingClientRect().top > mid + 1) ?? els[0]
        : [...els].reverse().find(el => el.getBoundingClientRect().bottom < mid - 1) ?? els[els.length - 1];
    }
    nav.el = target;
    nav.at = performance.now();
    setEmptyPos(els.indexOf(target) + 1);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.clearTimeout(nav.pulse);
    els.forEach(el => el.classList.remove('link-pulse'));
    target.classList.add('link-pulse');
    nav.pulse = window.setTimeout(() => target.classList.remove('link-pulse'), 1300);
  };

  // Effective generation dialects: bo style may not cover docLang (Padmakara has no
  // de/fr) → fall back to the style's first language; skt uses IAST or the doc language.
  const boLang: BoLang = STYLE_LANGS[style].includes(docLang) ? docLang : STYLE_LANGS[style][0];
  const sktLang: SktLang = iast ? 'iast' : docLang;

  /** The stored row for a line: exact range match, else a same-kind overlap. */
  const matchFor = (l: PhoneticLine): Phonetic | null => {
    const exact = byRange.get(phonKey(l.kind, l.startSylId, l.endSylId));
    if (exact) return exact;
    const uS = pos.get(l.startSylId), uE = pos.get(l.endSylId);
    if (uS == null || uE == null) return null;
    return intervals.find(iv => iv.r.kind === l.kind && iv.s <= uE && iv.e >= uS)?.r ?? null;
  };

  const bodyOf = (l: PhoneticLine, m: Phonetic | null) =>
    drafts.get(l.key) ?? m?.body ?? '';

  const setDraft = (key: string, val: string) =>
    setDrafts(prev => { const n = new Map(prev); n.set(key, val); return n; });

  const doSave = async (
    l: PhoneticLine, body: string, status: Phonetic['status'],
  ) => {
    if (!currentText) return;
    try {
      await save({
        contextTextId: currentText.id,
        startSylId: l.startSylId, endSylId: l.endSylId,
        kind: l.kind, lang: docLang, body, status,
      });
      setDrafts(prev => { const n = new Map(prev); n.delete(l.key); return n; });
    } catch (e: any) {
      setError(e.message || 'Save failed');
    }
  };

  const generateOne = (l: PhoneticLine) =>
    l.kind === 'bo' ? generateBo(l.text, style, boLang) : generateSkt(l.text, sktLang);

  const handleGenerate = (l: PhoneticLine) => {
    const out = generateOne(l);
    setDraft(l.key, out);
    void doSave(l, out, 'auto');
  };

  const handleGenerateAllEmpty = () => {
    for (const l of shown) {
      const m = matchFor(l);
      if (bodyOf(l, m).trim()) continue;   // skip lines that already have text
      const out = generateOne(l);
      if (out) void doSave(l, out, 'auto');
    }
  };

  const handleBlur = (l: PhoneticLine, m: Phonetic | null) => {
    const draft = drafts.get(l.key);
    if (draft == null) return;              // untouched
    if (draft === (m?.body ?? '')) {        // no change
      setDrafts(prev => { const n = new Map(prev); n.delete(l.key); return n; });
      return;
    }
    void doSave(l, draft, 'edited');
  };

  const toggleReviewed = (l: PhoneticLine, m: Phonetic | null, checked: boolean) => {
    const body = bodyOf(l, m);
    void doSave(l, body, checked ? 'reviewed' : 'edited');
  };

  if (!currentText) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-soft">
        Open a text to work on its phonetics.
      </div>
    );
  }

  const counts = { bo: lines.filter(l => l.kind === 'bo').length,
                   skt: lines.filter(l => l.kind === 'skt').length };
  // Lines on THIS tab still needing phonetics for the selected document language — same
  // empty-body test `handleGenerateAllEmpty` uses (drafts count, so a line being typed is
  // already off the list). Feeds the "N to do" pill and its walk.
  const todo = shown.filter(l => !bodyOf(l, matchFor(l)).trim()).length;
  // A walk position only means something against the run it was taken in — switching tab or
  // language, or filling a line, changes the set, so drop back to the bare total.
  useEffect(() => { setEmptyPos(0); }, [todo, tab, docLang]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div
        className="px-5 py-2.5 shrink-0 flex items-center gap-4 bg-cream-hi text-xs"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <h2 className="font-display text-xl text-lapis truncate max-w-xs flex items-center gap-2">
          <Volume2 size={18} /> {currentText.title}
        </h2>

        {/* Document language — scopes which phonetics are shown/edited/saved. */}
        <label className="flex items-center gap-1.5">
          <span className="text-ink-soft">language</span>
          <select
            value={docLang}
            onChange={e => setDocLang(e.target.value as DocLang)}
            className="px-2 py-1 rounded-md bg-white font-medium"
            style={{ border: '1px solid var(--cline)' }}
          >
            {DOC_LANGS.map(l => <option key={l} value={l}>{LANG_NAME[l]}</option>)}
          </select>
        </label>

        {/* Sub-tabs */}
        <div className="flex items-center gap-1">
          {(['bo', 'skt'] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                tab === k ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'
              }`}
              style={tab === k ? undefined : { border: '1px solid var(--cline)' }}
            >
              {k === 'bo' ? `Tibetan · ${counts.bo}` : `Sanskrit · ${counts.skt}`}
            </button>
          ))}
        </div>

        {tab === 'bo' ? (
          <label className="flex items-center gap-1.5">
            <span className="text-ink-soft">style</span>
            <select
              value={style}
              onChange={e => setStyle(e.target.value as BoStyle)}
              className="px-2 py-1 rounded-md bg-white font-medium"
              style={{ border: '1px solid var(--cline)' }}
            >
              {BO_STYLES.map(s => (
                <option key={s} value={s}>
                  {s}{STYLE_LANGS[s].includes(docLang) ? '' : ` (no ${docLang})`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={iast} onChange={e => setIast(e.target.checked)} />
            <span className="text-ink-soft">IAST (scholarly)</span>
          </label>
        )}

        {canEditPhonetics && (
        <button
          type="button"
          onClick={handleGenerateAllEmpty}
          className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream transition-colors"
          style={{ border: '1px solid var(--cline)' }}
          title="Generate phonetics for every empty line on this tab"
        >
          <Zap size={12} /> generate all empty
        </button>
        )}

        <div className="flex-1" />
        {/* Progress: how many lines on this tab still need phonetics, and chevrons to walk
            from one to the next. */}
        {todo > 0 && (
          <span className="flex items-center gap-0.5">
            <span className="px-1.5 rounded-full bg-vermilion/10 text-vermilion"
                  title={`${todo} ${tab === 'bo' ? 'Tibetan' : 'Sanskrit'} line${todo === 1 ? '' : 's'} on this tab still need phonetics`
                    + (emptyPos ? ` — you are on ${emptyPos} of ${todo}` : '')}>
              {emptyPos ? `${emptyPos}/${todo}` : todo} to do
            </span>
            <button type="button" onClick={() => gotoEmpty(-1)}
                    className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                    style={{ border: '1px solid var(--cline)' }}
                    title="Previous line still to do">
              <ChevronUp size={11} />
            </button>
            <button type="button" onClick={() => gotoEmpty(1)}
                    className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                    style={{ border: '1px solid var(--cline)' }}
                    title="Next line still to do">
              <ChevronDown size={11} />
            </button>
          </span>
        )}
        {error && <span className="text-vermilion truncate max-w-md" title={error}>{error}</span>}
        <span className="text-ink-soft">{shown.length} lines · {docLang}</span>
      </div>

      {/* Rows */}
      <div ref={listRef} className="flex-1 overflow-auto px-5 py-3">
        {shown.length === 0 ? (
          <div className="text-ink-soft text-sm py-8 text-center">
            No {tab === 'bo' ? 'Tibetan verse/prose' : 'Sanskrit mantra'} lines in this document.
          </div>
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--cline)' }}>
            {shown.map((l, i) => {
              const m = matchFor(l);
              const body = bodyOf(l, m);
              const status = m?.status ?? 'auto';
              const dirty = drafts.has(l.key);
              return (
                <div key={l.key} className="py-2.5 flex items-start gap-4"
                     data-empty={!body.trim() ? '' : undefined}>
                  {/* Tibetan line */}
                  <div className="w-2/5 shrink-0 tibetan-text whitespace-pre-wrap leading-relaxed">
                    {l.tokens.map((t, ti) => (
                      <span key={`${l.key}-${ti}`} data-syl-id={t.id}
                            className={t.small ? (l.kind === 'skt' ? 'tib-small implicit-mantra' : 'tib-small') : undefined}
                            title={t.small && l.kind === 'skt' ? 'Small connector between mantras — implicit mantras to fill in' : undefined}>
                        {t.render}
                      </span>
                    ))}
                  </div>
                  {/* Phonetics field — with a per-line number like the translation input */}
                  <div className="flex-1 flex items-start gap-2">
                    <span className="shrink-0 pt-1.5 text-right tabular-nums select-none"
                          style={{ width: '1.6em', color: '#A28348', opacity: 0.5, fontSize: '0.7rem' }}>
                      {i + 1}
                    </span>
                    <textarea
                      value={body}
                      readOnly={!canEditPhonetics}
                      onChange={e => canEditPhonetics && setDraft(l.key, e.target.value)}
                      onBlur={() => canEditPhonetics && handleBlur(l, m)}
                      rows={1}
                      placeholder={l.kind === 'bo' ? 'phonetics…' : 'romanization…'}
                      className="flex-1 px-2 py-1 rounded-md bg-white text-sm resize-y min-h-[2rem]"
                      style={{ border: '1px solid var(--cline)' }}
                    />
                    {canEditPhonetics && (
                    <button
                      type="button"
                      onClick={() => handleGenerate(l)}
                      className="mt-0.5 px-1.5 py-1 rounded-md text-lapis hover:bg-cream transition-colors shrink-0"
                      style={{ border: '1px solid var(--cline)' }}
                      title={l.kind === 'bo'
                        ? `Generate ${style} (${boLang}) phonetics`
                        : `Generate ${sktLang} romanization`}
                    >
                      <Zap size={13} />
                    </button>
                    )}
                  </div>
                  {/* Status + reviewed */}
                  <div className="w-40 shrink-0 flex items-center justify-end gap-2">
                    {(m || dirty) && (
                      <span className={`px-1.5 rounded-full text-[11px] ${STATUS_PILL[dirty ? 'edited' : status].cls}`}>
                        {dirty ? 'unsaved' : STATUS_PILL[status].label}
                      </span>
                    )}
                    <label
                      className="flex items-center gap-1 text-[11px] text-ink-soft cursor-pointer"
                      title="Mark this line's phonetics as reviewed"
                    >
                      <input
                        type="checkbox"
                        checked={status === 'reviewed'}
                        disabled={!body.trim() || !canEditPhonetics}
                        onChange={e => toggleReviewed(l, m, e.target.checked)}
                      />
                      <Check size={12} /> ok
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
