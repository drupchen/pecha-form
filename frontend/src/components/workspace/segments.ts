import type { Span } from '../../store/useTagStore';
import type { Marker } from '../../store/useMarkerStore';
import type { Suggestion } from '../../store/useSuggestionStore';
import type { Note } from '../../store/useNoteStore';
import type { EditorToken } from '../../api/client';

export interface Segment {
  /** Unique key for React rendering */
  key: string;
  start: number;
  end: number;
  /** Raw (uncorrected) segment text — used for skip/title/tree-autofill, NOT display. */
  text: string;
  /** Corrected syllable tokens covering this segment, in reading order (the body
   *  renders these so the displayed text is the corrected, selectable text). */
  tokens: EditorToken[];
  /** Spans whose range overlaps this segment — rendered as inline highlights. */
  annotations: Span[];
  /** Suggestions whose range overlaps this segment */
  suggestions: Suggestion[];
  /** Notes whose range overlaps this segment */
  notes: Note[];
}

/**
 * Compute the ordered segment list for the tagger pane.
 *
 * Segments are bounded purely by markers (plus 0 and `len(rawText)`).
 * Every overlapping span is attached as an inline annotation — there's no
 * primary/boundary distinction anymore. `tokens` (the corrected syllable layer)
 * are attached per segment so the body can render corrected text.
 */
export function computeSegments(
  rawText: string,
  spans: Span[],
  markers: Marker[],
  suggestions: Suggestion[],
  notes: Note[] = [],
  tokens: EditorToken[] = [],
): Segment[] {
  const breakpointSet = new Set<number>([0, rawText.length]);
  for (const m of markers) {
    if (m.position <= 0 || m.position >= rawText.length) continue;
    breakpointSet.add(m.position);
  }
  const breakpoints = Array.from(breakpointSet).sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const start = breakpoints[i];
    const end = breakpoints[i + 1];
    if (start === end) continue;

    const overlappingAnnotations = spans.filter(
      a => a.start_offset < end && a.end_offset > start,
    );
    const overlappingSuggestions = suggestions.filter(s => {
      if (s.start_offset === s.end_offset) {
        // Pure insertion at offset p: belongs to the segment that "owns" p on its
        // right edge — i.e. strictly inside, or at the right boundary. This
        // prevents an insertion that sits on a marker from rendering twice
        // (once in segment N at its end, once in segment N+1 at its start).
        // Offset 0 is anchored to the first segment.
        return (s.start_offset > start || start === 0) && s.start_offset <= end;
      }
      return s.start_offset <= end && s.end_offset >= start;
    });
    const overlappingNotes = notes.filter(
      n => n.start_offset < end && n.end_offset > start,
    );
    // Tokens whose skeleton start sits inside this segment. Inserted tokens
    // (zero-width) follow the same "owns p on its right edge" rule as insertions.
    const segTokens = tokens.filter(t => {
      if (t.inserted) return (t.start_offset > start || start === 0) && t.start_offset <= end;
      return t.start_offset >= start && t.start_offset < end;
    });

    const text = rawText.substring(start, end);
    // Skip pure-whitespace segments — these are the lone '\n' separators that
    // the CherryTree importer inserts between consecutive node-text blocks.
    if (text.trim() === '') continue;

    segments.push({
      key: `seg-${start}-${end}`,
      start,
      end,
      text,
      tokens: segTokens,
      annotations: overlappingAnnotations,
      suggestions: overlappingSuggestions,
      notes: overlappingNotes,
    });
  }
  return segments;
}

/** Resolve a token's AUTOMATIC line-break behavior in ¶ mode (the body renders
 *  `whitespace-pre-wrap`). `isReal` marks a real newline token of the text data —
 *  its break is the token itself, so the renderer moves the '\n' into the break
 *  element (suppressible display-side). Synthesized breaks: verse mode breaks after
 *  any space inside a "verse"-tagged token — the space usually rides inside a PUNCT
 *  token like '༔ ' or '། ', which is why a `nature === 'SPACE'` gate never fired on
 *  real Tibetan verse; sapche mode breaks after the LAST token of a "sapche"-tagged
 *  span (annotation boundaries sit on syllable edges, so that token's end offset
 *  equals the span's), and BEFORE a sapche run that is not at its card's start —
 *  expressed as a break after the PREVIOUS token (`nextStartsSapche`), so the same
 *  ↵ icon/override machinery applies. A per-position user override (display_breaks)
 *  replaces `auto` with an explicit count. */
export interface TokenBreakOpts {
  verse: boolean;
  sapche: boolean;
  mantra: boolean;
  /** Verse-seed suppression: this token ends a ≤2-syllable group. */
  suppressVerse?: boolean;
  /** The NEXT token begins a sapche run — break before it (i.e. after this one). */
  nextStartsSapche?: boolean;
}

export function tokenBreak(
  text: string,
  endOffset: number,
  anns: { tag: { name: string }; end_offset: number }[],
  opts: TokenBreakOpts,
): { auto: 0 | 1; isReal: boolean } {
  if (text.includes('\n')) return { auto: 1, isReal: true };
  const named = (n: string) => (a: { tag: { name: string } }) =>
    a.tag.name.trim().toLowerCase() === n;
  if (opts.verse && !opts.suppressVerse && /\s/.test(text) && anns.some(named('verse'))) {
    return { auto: 1, isReal: false };
  }
  if (opts.sapche
      && (opts.nextStartsSapche || anns.some(a => named('sapche')(a) && a.end_offset === endOffset))) {
    return { auto: 1, isReal: false };
  }
  if (opts.mantra && anns.some(a => named('mantra')(a) && a.end_offset === endOffset)) {
    return { auto: 1, isReal: false };
  }
  return { auto: 0, isReal: false };
}

/** Ids of tokens that BEGIN a "sapche"-tagged run (the span starts exactly at the
 *  token's start offset). The token before such a run gets an automatic break so a
 *  mid-card sapche heading starts its own line; a run already at the card's first
 *  token has no previous token and naturally gets none. */
export function sapcheRunStartIds(
  tokens: { id: string; start_offset: number; end_offset: number }[],
  anns: { tag: { name: string }; start_offset: number; end_offset: number }[],
  spaceOf: (tokenId: string) => number | 'host',
  spanSpaceOf: (a: any) => number | 'host',
): Set<string> {
  const sapche = anns.filter(a => a.tag.name.trim().toLowerCase() === 'sapche');
  const out = new Set<string>();
  if (!sapche.length) return out;
  for (const t of tokens) {
    if (sapche.some(a => a.start_offset === t.start_offset && a.end_offset >= t.end_offset
        && spanSpaceOf(a) === spaceOf(t.id))) {
      out.add(t.id);
    }
  }
  return out;
}

/** Whitespace tokens that end a SHORT group — ≤2 TEXT syllables since the previous
 *  whitespace token or line break. These are seed/invocation syllables like 'ཧྲཱིཿ' or
 *  'ན་མོ༔' that open a verse line: verse vertical mode must NOT break after them, so
 *  the seed stays on the same line as the phrase it introduces. Returns the ids to
 *  pass as `suppressVerseBreak` to `tokenDisplayText`. */
export function shortVerseGroupEnders(
  tokens: { id: string; text: string; nature: string }[],
): Set<string> {
  const out = new Set<string>();
  let textSyls = 0;
  for (const t of tokens) {
    if (t.text.includes('\n')) { textSyls = 0; continue; }
    if (/\s/.test(t.text)) {
      if (textSyls <= 2) out.add(t.id);
      textSyls = 0;
    } else if (t.nature === 'TEXT') {
      textSyls++;
    }
  }
  return out;
}

/** Would a manual break after `sylId` sit ADJACENT to an existing newline? Guard for
 *  the "↵ line / ↵ empty line" gesture: two stacked single breaks would silently make
 *  a blank line — blank lines must come only from the explicit "empty line" option.
 *  Computed over the FULL composed stream with the same context the render sites use
 *  (annotation spaces, verse-seed suppression, sapche run starts). `spans` must be
 *  the REGULAR spans only. */
export function hasAdjacentNewline(
  tokens: { id: string; text: string; nature: string; start_offset: number; end_offset: number; source?: string; src_text_id?: number | null }[],
  spans: { tag: { name: string }; start_offset: number; end_offset: number; start_syl_id: string | null }[],
  overrides: Map<string, number>,
  groups: { verse: boolean; sapche: boolean; mantra: boolean },
  sylId: string,
): boolean {
  const idx = tokens.findIndex(t => t.id === sylId);
  if (idx < 0) return false;
  const sylSpace = new Map<string, number | 'host'>();
  for (const t of tokens) {
    sylSpace.set(t.id, t.source === 'transclusion' && t.src_text_id != null ? t.src_text_id : 'host');
  }
  const spaceOf = (id: string) => sylSpace.get(id) ?? 'host';
  const spanSpaceOf = (a: { start_syl_id: string | null }) =>
    (a.start_syl_id && sylSpace.get(a.start_syl_id)) || 'host';
  const suppress = groups.verse ? shortVerseGroupEnders(tokens) : new Set<string>();
  const starts = groups.sapche
    ? sapcheRunStartIds(tokens.filter(t => t.text !== ''), spans, spaceOf, spanSpaceOf)
    : new Set<string>();
  const effective = (i: number): number => {
    const t = tokens[i];
    const tSpace = spaceOf(t.id);
    const anns = spans.filter(a => a.start_offset <= t.start_offset
      && a.end_offset >= t.end_offset && spanSpaceOf(a) === tSpace);
    const nxt = tokens.slice(i + 1).find(x => x.text !== '');
    const brk = tokenBreak(t.text, t.end_offset, anns, {
      ...groups,
      suppressVerse: suppress.has(t.id),
      nextStartsSapche: nxt != null && starts.has(nxt.id),
    });
    return overrides.get(t.id) ?? brk.auto;
  };
  // Forward: the first rendered thing after the target's break must not be a newline.
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    const count = effective(i);
    if (t.text === '') {            // renders nothing itself
      if (count >= 1) return true;  // …but its break would follow immediately
      continue;
    }
    if (t.text.includes('\n')) {
      if (count >= 1) return true;  // the real newline renders
      continue;                     // suppressed real newline renders ''
    }
    break;                          // visible text intervenes
  }
  // Backward: only matters when the target renders no visible text of its own.
  const target = tokens[idx];
  if (target.text === '' || target.text.includes('\n')) {
    for (let i = idx - 1; i >= 0; i--) {
      if (effective(i) >= 1) return true;
      const t = tokens[i];
      if (t.text !== '' && !t.text.includes('\n')) break;
    }
  }
  return false;
}

/** Walk up from `node` to the nearest element carrying `data-syl-id` (a token span). */
function enclosingToken(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.dataset.sylId !== undefined) return el;
    }
    n = n.parentNode;
  }
  return null;
}

/**
 * Resolve a selection endpoint to its token span. When the caret sits directly on
 * the container (between token spans), fall back to the child token at that edge.
 */
function tokenAtEndpoint(container: HTMLElement, node: Node, offset: number): HTMLElement | null {
  const direct = enclosingToken(node);
  if (direct) return direct;
  if (node === container) {
    const kids = container.childNodes;
    for (const cand of [kids[offset], kids[offset - 1]]) {
      const tok = cand && enclosingToken(cand);
      if (tok) return tok;
    }
  }
  return null;
}

/**
 * Read the current DOM selection inside a token-rendered body and return the
 * covered syllable range — absolute raw offsets (from each token's `data-ro` /
 * `data-reo`) AND the start/end syllable UUIDs (`data-syl-id`). Selection snaps
 * to whole tokens (syllables): the start token's start and the end token's end.
 *
 * Returns null for collapsed selections, selections outside the container, or a
 * degenerate range (e.g. only a zero-width inserted token).
 */
export function readTokenSelection(container: HTMLElement): {
  start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect;
  /** Set when BOTH endpoints are inside the same passage run — the selection targets
   *  that passage occurrence (notes attach per-occurrence; tags stay shared). */
  passageId?: number;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null;

  const range = sel.getRangeAt(0);
  let a = tokenAtEndpoint(container, range.startContainer, range.startOffset);
  let b = tokenAtEndpoint(container, range.endContainer, range.endOffset);
  if (!a || !b) return null;
  // Keep each resolved token paired with the raw endpoint it came from so the
  // boundary correction below tests the right edge even after a swap.
  let aEnd = { node: range.startContainer, offset: range.startOffset };
  let bEnd = { node: range.endContainer, offset: range.endOffset };
  if (Number(a.dataset.ro) > Number(b.dataset.ro)) {
    [a, b] = [b, a];
    [aEnd, bEnd] = [bEnd, aEnd];
  }

  // Boundary fix: an endpoint landing exactly on a token edge is ambiguous — the
  // browser commonly attaches it to the *end* of the preceding text node. A start
  // on a token's trailing edge really belongs to the NEXT token, and an end on a
  // token's leading edge belongs to the PREVIOUS token. Without this, selecting a
  // run that opens with a mark like ༼ pulls the preceding punctuation ("༔ ") into
  // the tag.
  const toks = Array.from(container.querySelectorAll<HTMLElement>('[data-syl-id]'))
    .filter(el => el.dataset.sylId);
  const atTrailingEdge = (n: Node, off: number) =>
    n.nodeType === Node.TEXT_NODE && off === (n.textContent?.length ?? 0);
  const atLeadingEdge = (n: Node, off: number) =>
    n.nodeType === Node.TEXT_NODE && off === 0;
  let ai = toks.indexOf(a);
  let bi = toks.indexOf(b);
  if (ai >= 0 && bi >= 0) {
    if (atTrailingEdge(aEnd.node, aEnd.offset) && ai + 1 <= bi) a = toks[++ai];
    if (atLeadingEdge(bEnd.node, bEnd.offset) && bi - 1 >= ai) b = toks[--bi];
  }

  const start = Number(a.dataset.ro);
  const end = Number(b.dataset.reo);
  if (end <= start) return null;
  // Snap the *visible* selection to whole syllables so the highlight lands on
  // token boundaries — the cue used to confirm a selection is syllable-aligned.
  const snapped = document.createRange();
  snapped.setStartBefore(a);
  snapped.setEndAfter(b);
  sel.removeAllRanges();
  sel.addRange(snapped);
  const passageId =
    a.dataset.passageId && a.dataset.passageId === b.dataset.passageId
      ? Number(a.dataset.passageId)
      : undefined;
  return {
    start, end,
    startSylId: a.dataset.sylId!,
    endSylId: b.dataset.sylId!,
    rect: snapped.getBoundingClientRect(),
    passageId,
  };
}

// snapToUnits now lives in lib/snap.ts (shared across Workspace, Transcriptions,
// and Search). Re-exported here so existing imports keep working.
export { snapToUnits } from '../../lib/snap';
