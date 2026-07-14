import type { EditorToken, ChunkLayout, Passage } from '../../api/client';
import type { Span } from '../../store/useTagStore';
import { tokenBreak, shortVerseGroupEnders, sapcheRunStartIds } from '../workspace/segments';

/**
 * A DERIVED CHUNK — the translator's unit: the stretch between two empty lines
 * and/or segment boundaries of the booklet's stream. Semantically complete; a
 * translator may reorder sentences inside it but never across it.
 */
export interface DerivedChunk {
  key: string;
  /** Anchors = first/last substantial token (the canonical chunk range). */
  startSylId: string;
  endSylId: string;
  /** Display text with the ¶-mode line breaks applied (one per break point). */
  text: string;
  /** Every token id in the chunk (matching server chunks by overlap). */
  sylIds: string[];
  /** Raw offset of the chunk's very first token. The first chunk of a segment
   *  starts exactly at the segment's offset, so tree-node clicks (which target
   *  `[data-link-key="<segment start>"]`) land on it. */
  startOffset: number;
  /** Content type — the tag class of the chunk ('mantra' | 'small' | 'sapche' |
   *  'title' | 'verse' | 'prose' | 'plain'). Chunks are type-homogeneous: a tag
   *  change starts a new chunk. */
  tagType: string;
  /** The classifying tag's color (pill tint), null for 'plain'. */
  tagColor: string | null;
  /** Per-token render strings (token text + synthesized line breaks) so the bench
   *  can render the Tibetan as selectable syllable spans (data-syl-id). `small` marks
   *  a token that came from a small connector re-merged into a mantra line (`mergeChunks`),
   *  so the editors can flag it (smaller + red) as an implicit-mantra cue. */
  /** `movedAway` marks a token whose translation was picked up and integrated elsewhere
   *  (grayed in place, translate-tab display only); `movedIn` marks a READ-ONLY copy of
   *  such a token injected into its destination chunk. Both carry the move layout id. */
  tokens: { id: string; render: string; small?: boolean; movedAway?: number; movedIn?: number }[];
  /** Set when this chunk's content was MOVED here by a scramble layout row —
   *  the translator sees it originally belonged elsewhere. `movedAnchorId` is that row's
   *  anchor (null = end of stream), so a placement bar drawn at this row anchors HERE and
   *  not back at the origin (the fragment's own syllables live there). */
  movedLayoutId?: number;
  movedAnchorId?: string | null;
  /** Set on an ORIGIN chunk whose every substantial token was picked up by a move: nothing
   *  is left to translate here, so the bench renders it as a grayed read-only placeholder
   *  (no translation box) — the text is translated at its destination. */
  movedOutAll?: number;
  /** Synthetic title chunk (scramble layer): no Tibetan, per-language bodies
   *  live on the layout row; `level` = heading level. */
  titleLayout?: ChunkLayout;
  /** Synthetic PASSAGE chunk: a repetition of earlier content, shown grayed. Its
   *  `tokens` are re-derived from the source slice so it renders with the SAME line
   *  breaks + run types it will paginate with. `passageSrcOffset` is the origin
   *  segment's `startOffset` (its row's `data-link-key`) — the scroll target for "edit
   *  at the original". One synthetic chunk per same-type GROUP of the passage block;
   *  `passageUnitStart`/`passageUnitEnd` are the group's source syl range (for retrieving
   *  the source translation) and `passageUnitKey` keys the per-unit local edit. */
  passage?: Passage;
  passageSrcOffset?: number;
  passageUnitStart?: string;
  passageUnitEnd?: string;
  passageUnitKey?: string;
}

/** Content-type priority: the FIRST of these covering a substantial token wins.
 *  `small` outranks `mantra` so a run tagged BOTH (small Sanskrit in small letters)
 *  classifies as `small` — an editable, non-recited translation unit the translator
 *  types in bold, not a phoneticised mantra. A pure mantra run (no small) stays mantra.
 *  (A `[mantra][small][mantra]` connector stays one line via the inline-minor rule below.) */
export const TYPE_PRIORITY = ['small', 'mantra', 'sapche', 'title', 'verse', 'prose'];

/** Types rendered SMALL in the Tibetan (small letters, sapche topic runs). They are
 *  transparent to chunking when inline — a break-inhibited minor run rides inside the
 *  surrounding line instead of splitting it — and their tokens are flagged `small` so
 *  the Translate/Phonetics editors render them smaller. Extend if others become small. */
const MINOR = new Set(['small', 'sapche']);

/** A `small` run fuses into an adjacent MANTRA only when it is one of these abbreviation
 *  particles (the liturgical "…etc." forms) — a particle plus an eventual punctuation
 *  syllable. Any other small run next to a mantra stays its own translatable unit. */
const ABBREV_FORMS = [
  'ནས།', 'ནས་', 'སོགས།', 'སོགས་', 'ལ་སོགས་', 'ལ་སོགས།',
  'ལ་སོགས་པ་', 'ལ་སོགས་པས་', 'ལ་སོགས་པས།', 'ལ་སོགས་པ།', 'ས་', 'ས།',
];
const stripEnd = (s: string) => s.replace(/[་།༎\s]+$/gu, ''); // drop trailing tsheg/shad/space
const ABBREV_CORES = new Set(ABBREV_FORMS.map(stripEnd));

/** Resolve the scramble layer's MOVE rows to DISPLAY placements (translate-tab only; the
 *  Tibetan stream is NOT rearranged and the booklet is untouched). Each active move marks
 *  its source range as `movedAway` (grayed in place at the origin) and records a placement
 *  at the destination. The two gestures are distinct placements:
 *    'inline'  (hairline) — integrate the fragment INSIDE the anchor's chunk, right before
 *                           the anchor syllable, or right after it when `anchorAfter`.
 *    'segment' (bar)      — the fragment stands as its OWN chunk before the chunk starting
 *                           at the anchor.
 *  A null anchor means the end of the stream in both modes. */
export interface MovePlacement {
  layoutId: number;
  mode: 'inline' | 'segment';
  anchorId: string | null;
  anchorAfter: boolean;
  fragIds: string[];
}

export function moveDisplays(
  tokens: EditorToken[],
  layouts: ChunkLayout[],
): { movedAway: Map<string, number>; placements: MovePlacement[] } {
  const movedAway = new Map<string, number>();
  const placements: MovePlacement[] = [];
  const idx = new Map(tokens.map((t, i) => [t.id, i] as const));
  for (const l of layouts) {
    if (l.kind !== 'move' || l.disabled || !l.src_start_syl_id || !l.src_end_syl_id) continue;
    const si = idx.get(l.src_start_syl_id), ei = idx.get(l.src_end_syl_id);
    if (si == null || ei == null || ei < si) continue;
    const fragIds: string[] = [];
    for (let i = si; i <= ei; i++) { movedAway.set(tokens[i].id, l.id); fragIds.push(tokens[i].id); }
    placements.push({
      layoutId: l.id,
      mode: l.move_mode === 'segment' ? 'segment' : 'inline',
      anchorId: l.anchor_syl_id ?? null,
      anchorAfter: !!l.anchor_after,
      fragIds,
    });
  }
  return { movedAway, placements };
}

/** Post-process the naturally-derived chunk list for moves: gray the moved-away tokens in
 *  place (an origin left with nothing substantial is flagged `movedOutAll` — the bench shows
 *  it as a read-only placeholder), then place each fragment at its destination per its mode:
 *  an 'inline' move splices a READ-ONLY copy into the destination chunk's tokens (the fragment
 *  joins that chunk's translation unit); a 'segment' move inserts the fragment as its OWN chunk,
 *  keeping its real syllable ids so its translation attaches to its own range. Both reuse the
 *  origin's render tokens (breaks + small flags), so the Tibetan reads as it did at the origin. */
export function applyMoveDisplays(
  chunks: DerivedChunk[],
  movedAway: Map<string, number>,
  placements: MovePlacement[],
): DerivedChunk[] {
  if (!movedAway.size) return chunks;
  // Snapshot the moved fragment's (untagged) render tokens by id, for the destination copies.
  const fragById = new Map<string, DerivedChunk['tokens'][number]>();
  const originOf = new Map<string, DerivedChunk>();
  for (const c of chunks) for (const t of c.tokens) if (movedAway.has(t.id)) {
    fragById.set(t.id, t);
    originOf.set(t.id, c);
  }
  const substantial = (t: DerivedChunk['tokens'][number]) => t.render.trim() !== '';
  // Gray the moved-away tokens in place; an origin emptied of ALL its substantial tokens has
  // nothing left to translate (`movedOutAll`).
  const out = chunks.map(c => {
    if (!c.tokens.some(t => movedAway.has(t.id))) return c;
    const tokens = c.tokens.map(t =>
      movedAway.has(t.id) ? { ...t, movedAway: movedAway.get(t.id)! } : t);
    const left = tokens.filter(t => substantial(t) && t.movedAway == null);
    return {
      ...c, tokens,
      movedOutAll: left.length === 0 ? movedAway.get(c.tokens.find(t => movedAway.has(t.id))!.id) : undefined,
    };
  });

  for (const pl of placements) {
    const frag = pl.fragIds
      .map(id => fragById.get(id))
      .filter((t): t is DerivedChunk['tokens'][number] => !!t);
    if (!frag.some(substantial)) continue;
    // Destination chunk: the one holding the anchor (null/unresolved anchor = end of stream).
    const ci = pl.anchorId != null ? out.findIndex(c => c.sylIds.includes(pl.anchorId!)) : -1;

    if (pl.mode === 'segment') {
      // The bar between chunks: the fragment becomes a chunk of its own, typed like its origin.
      const src = originOf.get(pl.fragIds[0]);
      const subs = frag.filter(substantial);
      const row: DerivedChunk = {
        key: `move-${pl.layoutId}`,
        startSylId: subs[0].id,
        endSylId: subs[subs.length - 1].id,
        text: frag.map(t => t.render).join('').replace(/\n{2,}/g, '\n').trim(),
        sylIds: pl.fragIds,
        tokens: frag.map(t => ({ ...t, movedAway: undefined })),
        startOffset: -1,                 // synthetic row: the origin keeps the scroll target
        tagType: src?.tagType ?? 'plain',
        tagColor: src?.tagColor ?? null,
        movedLayoutId: pl.layoutId,
        movedAnchorId: pl.anchorId,
      };
      if (ci >= 0) out.splice(ci, 0, row);
      else out.push(row);
      continue;
    }

    // The hairline: a read-only copy integrated inside the destination chunk, at the anchor.
    const copies = frag.map(t => ({ ...t, movedAway: undefined, movedIn: pl.layoutId }));
    const di = ci >= 0 ? ci : out.length - 1;
    if (di < 0) continue;
    const dest = out[di];
    let at = dest.tokens.findIndex(t => t.id === pl.anchorId);
    if (at < 0) at = dest.tokens.length;             // null anchor / not found → end of the chunk
    else if (pl.anchorAfter) at += 1;
    out[di] = { ...dest, tokens: [...dest.tokens.slice(0, at), ...copies, ...dest.tokens.slice(at)] };
  }
  return out;
}

/** Insert the scramble layer's synthetic TITLE chunks: each appears before the
 *  chunk containing its anchor token (null anchor = end of stream). */
export function insertTitleChunks(
  chunks: DerivedChunk[],
  layouts: ChunkLayout[],
): DerivedChunk[] {
  const titles = layouts.filter(l => l.kind === 'title' && !l.disabled);
  if (!titles.length) return chunks;
  const out = [...chunks];
  for (const l of titles) {
    const entry: DerivedChunk = {
      key: `title-${l.id}`,
      startSylId: '', endSylId: '',
      text: '',
      sylIds: [],
      tokens: [],
      startOffset: -1,
      tagType: 'title',
      tagColor: null,
      titleLayout: l,
    };
    const at = l.anchor_syl_id
      ? out.findIndex(c => c.sylIds.includes(l.anchor_syl_id!))
      : -1;
    if (at >= 0) out.splice(at, 0, entry);
    else out.push(entry);
  }
  return out;
}

/** Insert grayed, read-only PASSAGE rows: a passage repeats earlier content. Passages at
 *  the SAME anchor form one block — concatenate their source ranges, re-derive with the
 *  usual rules (so runs keep their type + line breaks and a whitelisted `ནས` fuses into a
 *  mantra), then emit ONE row per same-type group (adjacent same-type units merged), so
 *  each renders by its type (verse → numbered/editable, mantra → kept as is). */
export function insertPassageChunks(
  chunks: DerivedChunk[],
  passages: Passage[],
  tokens: EditorToken[],
  markerOffsets: Set<number>,
  spans: Span[],
  breakOverrides: Map<string, number>,
  groups: { verse: boolean; sapche: boolean; mantra: boolean },
): DerivedChunk[] {
  if (!passages.length) return chunks;
  const idx = new Map(tokens.map((t, i) => [t.id, i] as const));
  const out = [...chunks];
  // Group passages by anchor, ordered by position (a shared anchor = one repeated block).
  const byAnchor = new Map<string, Passage[]>();
  for (const p of passages) {
    const k = p.anchor_syl_id ?? ' end';
    (byAnchor.get(k) ?? byAnchor.set(k, []).get(k)!).push(p);
  }
  for (const [, group] of byAnchor) {
    group.sort((a, b) => a.position - b.position);
    const first = group[0];
    // Combined source-token stream for the whole block (all passages, all members, in order).
    const combined: EditorToken[] = [];
    for (const p of group) {
      for (const m of p.members) {
        const s = idx.get(m.src_start_syl_id), e = idx.get(m.src_end_syl_id);
        if (s != null && e != null && e >= s) combined.push(...tokens.slice(s, e + 1));
      }
    }
    const units = combined.length
      ? deriveChunks(combined, markerOffsets, spans, breakOverrides, groups)
      : [];
    // Merge adjacent same-type units into groups ("concatenate adjacent same-type").
    const merged: DerivedChunk[] = [];
    for (const u of units) {
      const prev = merged[merged.length - 1];
      if (prev && prev.tagType === u.tagType) {
        prev.tokens = [...prev.tokens, ...u.tokens];
        prev.text = `${prev.text}\n${u.text}`;
        prev.endSylId = u.endSylId;
      } else merged.push({ ...u });
    }
    const at = first.anchor_syl_id
      ? out.findIndex(c => c.sylIds.includes(first.anchor_syl_id!)) : -1;
    const rows = merged.map((g, gi): DerivedChunk => {
      const srcChunk = chunks.find(c => c.sylIds.includes(g.startSylId));
      return {
        key: `passage-${first.id}-${gi}`,
        startSylId: '', endSylId: '',
        text: g.text, sylIds: [], startOffset: -1,
        tokens: g.tokens,
        tagType: g.tagType, tagColor: g.tagColor,
        passage: first,
        passageSrcOffset: srcChunk ? srcChunk.startOffset : undefined,
        passageUnitStart: g.startSylId,
        passageUnitEnd: g.endSylId,
        passageUnitKey: g.startSylId,
      };
    });
    if (at >= 0) out.splice(at, 0, ...rows);
    else out.push(...rows);
  }
  return out;
}

/** Split the composed stream into translation chunks. Boundaries: segment markers,
 *  EMPTY lines — an explicit "empty line" break override (count 2) or two
 *  consecutive real newline tokens — and CONTENT-TYPE changes (small → verse etc.,
 *  see TYPE_PRIORITY), so every chunk is type-homogeneous. Single line breaks
 *  (verse/sapche/mantra rules, count-1 overrides) stay INSIDE a chunk. */
export function deriveChunks(
  tokens: EditorToken[],
  markerOffsets: Set<number>,
  spans: Span[],
  overrides: Map<string, number>,
  groups: { verse: boolean; sapche: boolean; mantra: boolean },
  movedBy?: Map<string, number>,
  // Phonetics bench: flush on EVERY automatic break (single line breaks included),
  // yielding one unit per printed line instead of per empty-line-delimited stretch.
  lineLevel = false,
): DerivedChunk[] {
  const regular = spans.filter(s => s.tag.tag_kind === 'regular');
  const sylSpace = new Map<string, number | 'host'>();
  for (const t of tokens) {
    sylSpace.set(t.id, t.source === 'transclusion' && t.src_text_id != null ? t.src_text_id : 'host');
  }
  const spaceOf = (id: string) => sylSpace.get(id) ?? 'host';
  const spanSpaceOf = (a: { start_syl_id: string | null }) =>
    (a.start_syl_id && sylSpace.get(a.start_syl_id)) || 'host';
  const suppress = groups.verse ? shortVerseGroupEnders(tokens) : new Set<string>();
  const starts = groups.sapche
    ? sapcheRunStartIds(tokens.filter(t => t.text !== ''), regular, spaceOf, spanSpaceOf)
    : new Set<string>();

  const annsFor = (t: EditorToken) => regular.filter(a =>
    a.start_offset <= t.start_offset && a.end_offset >= t.end_offset
    && spanSpaceOf(a) === spaceOf(t.id));
  // Content type of a substantial token: highest-priority covering tag, or 'plain'.
  const typeOf = (t: EditorToken): { name: string; color: string | null } => {
    const anns = annsFor(t);
    for (const name of TYPE_PRIORITY) {
      const hit = anns.find(a => a.tag.name.trim().toLowerCase() === name);
      if (hit) return { name, color: hit.tag.color };
    }
    return { name: 'plain', color: null };
  };

  // Token ids belonging to a `small` run whose text is a whitelisted abbreviation particle
  // — the only small runs allowed to fuse into an adjacent mantra line.
  const abbrevSmall = new Set<string>();
  for (let i = 0; i < tokens.length; ) {
    if (tokens[i].text.trim() === '' || typeOf(tokens[i]).name !== 'small') { i++; continue; }
    const run: EditorToken[] = [];
    let j = i;
    while (j < tokens.length && tokens[j].text.trim() !== '' && typeOf(tokens[j]).name === 'small') {
      run.push(tokens[j]); j++;
    }
    if (ABBREV_CORES.has(stripEnd(run.map(t => t.text).join('')))) run.forEach(t => abbrevSmall.add(t.id));
    i = j;
  }

  const effective = (i: number): number => {
    const t = tokens[i];
    const nxt = tokens.slice(i + 1).find(x => x.text !== '');
    const brk = tokenBreak(t.text, t.end_offset, annsFor(t), {
      ...groups,
      suppressVerse: suppress.has(t.id),
      nextStartsSapche: nxt != null && starts.has(nxt.id),
    });
    return overrides.get(t.id) ?? brk.auto;
  };

  const chunks: DerivedChunk[] = [];
  let cur: EditorToken[] = [];
  let curText = '';
  let curRenders: { id: string; render: string; small?: boolean }[] = [];
  let curType: { name: string; color: string | null } | null = null;
  // The move (scramble) layout id of the current chunk's tokens. A moved fragment is a
  // deliberately relocated SEGMENT, so its edges are hard chunk boundaries — it never gets
  // absorbed into a neighbour by the inline-minor rule (which would drop it, e.g., into a
  // mantra and out of translation scope).
  let curMovedId: number | undefined;
  // First substantial token id of the current chunk — lets a `small→mantra` transition
  // test whether the current small run is a whitelisted abbreviation.
  let curAnchorId: string | null = null;

  const flush = () => {
    const substantial = cur.filter(t => t.text.trim() !== '');
    if (substantial.length > 0) {
      const first = substantial[0], last = substantial[substantial.length - 1];
      chunks.push({
        // Include the push ordinal: repeated liturgical lines share syllable UUIDs,
        // so `${first.id}-${last.id}` alone collides — duplicate React keys make rows
        // duplicate/omit and leak stale nodes across the phonetics bench's tab switch
        // (and cross-contaminate its l.key-keyed drafts). The ordinal is unique and
        // stable across renders. Nothing parses `key` (both benches match by rangeKey).
        key: `${first.id}-${last.id}#${chunks.length}`,
        startSylId: first.id,
        endSylId: last.id,
        text: curText.replace(/\n{2,}/g, '\n').trim(),
        sylIds: cur.map(t => t.id),
        tokens: curRenders,
        startOffset: cur[0].start_offset,
        tagType: curType?.name ?? 'plain',
        tagColor: curType?.color ?? null,
        movedLayoutId: movedBy?.get(first.id),
      });
    }
    cur = [];
    curText = '';
    curRenders = [];
    curType = null;
    curMovedId = undefined;
    curAnchorId = null;
  };

  // Whether a line break occurred since the last substantial token — used to tell an
  // INLINE minor run (its break inhibited) from one on its own line.
  let sawBreak = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Segment boundary (marker) BEFORE this token.
    if (cur.length > 0 && markerOffsets.has(t.start_offset)) { flush(); sawBreak = false; }
    // Content-type change BEFORE this token. Chunks are type-homogeneous EXCEPT that a
    // `MINOR` run (small letters / sapche) rendered small in the Tibetan is transparent
    // when INLINE (no break separates it): it rides inside the surrounding line instead
    // of splitting the translation segment. Its break intact → it still stands alone.
    let tokenSmall = false;
    if (t.text.trim() !== '') {
      const curMoved = movedBy?.get(t.id);
      // A moved-fragment edge always splits (before any type/inline-minor logic), so a
      // relocated small/sapche segment keeps its own chunk instead of being merged into
      // the neighbour it was dropped next to.
      if (curType != null && curMoved !== curMovedId) { flush(); sawBreak = false; }
      const ty = typeOf(t);
      if (curType != null && ty.name !== curType.name) {
        let minorInline = (MINOR.has(ty.name) || MINOR.has(curType.name)) && !sawBreak;
        // A small run fuses into a mantra ONLY when it is a whitelisted abbreviation
        // particle; otherwise it stays its own translatable unit.
        if (minorInline) {
          const smallId = ty.name === 'small' ? t.id : curType.name === 'small' ? curAnchorId : null;
          const otherIsMantra = ty.name === 'mantra' || curType.name === 'mantra';
          if (smallId && otherIsMantra && !abbrevSmall.has(smallId)) minorInline = false;
        }
        if (!minorInline) flush();
        else if (MINOR.has(curType.name) && !MINOR.has(ty.name)) curType = ty; // real type wins
      }
      if (curType == null) { curType = ty; curMovedId = curMoved; curAnchorId = t.id; }
      tokenSmall = MINOR.has(ty.name);
      sawBreak = false;
    }
    const count = effective(i);
    const isReal = t.text.includes('\n');
    cur.push(t);
    const render = (isReal ? '' : t.text) + (count >= 1 ? '\n' : '');
    curText += render;
    curRenders.push(tokenSmall ? { id: t.id, render, small: true } : { id: t.id, render });
    // Empty line AFTER this token: explicit count-2 override, or a real newline
    // pair (a blank line in the raw text). In line mode, ANY break flushes.
    const nxt = tokens[i + 1];
    if ((lineLevel && count >= 1) || count >= 2
        || (isReal && nxt != null && nxt.text.includes('\n'))) { flush(); sawBreak = false; }
    else if (count >= 1) sawBreak = true;
  }
  flush();
  return chunks;
}
