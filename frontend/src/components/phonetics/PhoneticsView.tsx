import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Volume2, Zap, RefreshCw, Replace, Pin, Check, ChevronUp, ChevronDown,
} from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { usePhoneticsStore, phonKey } from '../../store/usePhoneticsStore';
import { useTranslationStore } from '../../store/useTranslationStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { deriveChunks, insertTitleChunks } from '../translate/chunks';
import { TreePane } from '../workspace/TreePane';
import { AutoGrowTextarea } from '../ui/AutoGrowTextarea';
import { deriveLines, kindOf, type PhoneticLine } from './lines';
import { useCan } from '../../store/usePermissions';
import {
  generateBo, generateSkt, STYLE_LANGS, defaultBoStyle, type BoStyle, type BoLang,
} from './generate';
import { applyPhoneticRules } from './rules';
import { RulesModal } from './RulesModal';
import {
  usePhoneticSettingsStore, rulesFor, styleFor,
} from '../../store/usePhoneticSettingsStore';
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
  // The sapche headings shown inline for orientation come from the SAME sources the booklet's
  // navigation outline uses: the translation chunks (their per-language label) and the sapche
  // tree (nesting depth).
  const allTrChunks = useTranslationStore(s => s.chunks);
  const allLayouts = useTranslationStore(s => s.layouts);
  const trTextId = useTranslationStore(s => s.textId);
  const collabTextId = useTranslationStore(s => s.collabTextId);
  const fetchChunks = useTranslationStore(s => s.fetchChunks);
  const fetchCollab = useTranslationStore(s => s.fetchCollab);
  // These stores hold ONE text at a time. Reading them without checking whose data it is
  // renders another text's arrangement — a compilation's ten section titles once appeared
  // under a five-line praise, because this view read `layouts` and never fetched them. A
  // mismatch means "not loaded yet", which is exactly how it should look.
  const trChunks = trTextId === currentText?.id ? allTrChunks : [];
  const layouts = collabTextId === currentText?.id ? allLayouts : [];
  const treeNodes = useTreeNodeStore(s => s.nodes);
  const fetchNodes = useTreeNodeStore(s => s.fetchNodes);
  const setSelectedTreeNodeId = useUIStore(s => s.setSelectedTreeNodeId);

  const [tab, setTab] = useState<'bo' | 'skt'>('bo');
  const [docLang, setDocLang] = useState<DocLang>('en');
  // Seeded from the built-in default for the opening language; the org's own choice arrives
  // with the settings and takes over (see the effect below).
  const [style, setStyle] = useState<BoStyle>(() => defaultBoStyle('en'));
  const [iast, setIast] = useState(false);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Set when the popup is opened from a LINE rather than the toolbar: which table governs that
  // line, and the string to try the rules on.
  const [rulesSeed, setRulesSeed] =
    useState<{ line: PhoneticLine; kind: 'bo' | 'skt'; sample: string } | null>(null);

  // The org's phonetics settings — the replacement rules applied to everything this bench
  // generates, and the style each language opens on. Fetched once: they are small, shared by
  // every text, and the popup keeps the store in step.
  // (The rule lists are read from the store AT GENERATION TIME — see `generateOne` — so this
  // view deliberately does not subscribe to them: nothing here renders from them.)
  const orgStyles = usePhoneticSettingsStore(s => s.styles);
  const settingsLoaded = usePhoneticSettingsStore(s => s.loaded);
  const fetchSettings = usePhoneticSettingsStore(s => s.fetchSettings);
  const saveStyle = usePhoneticSettingsStore(s => s.saveStyle);
  useEffect(() => { if (!settingsLoaded) void fetchSettings(); }, [settingsLoaded, fetchSettings]);

  // Each language opens on its own style — Lotsawa House carries en/fr/de, Padmakara is the
  // only one with Portuguese — so switching language switches style with it. Depending on the
  // org's map (not on `style`) leaves a style picked by hand for this session alone.
  const langStyle = styleFor(orgStyles, docLang);
  useEffect(() => { setStyle(langStyle); }, [docLang, langStyle]);

  // Structural data (language-independent) + the sapche tree and translation chunks that label
  // and nest the inline headings.
  useEffect(() => {
    if (!currentText) return;
    const id = currentText.id;
    fetchTokens(id);
    fetchSpans(id);
    fetchMarkers(id);
    fetchBreaks(id);
    fetchNodes(id);
    fetchChunks(id);
    fetchCollab(id);          // the title layouts this view renders inline
  }, [currentText, refreshNonce, fetchTokens, fetchSpans, fetchMarkers, fetchBreaks, fetchNodes,
      fetchChunks, fetchCollab]);

  // Phonetics are per-language: refetch and drop drafts on a document or language change.
  useEffect(() => {
    if (!currentText) return;
    fetchPhonetics(currentText.id, docLang);
    setDrafts(new Map());
  }, [currentText, docLang, refreshNonce, fetchPhonetics]);

  const lines = useMemo<PhoneticLine[]>(() => {
    if (!tokens.length) return [];
    const markerOffsets = new Set(markers.map(m => m.position));
    const derived = deriveLines(tokens, markerOffsets, spans, breakOverrides);

    return derived.flatMap((line) => {
      // Match inside THIS occurrence. Syllable UUIDs repeat when a source is inherited,
      // transcluded, or recited twice; a global id→position map therefore points at the
      // last occurrence and makes otherwise exact stored ranges look unrelated.
      const lineStart = line.sylIds.indexOf(line.startSylId);
      const lineEnd = line.sylIds.lastIndexOf(line.endSylId);
      if (lineStart < 0 || lineEnd < lineStart) return [line];
      const stored = rows
        .filter(r => r.kind === line.kind)
        .map(r => {
          const start = line.sylIds.indexOf(r.start_syl_id, lineStart);
          const end = start >= 0 ? line.sylIds.indexOf(r.end_syl_id, start) : -1;
          return { row: r, start, end };
        })
        .filter(x => x.start >= lineStart && x.end >= x.start && x.end <= lineEnd)
        .sort((a, b) => a.start - b.start);

      if (stored.length < 2
          || stored.some((x, i) => i > 0 && x.start <= stored[i - 1].end)) return [line];

      type Piece = { row: Phonetic | null; start: number; end: number };
      const pieces: Piece[] = [];
      let cursor = lineStart;
      for (const item of stored) {
        // Keep any Tibetan not covered by imported phonetics visible as its own empty row.
        if (item.start > cursor) pieces.push({ row: null, start: cursor, end: item.start - 1 });
        pieces.push(item);
        cursor = item.end + 1;
      }
      if (cursor <= lineEnd) pieces.push({ row: null, start: cursor, end: lineEnd });

      return pieces.map(({ row, start, end }, pieceIndex) => {
        const partTokens = line.tokens.slice(start, end + 1);
        const startSylId = row?.start_syl_id ?? line.sylIds[start];
        const endSylId = row?.end_syl_id ?? line.sylIds[end];
        const sourceToken = tokens.find(t => t.id === startSylId
          && t.start_offset >= line.startOffset);
        return {
          ...line,
          key: `${line.key}:${row ? `phonetic-${row.id}` : `remainder-${pieceIndex}`}`,
          startSylId,
          endSylId,
          startOffset: sourceToken?.start_offset ?? line.startOffset,
          sylIds: line.sylIds.slice(start, end + 1),
          tokens: partTokens,
          text: partTokens.map(t => t.render).join('').trim(),
        };
      });
    });
  }, [tokens, markers, spans, breakOverrides, rows]);

  /** Syllables this text TRANSCLUDES from another text, keyed by occurrence — the same
   *  source may be transcluded twice, and `(id, opId)` is what names the occurrence.
   *  `source` distinguishes a transclusion from a parent link: a recitation extract's
   *  syllables are its parent's and its phonetics rightly anchor there, but they are this
   *  text's own content, not borrowed from a second text. */
  const transcludedIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of tokens) {
      if (t.source === 'transclusion') s.add(`${t.id}:${t.op_id ?? ''}`);
    }
    return s;
  }, [tokens]);

  /** A line comes from a transcluded text when any of its syllables does. A transcluded run
   *  is contiguous, so this is a whole-line property in practice. */
  const isTranscluded = (l: PhoneticLine) =>
    transcludedIds.size > 0
    && l.tokens.some(t => transcludedIds.has(`${t.id}:${t.opId ?? ''}`));

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

  // ── Inline sapche headings (orientation) ──
  // A heading's label in the current edit language, matched by syllable range (like the booklet
  // nav outline). HTML body → plain text for a compact heading.
  const stripHtml = (html: string) =>
    (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim();
  const transByRange = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of trChunks) {
      const t = c.translations.find(x => x.lang === docLang);
      if (t?.body) m.set(`${c.start_syl_id}-${c.end_syl_id}`, t.body);
    }
    return m;
  }, [trChunks, docLang]);
  // Sapche outline depth per anchor syllable (mirrors compile.ts): a tree node's segment_start
  // offset → the syllable there → its ancestor count.
  const depthBySyl = useMemo(() => {
    const byId = new Map(treeNodes.map(n => [n.id, n]));
    const depthOf = (n: typeof treeNodes[number]): number => {
      let d = 0, cur: typeof n | undefined = n, guard = 0;
      while (cur && cur.parent_id != null && guard++ < 64) { cur = byId.get(cur.parent_id); if (cur) d++; }
      return d;
    };
    const sylAtOffset = new Map<number, string>();
    for (const t of tokens) if (t.text.trim() !== '') sylAtOffset.set(t.start_offset, t.id);
    const m = new Map<string, number>();
    for (const n of treeNodes) {
      if (n.segment_start == null) continue;
      const syl = sylAtOffset.get(n.segment_start);
      if (!syl) continue;
      const d = depthOf(n);
      const prev = m.get(syl);
      if (prev == null || d < prev) m.set(syl, d);
    }
    return m;
  }, [treeNodes, tokens]);
  // A manually-set heading level (H1-based) where the tree supplies no depth.
  const levelBySyl = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of trChunks) if (c.level != null) m.set(c.start_syl_id, c.level);
    return m;
  }, [trChunks]);
  /** Small-INSTRUCTIONS runs the editor promoted to headings (`render_as: 'heading'`). They
   *  print as section titles, so this bench must show them as landmarks too — and NOT as
   *  recited lines, which is what they would otherwise be. */
  const promotedSyls = useMemo(() => {
    const s2 = new Set<string>();
    for (const c of trChunks) if (c.render_as === 'heading') s2.add(c.start_syl_id);
    return s2;
  }, [trChunks]);

  // The tab's rows, with the sapche/title headings folded IN at their stream positions: the
  // same full unit stream `deriveLines` walks, but keeping the heading units (not just the
  // recited lines) so an editor can see where they are. Headings are read-only landmarks; each
  // recited line keeps a 1-based number of its own (`n`).
  // `offset` = the row's raw start offset (its first token's), so the shared sapche machinery
  // (scroll-spy + click-to-jump, keyed on `[data-link-key]`) can locate it. Translation-only
  // title headings have no token/offset, so they don't participate in the spy (null).
  type Row =
    | { kind: 'heading'; key: string; label: string; depth: number; offset: number | null }
    | { kind: 'line'; line: PhoneticLine; n: number; offset: number };
  const rendered = useMemo<Row[]>(() => {
    if (!tokens.length) return [];
    const markerOffsets = new Set(markers.map(m => m.position));
    // With the translation-only title layouts spliced in (same as the booklet compile), so they
    // show inline among the sapche headings — in the current edit language.
    const units = insertTitleChunks(
      deriveChunks(tokens, markerOffsets, spans, breakOverrides,
        { verse: true, sapche: true, mantra: true }, undefined, /* lineLevel */ true),
      layouts);
    const out: Row[] = [];
    let n = 0;
    for (const u of units) {
      if (u.titleLayout) {
        // Translation-only title — docLang label only (no Tibetan to fall back to); skip when
        // this edition hasn't translated it, to keep the working view uncluttered.
        const raw = u.titleLayout.titles[docLang];
        const label = raw ? stripHtml(raw) : '';
        if (!label) continue;
        out.push({ kind: 'heading', key: u.key, label, depth: Math.max(0, (u.titleLayout.level ?? 1) - 1), offset: null });
      } else if (u.tagType === 'sapche' || u.tagType === 'title'
                 || (u.tagType === 'small' && promotedSyls.has(u.startSylId))) {
        const raw = transByRange.get(`${u.startSylId}-${u.endSylId}`);
        const label = (raw ? stripHtml(raw) : '') || u.text.trim();
        const depth = depthBySyl.get(u.startSylId)
          ?? (levelBySyl.has(u.startSylId) ? levelBySyl.get(u.startSylId)! - 1 : 0);
        out.push({ kind: 'heading', key: u.key, label, depth: Math.max(0, depth), offset: u.startOffset });
      } else {
        const k = kindOf(u.tagType);
        if (k === tab && u.startSylId) out.push({ kind: 'line', line: { ...u, kind: k }, n: ++n, offset: u.startOffset });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, markers, spans, breakOverrides, tab, transByRange, depthBySyl, levelBySyl,
      promotedSyls, layouts, docLang]);

  const shown = useMemo(
    () => rendered.filter((r): r is Extract<Row, { kind: 'line' }> => r.kind === 'line').map(r => r.line),
    [rendered]);

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

  // ── Sapche scroll-spy (the sidebar follows the list) ──
  // Same mechanism as the translate bench: an IntersectionObserver tracks which rows are in
  // view; on scroll, the top-most one resolves to its owning sapche section and selects it.
  // `TreePane` owns bringing that section into view (see its follow effect).
  const linkedNodes = useMemo(
    () => treeNodes.filter(n => n.segment_start != null)
      .sort((a, b) => a.segment_start! - b.segment_start!),
    [treeNodes]);
  const spyNodeId = useRef<number | null>(null);
  const spyRaf = useRef<number | null>(null);
  // Geometry, not an IntersectionObserver: the topmost row still crossing the list's top edge
  // owns the viewport. (An IO here silently never populated — rows read as never-intersecting —
  // so the sidebar never followed. Measuring rects on scroll is simpler and actually fires.)
  const onListScroll = () => {
    if (spyRaf.current != null) return;
    spyRaf.current = requestAnimationFrame(() => {
      spyRaf.current = null;
      const list = listRef.current;
      if (!list || linkedNodes.length === 0) return;
      const lr = list.getBoundingClientRect();
      let curOffset: number | null = null;
      for (const el of list.querySelectorAll<HTMLElement>('[data-link-key]')) {
        if (el.getBoundingClientRect().bottom > lr.top + 1) { curOffset = Number(el.dataset.linkKey); break; }
      }
      if (curOffset == null) return;
      let node: (typeof linkedNodes)[number] | null = null;
      for (const nd of linkedNodes) { if (nd.segment_start! <= curOffset) node = nd; else break; }
      if (!node || node.id === spyNodeId.current) return;
      spyNodeId.current = node.id;
      setSelectedTreeNodeId(node.id);
    });
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

  /** Generate one line, then run the org's replacements over it — the single point every
   *  button here goes through, so what is stored already carries the house spellings (the
   *  booklet and the PDF print stored bodies). Rules are keyed by the BOOKLET language, not
   *  by the generation dialect: Padmakara has no German, so `boLang` falls back to English
   *  and the German fixes are exactly what the rules are for. IAST is exempt — that mode is
   *  the scholarly form, not a language flavour. */
  const rawOne = (l: PhoneticLine) =>
    l.kind === 'bo' ? generateBo(l.text, style, boLang) : generateSkt(l.text, sktLang);

  const generateOne = (l: PhoneticLine) => {
    const raw = rawOne(l);
    if (l.kind === 'skt' && iast) return raw;
    // Read the rules from the store rather than this render's copy: generation only ever runs
    // from an event handler, and one of those fires right after the popup saves — where the
    // render still holds the list as it was BEFORE the edit.
    const lists = usePhoneticSettingsStore.getState().lists;
    return applyPhoneticRules(raw, rulesFor(lists, l.kind, docLang));
  };

  /** Open the replacements on the list that governs THIS line, with the line in the try-it
   *  box. The sample is the RAW engine output — what the rules are handed — so the box
   *  reproduces exactly what generation did to this line, and a rule can be tried against it
   *  without touching any data. A line whose engine gives nothing falls back to what it
   *  currently reads. */
  const openRulesFor = (l: PhoneticLine) => {
    setRulesSeed({ line: l, kind: l.kind, sample: rawOne(l) || bodyOf(l, matchFor(l)) });
    setRulesOpen(true);
  };

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

  /** Regenerate every line on this tab, REPLACING what is there — except the transcluded
   *  ones. Unlike "generate all empty" this discards existing wording, including reviewed
   *  lines, so it asks first. */
  const handleRegenerateAll = () => {
    const mine: PhoneticLine[] = [];
    let borrowed = 0;
    for (const l of shown) {
      if (isTranscluded(l)) borrowed += 1; else mine.push(l);
    }
    if (!mine.length) {
      setError(borrowed ? 'Every line here comes from a transcluded text — nothing to regenerate.'
                        : 'Nothing to regenerate on this tab.');
      return;
    }
    const kept = borrowed
      ? ` ${borrowed} line${borrowed === 1 ? '' : 's'} from transcluded texts ${
          borrowed === 1 ? 'is' : 'are'} left untouched.`
      : '';
    if (!confirm(
      `Regenerate phonetics for ${mine.length} line${mine.length === 1 ? '' : 's'}? `
      + `Any wording already there — including reviewed lines — is replaced.${kept}`)) return;
    for (const l of mine) {
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
          <div className="flex items-center gap-1.5">
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
            {/* The style a language OPENS on, for the whole organization. Offered only when
                the current pick differs from it — otherwise there is nothing to set. */}
            {canEditPhonetics && style !== langStyle && (
              <button
                type="button"
                onClick={() => void saveStyle(docLang, style)
                  .catch((e: any) => setError(e.message || 'Could not save the default style'))}
                className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream transition-colors"
                style={{ border: '1px solid var(--cline)' }}
                title={`Open ${LANG_NAME[docLang]} on ${style} from now on, for everyone in the organization`}
              >
                <Pin size={12} /> default for {LANG_NAME[docLang]}
              </button>
            )}
          </div>
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

        {canEditPhonetics && (
        <button
          type="button"
          onClick={handleRegenerateAll}
          className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream transition-colors"
          style={{ border: '1px solid var(--cline)' }}
          title="Regenerate every line on this tab, replacing what is there — except lines that come from transcluded texts"
        >
          <RefreshCw size={12} /> regenerate all
        </button>
        )}

        {canEditPhonetics && (
        <button
          type="button"
          onClick={() => setRulesOpen(true)}
          className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream transition-colors"
          style={{ border: '1px solid var(--cline)' }}
          title="The replacements applied to every generated line, in order — per language"
        >
          <Replace size={12} /> replacements
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

      {/* Body: sapche sidebar (orientation + click-to-jump) + the phonetics rows */}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-80 shrink-0 h-full overflow-hidden"
             style={{ borderRight: '1px solid var(--cline)' }}>
          <TreePane forceConsult />
        </div>
        <div ref={listRef} onScroll={onListScroll} className="flex-1 overflow-auto px-5 py-3">
        {shown.length === 0 ? (
          <div className="text-ink-soft text-sm py-8 text-center">
            No {tab === 'bo' ? 'Tibetan verse/prose' : 'Sanskrit mantra'} lines in this document.
          </div>
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--cline)' }}>
            {rendered.map((item) => {
              // A sapche section heading, folded in for orientation: read-only, in the current
              // edit language (Tibetan where untranslated), indented by its outline depth. Titles
              // are edited in the Translate bench, not here.
              if (item.kind === 'heading') {
                return (
                  <div key={item.key} className="py-1.5 select-none"
                       data-link-key={item.offset ?? undefined}
                       style={{ paddingLeft: `${item.depth * 1.5}rem` }}>
                    <div className="text-sm font-semibold text-lapis/80 tracking-wide"
                         title="Sapche section (edit the title in the Translate bench)">
                      {item.label || '—'}
                    </div>
                  </div>
                );
              }
              const l = item.line;
              const m = matchFor(l);
              const body = bodyOf(l, m);
              const status = m?.status ?? 'auto';
              const dirty = drafts.has(l.key);
              return (
                <div key={l.key} className="py-2.5 flex items-start gap-4"
                     data-link-key={item.offset}
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
                      {item.n}
                    </span>
                    <AutoGrowTextarea
                      value={body}
                      readOnly={!canEditPhonetics}
                      onChange={e => canEditPhonetics && setDraft(l.key, e.target.value)}
                      onBlur={() => canEditPhonetics && handleBlur(l, m)}
                      rows={1}
                      placeholder={l.kind === 'bo' ? 'phonetics…' : 'romanization…'}
                      className="flex-1 px-2 py-1 rounded-md bg-white text-sm resize-none overflow-hidden min-h-[2rem]"
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
                    {canEditPhonetics && (
                    <button
                      type="button"
                      onClick={() => openRulesFor(l)}
                      className="mt-0.5 px-1.5 py-1 rounded-md text-lapis hover:bg-cream transition-colors shrink-0"
                      style={{ border: '1px solid var(--cline)' }}
                      title="Open the replacements with THIS line in the try-it box, as the rules receive it"
                    >
                      <Replace size={13} />
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

      {rulesOpen && (
        <RulesModal
          kind={rulesSeed?.kind ?? tab}
          lang={docLang}
          sample={rulesSeed?.sample}
          // Saving a list from a LINE re-applies it to that line at once: the rules were
          // opened to fix THAT string, so leaving it reading the old text would make the save
          // look like it had done nothing. Same path as the row's own generate button.
          onSaved={rulesSeed ? () => handleGenerate(rulesSeed.line) : undefined}
          langs={DOC_LANGS}
          langName={(l) => LANG_NAME[l as DocLang] ?? l}
          onClose={() => { setRulesOpen(false); setRulesSeed(null); }}
        />
      )}
    </div>
  );
};
