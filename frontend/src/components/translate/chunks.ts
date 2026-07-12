import type { EditorToken, ChunkLayout } from '../../api/client';
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
   *  can render the Tibetan as selectable syllable spans (data-syl-id). */
  tokens: { id: string; render: string }[];
  /** Set when this chunk's content was MOVED here by a scramble layout row —
   *  the translator sees it originally belonged elsewhere. */
  movedLayoutId?: number;
  /** Synthetic title chunk (scramble layer): no Tibetan, per-language bodies
   *  live on the layout row; `level` = heading level. */
  titleLayout?: ChunkLayout;
}

/** Content-type priority: the FIRST of these covering a substantial token wins
 *  (a mantra seed inside a verse run classifies as mantra, etc.). */
export const TYPE_PRIORITY = ['mantra', 'small', 'sapche', 'title', 'verse', 'prose'];

/** Apply the scramble layer's MOVE rows as token-stream surgery BEFORE chunk
 *  derivation: each active move excises its source range and splices it in front
 *  of the anchor token (null anchor = end of stream). The rearranged stream then
 *  chunks naturally (the moved fragment forms its own type-homogeneous chunk).
 *  Returns the new stream plus a map syl_id → layout id for "moved here" badges. */
export function applyMoves(
  tokens: EditorToken[],
  layouts: ChunkLayout[],
): { tokens: EditorToken[]; movedBy: Map<string, number> } {
  const movedBy = new Map<string, number>();
  let stream = tokens;
  for (const l of layouts) {
    if (l.kind !== 'move' || l.disabled || !l.src_start_syl_id || !l.src_end_syl_id) continue;
    const si = stream.findIndex(t => t.id === l.src_start_syl_id);
    const ei = stream.findIndex(t => t.id === l.src_end_syl_id);
    if (si < 0 || ei < 0 || ei < si) continue;
    const frag = stream.slice(si, ei + 1);
    const rest = [...stream.slice(0, si), ...stream.slice(ei + 1)];
    let at = l.anchor_syl_id ? rest.findIndex(t => t.id === l.anchor_syl_id) : rest.length;
    if (at < 0) at = rest.length;
    stream = [...rest.slice(0, at), ...frag, ...rest.slice(at)];
    frag.forEach(t => movedBy.set(t.id, l.id));
  }
  return { tokens: stream, movedBy };
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
  let curRenders: { id: string; render: string }[] = [];
  let curType: { name: string; color: string | null } | null = null;

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
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Segment boundary (marker) BEFORE this token.
    if (cur.length > 0 && markerOffsets.has(t.start_offset)) flush();
    // Content-type change BEFORE this token: chunks are type-homogeneous, so a
    // substantial token of a different type starts a new chunk. Whitespace and
    // newline tokens are neutral — they ride with the current chunk.
    if (t.text.trim() !== '') {
      const ty = typeOf(t);
      if (curType != null && ty.name !== curType.name) flush();
      if (curType == null) curType = ty;
    }
    const count = effective(i);
    const isReal = t.text.includes('\n');
    cur.push(t);
    const render = (isReal ? '' : t.text) + (count >= 1 ? '\n' : '');
    curText += render;
    curRenders.push({ id: t.id, render });
    // Empty line AFTER this token: explicit count-2 override, or a real newline
    // pair (a blank line in the raw text). In line mode, ANY break flushes.
    const nxt = tokens[i + 1];
    if ((lineLevel && count >= 1) || count >= 2
        || (isReal && nxt != null && nxt.text.includes('\n'))) flush();
  }
  flush();
  return chunks;
}
