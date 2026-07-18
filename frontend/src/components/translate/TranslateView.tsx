import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Check, GitBranch, Undo2, ArrowUpToLine, MoveRight, Plus, Trash2, Link, ChevronUp, ChevronDown } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useUIStore } from '../../store/useUIStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore, rangeKey, ovKey } from '../../store/useTranslationStore';
import { TreePane } from '../workspace/TreePane';
import { deriveChunks, moveDisplays, applyMoveDisplays, insertTitleChunks, insertPassageChunks, type DerivedChunk } from './chunks';
import { usePassageStore } from '../../store/usePassageStore';
import { readTokenSelection } from '../workspace/segments';
import { ChunkEditor } from './ChunkEditor';
import { sanitizeTranslationHtml } from './sanitize';
import { splitParagraphs } from '../documents/compile';
import { useCan } from '../../store/usePermissions';
import type { TranslationChunk } from '../../api/client';

/** Group a chunk's tokens into printed lines (a token whose render carries a
 *  newline ends its line), so each line can be numbered — matching the Tibetan
 *  line count the paginator pairs 1:1 with the translation's paragraphs. */
type RenderToken = { id: string; render: string; small?: boolean; movedAway?: number; movedIn?: number };
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

/** Upper bound for a manually-set heading level (deeply nested outlines can go far). */
const MAX_LEVEL = 99;

/** A compact −/+ stepper for a heading level, so outlines can nest arbitrarily deep
 *  (H1…H99) instead of a fixed row of buttons. `allowClear` lets − at H1 drop to no
 *  level (null); without it the floor is H1 (used for translation-only titles, which
 *  are always headings). */
const LevelStepper: React.FC<{
  level: number | null;
  onSet: (lv: number | null) => void;
  miniStyle: React.CSSProperties;
  allowClear?: boolean;
  title?: string;
}> = ({ level, onSet, miniStyle, allowClear, title }) => {
  const dec = () => {
    if (level == null) return;
    if (level <= 1) { if (allowClear) onSet(null); return; }
    onSet(level - 1);
  };
  const inc = () => onSet(Math.min(MAX_LEVEL, (level ?? 0) + 1));
  const btn = "px-1 rounded font-mono text-ink-soft hover:bg-cream disabled:opacity-30";
  return (
    <span className="flex items-center gap-0.5" title={title}>
      <button type="button" onClick={dec} disabled={level == null} className={btn} style={miniStyle}>−</button>
      <span className="px-1 rounded font-mono bg-lapis text-cream-hi text-center" style={{ ...miniStyle, minWidth: '1.9rem' }}>
        {level == null ? 'H–' : `H${level}`}
      </span>
      <button type="button" onClick={inc} className={btn} style={miniStyle}>+</button>
    </span>
  );
};

/**
 * Translator bench. Phase T1: chunked Tibetan + canonical per-chunk translations
 * (ripple everywhere). Phase T2: booklet-local overrides with staleness tracking,
 * update notifications (seen watermarks), suggest-upstream with accept/reject, and
 * the scramble layer — moving small/sapche instruction chunks and inserting
 * synthetic title chunks (global default or booklet-only).
 */
export const TranslateView: React.FC = () => {
  const { currentText } = useTextStore();
  // Permission-read on Translate: chunk boxes stay static (ChunkEditor gates
  // itself) and the layout/override/title gestures below hide behind this.
  const canEditTranslate = useCan('translate').canModify;
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
  const updateNode = useTreeNodeStore(s => s.updateNode);
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
    srcStart: string; srcEnd: string; bookletOnly: boolean; langOnly: boolean; label: string;
  } | null>(null);
  /** Insertion caret while placing INSIDE a chunk (hairline mechanism). */
  const [hairline, setHairline] = useState<{
    left: number; top: number; height: number; sylId: string; side: 'before' | 'after';
  } | null>(null);
  /** Passage-starter id whose "link to TOC node" picker is open (null = none). */
  const [linkPickerFor, setLinkPickerFor] = useState<number | null>(null);
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

  // Sapche outline depth per anchor syllable (0 = top-level), mirroring the booklet's
  // `compile.ts` derivation: a heading whose start syllable IS a tree node's segment
  // start inherits its level from the Tibetan outline (read-only). Headings absent from
  // the outline (and translation-only titles) keep a manually definable level.
  const sapcheDepthBySyl = useMemo(() => {
    const byId = new Map<number, typeof treeNodes[number]>(treeNodes.map(n => [n.id, n]));
    const depthOf = (n: typeof treeNodes[number]) => {
      let d = 0, cur: typeof n | undefined = n, guard = 0;
      while (cur?.parent_id != null && guard++ < 64) { cur = byId.get(cur.parent_id); if (!cur) break; d++; }
      return d;
    };
    const sylAtOffset = new Map<number, string>();
    for (const t of tokens) if (t.text.trim() !== '') sylAtOffset.set(t.start_offset, t.id);
    const m = new Map<string, number>();
    for (const n of treeNodes) {
      if (n.segment_start == null) continue;
      const syl = sylAtOffset.get(n.segment_start); if (!syl) continue;
      const d = depthOf(n);
      const prev = m.get(syl);
      if (prev == null || d < prev) m.set(syl, d);
    }
    return m;
  }, [treeNodes, tokens]);
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

  /** Walk the rows matching `selector` (a progress badge — `data-copy`, `data-untranslated`),
   *  relative to whatever is on screen now: down = the first one below the viewport's midline,
   *  up = the last one above it, wrapping at the ends. Midline, not top edge, because the jump
   *  centres its target — a top-edge comparison would find the row it just centred and stick.
   *
   *  A click during the previous jump's smooth scroll would measure MID-FLIGHT geometry and
   *  re-find the very row already being scrolled to — rapid clicking would feel stuck. So for
   *  a moment after a jump the walk advances from the remembered target instead; after that,
   *  geometry (which by then means the settled viewport) takes over again. Each walk keeps its
   *  own `nav` cursor so the two pills do not fight over one remembered target. */
  type WalkNav = { el: HTMLElement | null; at: number; pulse: number };
  const trimNav = useRef<WalkNav>({ el: null, at: 0, pulse: 0 });
  const untransNav = useRef<WalkNav>({ el: null, at: 0, pulse: 0 });
  // Where in the run the walk currently sits (1-based), so the pill can read "12/55" — the
  // user asked to see where they are. 0 = not walking; it resets to 0 whenever the underlying
  // count changes (an edit shifts every index, so the old position is meaningless).
  const [trimPos, setTrimPos] = useState(0);
  const [untransPos, setUntransPos] = useState(0);
  const walkRows = (
    selector: string, navRef: React.MutableRefObject<WalkNav>, dir: 1 | -1,
    setPos: (n: number) => void,
  ) => {
    const list = listRef.current;
    if (!list) return;
    const els = [...list.querySelectorAll<HTMLElement>(selector)];
    if (!els.length) { setPos(0); return; }
    const nav = navRef.current;
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
    setPos(els.indexOf(target) + 1);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // One pulse at a time: a stale timer from the previous jump must not cut this one short.
    window.clearTimeout(nav.pulse);
    els.forEach(el => el.classList.remove('link-pulse'));
    target.classList.add('link-pulse');
    nav.pulse = window.setTimeout(() => target.classList.remove('link-pulse'), 1300);
  };
  const gotoCopy = (dir: 1 | -1) => walkRows('[data-copy]', trimNav, dir, setTrimPos);
  const gotoUntranslated = (dir: 1 | -1) => walkRows('[data-untranslated]', untransNav, dir, setUntransPos);

  // Esc cancels an armed placement or a pending selection button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setArmedMove(null);
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

  // The translator's units: the Tibetan stream is chunked NATURALLY (moves never
  // rearrange it — they are translate-tab display only), then move displays gray the
  // moved-away tokens in place and inject a read-only copy at the destination, and the
  // synthetic TITLE/PASSAGE chunks are spliced in.
  const { chunks, streamIds } = useMemo(() => {
    if (!tokens.length) return { chunks: [], streamIds: [] as string[] };
    const markerOffsets = new Set(markers.map(m => m.position));
    const derived = deriveChunks(tokens, markerOffsets, spans, breakOverrides, lineBreakGroups);
    // Moves resolve PER EDITION: a language-specific relocation overrides the shared one for
    // this `targetLang` only (see `moveDisplays`), so switching the edition re-arranges.
    const { movedAway, placements } = moveDisplays(tokens, layouts, targetLang);
    const moved = applyMoveDisplays(derived, movedAway, placements);
    return {
      chunks: insertPassageChunks(
        insertTitleChunks(moved, layouts), passages,
        tokens, markerOffsets, spans, breakOverrides, lineBreakGroups),
      streamIds: tokens.map(t => t.id),
    };
  }, [tokens, markers, spans, breakOverrides, lineBreakGroups, layouts, passages, targetLang]);

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

  // A passage block can emit several rows (one per same-type unit-group), all sharing the
  // group's STARTER (`u.passage`). The "link to TOC node" affordance belongs on the first
  // of the sequence, so remember each starter's first row index.
  const firstPassageRow = useMemo(() => {
    const m = new Map<number, number>();
    displayRows.forEach((row, i) => {
      const pid = row.u.passage?.id;
      if (pid != null && !m.has(pid)) m.set(pid, i);
    });
    return m;
  }, [displayRows]);

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
  // The translation text a row would SHOW — mirrors the render's `effectiveBody` (override,
  // then the unit's own, then a copy from a wider unit). A copy is a non-empty body, so it is
  // NOT counted as untranslated: those pre-fills wear the separate "to trim" nav.
  const rowBody = (row: DisplayRow): string => {
    const existing = translationOf(row.match, targetLang)?.body;
    const ov = overrideFor(row.match?.id, targetLang)?.body;
    const copied = !existing && !ov ? translationOf(row.cover, targetLang)?.body : undefined;
    return ov ?? existing ?? copied ?? '';
  };
  // A body line still needing translation: a real content unit whose translation input is
  // empty for the target language. Excludes the rows that render in their own (non-regular)
  // branches and carry no translation input — synthetic titles (own field), passages (text
  // retrieved from their source line, itself counted), a move-emptied origin (its content was
  // relocated), and MANTRA runs (Sanskrit kept as-is — its recitation is done in the phonetics
  // bench, not translated here).
  const needsTranslation = (row: DisplayRow): boolean =>
    !!row.u.startSylId && !row.u.titleLayout && !row.u.passage && row.u.movedOutAll == null
    && row.u.tagType !== 'mantra' && !rowBody(row).trim();

  // Notification counts for the strip.
  const counts = useMemo(() => {
    let updates = 0, stale = 0, copies = 0, untranslated = 0;
    for (const row of displayRows) {
      const unitBody = translationOf(row.match, targetLang)?.body;
      if (!unitBody && translationOf(row.cover, targetLang)?.body && row.u.tagType !== 'mantra') copies++;
      if (updateAvailable(row.match, targetLang)) updates++;
      if (staleOverride(row.match, targetLang)) stale++;
      if (needsTranslation(row)) untranslated++;
    }
    return { updates, stale, copies, untranslated, pending: suggestions.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRows, overrides, seen, suggestions, targetLang]);

  // A walk position only means something against the run it was taken in — an edit (or a
  // language switch) that changes the count shifts every index, so drop the "12/55" readout
  // back to the bare total until the next chevron.
  useEffect(() => { setUntransPos(0); }, [counts.untranslated]);
  useEffect(() => { setTrimPos(0); }, [counts.copies]);

  if (!currentText) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        No text selected. Pick one from the Texts tab.
      </div>
    );
  }

  // What can be PICKED UP: an instruction run (small/sapche). What can RECEIVE a hairline:
  // any translated chunk — the fragment is integrated into its text — but never a mantra
  // (never translated, so a fragment dropped there would fall out of translation scope).
  const movable = (u: DerivedChunk) => u.tagType === 'small' || u.tagType === 'sapche';
  const droppable = (u: DerivedChunk) => u.tagType !== 'mantra';

  /** A syllable-snapped selection inside a movable chunk PICKS IT UP immediately (arms the
   *  move) — no intermediate button. The armed-move banner then invites clicking a spot in a
   *  chunk (hairline: integrate it there) or a bar between chunks (relocate it as its own
   *  segment); Esc/Cancel aborts. A collapsed selection (a plain click) is a no-op. Snapping
   *  is the Workspace's readTokenSelection. */
  const handleChunkMouseUp = (e: React.MouseEvent) => {
    const container = e.currentTarget as HTMLElement;
    const sel = readTokenSelection(container);
    if (!sel) return;
    const text = window.getSelection()?.toString() ?? '';
    setArmedMove({
      srcStart: sel.startSylId, srcEnd: sel.endSylId,
      bookletOnly: false, langOnly: false,
      label: text.slice(0, 24) + (text.length > 24 ? '…' : ''),
    });
    window.getSelection()?.removeAllRanges();
  };

  /** A destination that falls INSIDE the run being moved would copy the run into itself — a
   *  degenerate move with no visible destination and (origin == target) no removal badge. It
   *  is rejected at every placement touch-point. */
  const anchorInSource = (anchorId: string | null) => {
    if (!armedMove || anchorId == null) return false;
    const a = posById.get(anchorId), s = posById.get(armedMove.srcStart), e = posById.get(armedMove.srcEnd);
    return a != null && s != null && e != null && a >= s && a <= e;
  };

  /** Hairline caret while a move is armed: snaps before/after the hovered syllable
   *  (by pointer half), positioned inside the scrollable chunk list. */
  const handlePlacementMove = (e: React.MouseEvent) => {
    if (!armedMove) return;
    const el = (e.target as HTMLElement).closest('[data-syl-id]') as HTMLElement | null;
    const list = listRef.current;
    if (!el || !el.dataset.sylId || !list) { setHairline(null); return; }
    // No caret inside the run being moved — you can't drop a run into itself.
    if (anchorInSource(el.dataset.sylId)) { setHairline(null); return; }
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

  /** Clicking the hairline INTEGRATES the fragment inside the hovered chunk, at the caret:
   *  the anchor is the hovered syllable itself plus the side, so "the very end of this chunk"
   *  is stored as *after its last syllable* — never as "before the next chunk's first", which
   *  is what the bar between chunks means. */
  const handlePlacementClick = () => {
    if (!armedMove || !hairline) return;
    if (anchorInSource(hairline.sylId)) {
      setSaveError("A run can't be moved into itself.");
      return;
    }
    const m = armedMove;
    setArmedMove(null);
    setHairline(null);
    void addMove({
      textId: m.bookletOnly ? currentText!.id : null,
      lang: m.langOnly ? targetLang : null,
      srcStart: m.srcStart, srcEnd: m.srcEnd,
      anchor: hairline.sylId, mode: 'inline', anchorAfter: hairline.side === 'after',
    }).catch((e: any) => setSaveError(e.message || 'Move failed'));
  };

  // A relocation scoped to one edition wears a note, so a move that behaves differently per
  // language is legible on hover (the layout id rides each moved token as `movedIn`/`movedAway`).
  const moveLangHint = (layoutId?: number) => {
    const ly = layoutId != null ? layouts.find(x => x.id === layoutId) : undefined;
    return ly?.lang ? ` (${ly.lang.toUpperCase()} only)` : '';
  };
  const tibetanTokens = (u: DerivedChunk, interactive = true) => {
    const lines = tibetanLines(u.tokens);
    let ti = -1; // running token index across lines, preserved for move selection
    const pick = interactive && movable(u);
    const drop = interactive && droppable(u);
    return (
      <div
        className={`tibetan-text ${u.tagType === 'mantra' ? 'opacity-40' : ''} ${
          armedMove && drop ? 'cursor-crosshair' : ''}`}
        onMouseUp={!armedMove && pick ? handleChunkMouseUp : undefined}
        onMouseMove={armedMove && drop ? handlePlacementMove : undefined}
        onClick={armedMove && drop ? handlePlacementClick : undefined}
      >
        {lines.map((line, li) => (
          <div key={`${u.key}-l${li}`} className="tibetan-line">
            <span className="tibetan-line-no" contentEditable={false}>{li + 1}</span>
            <span className="tibetan-line-text">
              {line.map((t, k) => {
                const keyBase = `${u.key}-${li}-${k}`;
                // A READ-ONLY copy injected at a move destination: no data-syl-id (its real
                // id lives at the origin), excluded from selection, shown integrated.
                if (t.movedIn != null) {
                  return (
                    <span key={keyBase} className="moved-in-syl"
                          title={`Moved here from elsewhere for translation${moveLangHint(t.movedIn)}`}>
                      {t.render.replace(/\n/g, '')}
                    </span>
                  );
                }
                ti += 1;
                const away = t.movedAway != null;
                return (
                  <span
                    key={keyBase}
                    data-syl-id={t.id}
                    data-ro={ti}
                    data-reo={ti + 1}
                    className={[away ? 'moved-away-syl' : '',
                                t.small ? (u.tagType === 'mantra' ? 'tib-small implicit-mantra' : 'tib-small') : '']
                                .filter(Boolean).join(' ') || undefined}
                    title={away ? `Picked up — its translation is integrated at its new place${moveLangHint(t.movedAway)}`
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

  /** Thin placement bar shown while a move is armed; also carries "+ title". Clicking it
   *  RELOCATES the fragment: it stands as its own segment here, with its own translation
   *  (the hairline, by contrast, integrates it into a chunk's text). */
  const placeBar = (anchor: string | null, key: string) => (
    <div key={key} className="flex items-center gap-2 -my-1.5 h-4 group">
      {!canEditTranslate ? null : armedMove ? (
        <button
          type="button"
          onClick={() => {
            if (anchorInSource(anchor)) {
              setSaveError("A run can't be moved into itself.");
              return;
            }
            const m = armedMove;
            setArmedMove(null);
            setHairline(null);
            void addMove({
              textId: m.bookletOnly ? currentText.id : null,
              lang: m.langOnly ? targetLang : null,
              srcStart: m.srcStart, srcEnd: m.srcEnd, anchor, mode: 'segment',
            }).catch((e: any) => setSaveError(e.message || 'Move failed'));
          }}
          className="flex-1 h-2 rounded-full bg-lapis/30 hover:bg-lapis transition-colors"
          title="Relocate the instruction here as its own segment"
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
        {(counts.updates > 0 || counts.stale > 0 || counts.pending > 0 || counts.copies > 0
          || counts.untranslated > 0) && (
          <span className="flex items-center gap-2">
            {counts.untranslated > 0 && (
              <span className="flex items-center gap-0.5">
                <span className="px-1.5 rounded-full bg-vermilion/10 text-vermilion"
                      title={`${counts.untranslated} line${counts.untranslated === 1 ? '' : 's'} still have no ${targetLang} translation`
                        + (untransPos ? ` — you are on ${untransPos} of ${counts.untranslated}` : '')}>
                  {untransPos ? `${untransPos}/${counts.untranslated}` : counts.untranslated} to translate
                </span>
                <button type="button" onClick={() => gotoUntranslated(-1)}
                        className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                        style={{ border: '1px solid var(--cline)' }}
                        title="Previous untranslated line">
                  <ChevronUp size={11} />
                </button>
                <button type="button" onClick={() => gotoUntranslated(1)}
                        className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                        style={{ border: '1px solid var(--cline)' }}
                        title="Next untranslated line">
                  <ChevronDown size={11} />
                </button>
              </span>
            )}
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
              <span className="flex items-center gap-0.5">
                <span className="px-1.5 rounded-full bg-cream text-ink-soft"
                      title={'Units pre-filled with a copy of a wider unit’s translation — trim each to fit'
                        + (trimPos ? ` — you are on ${trimPos} of ${counts.copies}` : '')}>
                  {trimPos ? `${trimPos}/${counts.copies}` : counts.copies} to trim
                </span>
                <button type="button" onClick={() => gotoCopy(-1)}
                        className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                        style={{ border: '1px solid var(--cline)' }}
                        title="Previous unit to trim">
                  <ChevronUp size={11} />
                </button>
                <button type="button" onClick={() => gotoCopy(1)}
                        className="px-1 py-0.5 rounded-md hover:bg-cream leading-none"
                        style={{ border: '1px solid var(--cline)' }}
                        title="Next unit to trim">
                  <ChevronDown size={11} />
                </button>
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
          <span>Placing <span className="tibetan-text-sm">{armedMove.label}</span> — click INSIDE a chunk to integrate it there (hairline), or a bar between chunks to relocate it as its own segment (Esc to cancel).</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={armedMove.bookletOnly}
              onChange={e => setArmedMove({ ...armedMove, bookletOnly: e.target.checked })}
            />
            this booklet only
          </label>
          <label className="flex items-center gap-1 cursor-pointer"
                 title={`Relocate this run in ${targetLang.toUpperCase()} only — the other editions keep the shared arrangement.`}>
            <input
              type="checkbox"
              checked={armedMove.langOnly}
              onChange={e => setArmedMove({ ...armedMove, langOnly: e.target.checked })}
            />
            {targetLang} only
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
                // Only the FIRST row of a passage sequence carries the TOC-node link (the
                // link lives on the group starter, `p`). A free tree node (unlinked to a
                // segment or another passage) can be attached; attaching sets node.passage_id.
                const isFirstRow = firstPassageRow.get(p.id) === i;
                const linkedNode = treeNodes.find(n => n.passage_id === p.id);
                const linkCandidates = treeNodes
                  .filter(n => !n.inherited && n.segment_start == null && n.passage_id == null)
                  .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                const header = (
                  <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft">
                    <span className="px-1.5 rounded-full font-medium bg-cream">passage · repeated</span>
                    {jump && (
                      <button type="button" onClick={goOrigin} className={`${miniBtn} text-lapis`}
                              style={miniStyle} title="Scroll to the original occurrence">
                        <MoveRight size={10} /> go to original
                      </button>
                    )}
                    {isFirstRow && (linkedNode ? (
                      <button type="button"
                        onClick={() => void updateNode(linkedNode.id, { passage_id: null })
                          .catch((e: any) => setSaveError(e.message || 'Unlink failed'))}
                        className={`${miniBtn} text-lapis`} style={miniStyle}
                        title={`Unlink this passage from TOC node “${linkedNode.title || `#${linkedNode.id}`}”`}>
                        <Link size={10} /> TOC: {linkedNode.title || `#${linkedNode.id}`}
                      </button>
                    ) : (
                      <span className="relative">
                        <button type="button"
                          onClick={() => setLinkPickerFor(linkPickerFor === p.id ? null : p.id)}
                          className={`${miniBtn} hover:text-lapis`} style={miniStyle}
                          title="Link this passage to a node in the table of contents (sapche outline)">
                          <Link size={10} /> link to TOC…
                        </button>
                        {linkPickerFor === p.id && (
                          <div className="absolute z-30 mt-1 left-0 min-w-[10rem] max-h-56 overflow-auto rounded-md bg-white shadow-lg py-1"
                               style={miniStyle}>
                            {linkCandidates.length === 0 ? (
                              <div className="px-2 py-1 italic text-ink-soft">No free TOC nodes</div>
                            ) : linkCandidates.map(n => (
                              <button key={n.id} type="button"
                                onClick={() => { void updateNode(n.id, { passage_id: p.id })
                                  .then(() => setLinkPickerFor(null))
                                  .catch((e: any) => setSaveError(e.message || 'Link failed')); }}
                                className="block w-full text-left px-2 py-1 hover:bg-cream truncate">
                                {n.title || `#${n.id}`}
                              </button>
                            ))}
                          </div>
                        )}
                      </span>
                    ))}
                  </div>
                );
                // Mantra run: kept as is (Sanskrit), no translation.
                if (u.tagType === 'mantra') {
                  return (
                    <div key={u.key} className="grid grid-cols-2 gap-4 rounded-xl bg-cream-hi/50 p-4"
                         style={{ border: '2px dashed var(--cline)' }}>
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
                       style={{ border: `2px dashed ${u.tagColor ?? 'var(--cline)'}` }}>
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
                          <LevelStepper
                            level={l.level}
                            onSet={(lv) => void setTitleLevel(l.id, lv ?? 1)
                              .catch((e: any) => setSaveError(e.message))}
                            miniStyle={miniStyle}
                            title="Heading level"
                          />
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

              // ── ORIGIN emptied by a move: every syllable was picked up, so there is
              //    nothing left to translate here — a grayed read-only placeholder. The
              //    translation is done at the destination (undo lives on ITS badge).
              if (u.movedOutAll != null) {
                return (
                  <React.Fragment key={u.key}>
                    {placeBar(u.sylIds[0] ?? null, `bar-${u.key}`)}
                    <div
                      data-link-key={u.startOffset}
                      className="grid grid-cols-2 gap-4 rounded-xl bg-cream-hi/60 p-4"
                      style={{ border: '1px dashed var(--cline)' }}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 text-[10px] text-ink-soft">
                          <span className="font-mono">#{i + 1}</span>
                          <span className="px-1.5 rounded-full bg-gold/20 text-amber-robe"
                                title="This segment was picked up in full — it is translated at its new place">
                            moved from here
                          </span>
                        </div>
                        {tibetanTokens(u, false)}
                      </div>
                      <div className="min-w-0 self-center text-xs italic text-ink-soft">
                        Translated at its new place.
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
              // A relocated row sits where its layout row says, not where its syllables live,
              // so the bar above it must reuse that anchor.
              const barAnchor = u.movedLayoutId != null
                ? u.movedAnchorId ?? null
                : u.sylIds[0] ?? null;
              // Commit the translation body to THIS unit. `force` saves even when the text is
              // unchanged — that is what "validate this copy as-is" needs: a copy that needs no
              // trimming would otherwise never get saved (the editor skips a no-op blur), and so
              // would stay flagged "to trim" forever.
              const commit = (html: string, force = false) => {
                if (!force && html === effectiveBody) return;
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
                      // Own saves acknowledge themselves: badges then fire only for changes
                      // made ELSEWHERE.
                      const fresh = useTranslationStore.getState().chunks
                        .find(c => c.start_syl_id === canonSyl.start && c.end_syl_id === canonSyl.end);
                      const tr = fresh?.translations.find(t => t.lang === targetLang);
                      if (fresh && tr) await doMarkSeen(currentText.id, fresh.id, targetLang, tr.updated_at);
                    }
                  } catch (e: any) {
                    setSaveError(e.message || 'Save failed');
                  }
                })();
              };
              return (
                <React.Fragment key={u.key}>
                  {placeBar(barAnchor, `bar-${u.key}`)}
                  <div
                    data-link-key={u.startOffset}
                    // The "N to trim" chevrons walk exactly the rows wearing the badge below.
                    data-copy={isCopy && u.tagType !== 'mantra' ? '' : undefined}
                    // The "N to translate" chevrons walk the rows with an empty translation
                    // (a copy fills the body, so those stay under "to trim" instead). Uses the
                    // SAME `needsTranslation` predicate as the count, so the pill number and the
                    // walkable rows can never drift apart.
                    data-untranslated={needsTranslation(row) ? '' : undefined}
                    className="grid grid-cols-2 gap-4 rounded-xl bg-white p-4"
                    style={{ border: `2px solid ${u.tagType === 'mantra' ? 'var(--cline)' : (u.tagColor ?? 'var(--cline)')}` }}
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
                        {(u.tagType === 'sapche' || u.tagType === 'title') && (() => {
                          // Anchored in the Tibetan sapche outline → level is inherited
                          // (read-only). Otherwise it stays manually definable.
                          const inherited = sapcheDepthBySyl.get(u.startSylId);
                          if (inherited != null) return (
                            <span
                              className="px-1 rounded font-mono bg-cream text-ink-soft"
                              style={miniStyle}
                              title="Level inherited from the Tibetan sapche outline"
                            >
                              H{inherited + 1} · sapche
                            </span>
                          );
                          return (
                            <LevelStepper
                              level={match?.level ?? null}
                              onSet={(lv) => void setLevel({
                                contextTextId: currentText.id,
                                startSylId: canonSyl.start,
                                endSylId: canonSyl.end,
                                level: lv,
                              }).catch((e: any) => setSaveError(e.message || 'Level save failed'))}
                              miniStyle={miniStyle}
                              allowClear
                              title="Title level (whole chunk)"
                            />
                          );
                        })()}
                        {u.movedLayoutId != null && (
                          <span
                            className="px-1.5 rounded-full bg-lapis/15 text-lapis flex items-center gap-1"
                            title="This segment was relocated here for the translation flow (display only — the Tibetan is untouched)"
                          >
                            moved here
                            {canEditTranslate && (
                            <button type="button" onClick={() => void removeLayout(u.movedLayoutId!)
                              .catch((e: any) => setSaveError(e.message))}
                              className="underline underline-offset-2" title="Undo the move">undo</button>
                            )}
                          </span>
                        )}
                        {[...new Set(u.tokens.filter(t => t.movedIn != null).map(t => t.movedIn!))]
                          .map(layoutId => (
                            <span
                              key={`mvin-${layoutId}`}
                              className="px-1.5 rounded-full bg-lapis/15 text-lapis flex items-center gap-1"
                              title="Text moved here from elsewhere for translation flow (display only — the Tibetan is untouched)"
                            >
                              moved in
                              {canEditTranslate && (
                              <button type="button" onClick={() => void removeLayout(layoutId)
                                .catch((e: any) => setSaveError(e.message))}
                                className="underline underline-offset-2" title="Undo the move">undo</button>
                              )}
                            </span>
                          ))}
                        {[...new Set(u.tokens.filter(t => t.movedAway != null).map(t => t.movedAway!))]
                          .map(layoutId => (
                            <span
                              key={`mvaway-${layoutId}`}
                              className="px-1.5 rounded-full bg-gold/20 text-amber-robe flex items-center gap-1"
                              title="Part of this segment was picked up and integrated elsewhere for translation"
                            >
                              moved out
                              {canEditTranslate && (
                              <button type="button" onClick={() => void removeLayout(layoutId)
                                .catch((e: any) => setSaveError(e.message))}
                                className="underline underline-offset-2" title="Undo the move">undo</button>
                              )}
                            </span>
                          ))}
                        {canEditTranslate && (u.tagType === 'small' || u.tagType === 'sapche') && !u.movedLayoutId && !armedMove && (
                          <button
                            type="button"
                            onClick={() => setArmedMove({
                              srcStart: u.sylIds[0], srcEnd: u.sylIds[u.sylIds.length - 1],
                              bookletOnly: false, langOnly: false,
                              label: u.text.slice(0, 24) + (u.text.length > 24 ? '…' : ''),
                            })}
                            className={`${miniBtn} text-ink-soft`}
                            style={miniStyle}
                            title="Move this instruction elsewhere in the translation flow (display only — the Tibetan is untouched)"
                          >
                            <MoveRight size={10} /> move…
                          </button>
                        )}
                        {isCopy && u.tagType !== 'mantra' && (
                          // The pre-filled copy badge doubles as its own dismissal: hover to
                          // see "validate", click to accept the copy AS-IS as this unit's own
                          // translation (a force-save, since an untouched copy is unchanged
                          // text the editor would otherwise never commit). Trimming first, then
                          // blurring, saves the trimmed text the same way and clears it too.
                          <button
                            type="button"
                            onClick={() => commit(effectiveBody, true)}
                            className="group px-1.5 rounded-full bg-gold/20 text-amber-robe hover:bg-jade/20 hover:text-jade transition-colors"
                            title="Pre-filled with a COPY of a wider unit's translation. Trim what doesn't correspond to this passage — or, if it needs no change, click to validate it as this unit's own translation."
                          >
                            <span className="group-hover:hidden">copy — trim to fit</span>
                            <span className="hidden group-hover:inline">validate as-is ✓</span>
                          </button>
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
                            onSave={(html) => commit(html)}
                          />
                          {canEditTranslate && (
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
                          )}
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

    </div>
  );
};
