import { describe, it, expect } from 'vitest';
import { insertTitleChunks, type DerivedChunk } from './chunks';
import type { ChunkLayout } from '../../api/client';

/**
 * Where an inserted title lands.
 *
 * A syllable id does not name a place. Transclude one source several times — text 33 includes
 * text 10 four times — and its uuids repeat, so resolving a title by id alone sent every title
 * in that run to the FIRST occurrence, far from where it was clicked. The occurrence is named
 * by `(id, opId)`, the same pair the booklet anchors its page breaks on, and `anchor_after`
 * addresses the one spot that has no syllable of its own: above a synthetic row.
 */

const chunk = (over: Partial<DerivedChunk> & { ids: string[]; op?: number | null }): DerivedChunk => {
  const { ids, op = null, ...rest } = over;
  return {
    key: `c-${ids[0]}-${op ?? 'x'}`,
    startSylId: ids[0], endSylId: ids[ids.length - 1],
    text: ids.join(' '), sylIds: ids,
    tokens: ids.map(id => ({ id, render: id, opId: op })),
    startOffset: 0, tagType: 'verse', tagColor: null,
    ...rest,
  } as DerivedChunk;
};

const title = (over: Partial<ChunkLayout> & { id: number }): ChunkLayout => ({
  text_id: null, kind: 'title',
  src_start_syl_id: null, src_end_syl_id: null, anchor_syl_id: null,
  move_mode: null, anchor_after: false, level: 1, lang: null,
  render_as: null, disabled: false, position: 0, titles: {},
  ...over,
} as ChunkLayout);

const keys = (out: DerivedChunk[]) => out.map(c => (c.titleLayout ? `T${c.titleLayout.id}` : c.key));

/** The same source transcluded twice: identical syllable ids, told apart by their op. */
const twice = () => [
  chunk({ ids: ['a1'], op: 1 }),
  chunk({ ids: ['m1', 'm2'], op: 7 }),      // first occurrence of the transcluded run
  chunk({ ids: ['b1'], op: 1 }),
  chunk({ ids: ['m1', 'm2'], op: 8 }),      // second occurrence — same ids, other op
  chunk({ ids: ['c1'], op: 1 }),
];

describe('a title anchored inside a repeated transclusion', () => {
  it('lands at the OCCURRENCE it was placed in, not the first one', () => {
    const out = insertTitleChunks(twice(), [
      title({ id: 5, anchor_syl_id: 'm1', anchor_op_id: 8 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'c-m1-7', 'c-b1-1', 'T5', 'c-m1-8', 'c-c1-1']);
  });

  it('still lands at the first occurrence when no op was stored (rows written before this)', () => {
    const out = insertTitleChunks(twice(), [title({ id: 6, anchor_syl_id: 'm1' })]);
    expect(keys(out)).toEqual(['c-a1-1', 'T6', 'c-m1-7', 'c-b1-1', 'c-m1-8', 'c-c1-1']);
  });

  it('falls back to the id when the stored op no longer resolves', () => {
    // A rebuilt derivation renumbers its ops; the title must not fly to the end of the stream.
    const out = insertTitleChunks(twice(), [
      title({ id: 7, anchor_syl_id: 'm1', anchor_op_id: 999 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'T7', 'c-m1-7', 'c-b1-1', 'c-m1-8', 'c-c1-1']);
  });
});

describe('anchor_after — the spot above a synthetic row', () => {
  /** What the bench shows around a relocated fragment: the grayed origin keeps the fragment's
   *  ids, and a synthetic copy of it stands at the destination. */
  const withMove = () => [
    chunk({ ids: ['a1'], op: 1 }),
    chunk({ ids: ['f1'], op: 1, movedOutAll: 3 }),                    // origin, grayed
    chunk({ ids: ['b1'], op: 1 }),
    chunk({ key: 'move-3', ids: ['f1'], op: 1, movedLayoutId: 3, movedAnchorId: 'c1' }),
    chunk({ ids: ['c1'], op: 1 }),
  ];

  it('puts the title ABOVE the moved row when anchored after the chunk before it', () => {
    const out = insertTitleChunks(withMove(), [
      title({ id: 8, anchor_syl_id: 'b1', anchor_op_id: 1, anchor_after: true } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'c-f1-1', 'c-b1-1', 'T8', 'move-3', 'c-c1-1']);
  });

  it('puts the title BELOW the moved row when anchored before the chunk after it', () => {
    const out = insertTitleChunks(withMove(), [
      title({ id: 9, anchor_syl_id: 'c1', anchor_op_id: 1 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'c-f1-1', 'c-b1-1', 'move-3', 'T9', 'c-c1-1']);
  });

  it('never anchors to the synthetic copy, whose ids belong to the origin', () => {
    // 'f1' lives in both the grayed origin and the moved row; a title anchored to it must
    // resolve to the REAL chunk, so removing the move cannot strand it.
    const out = insertTitleChunks(withMove(), [
      title({ id: 10, anchor_syl_id: 'f1', anchor_op_id: 1 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'T10', 'c-f1-1', 'c-b1-1', 'move-3', 'c-c1-1']);
  });

  it('keeps the title where it was put once the move is undone', () => {
    // Same layout row, a stream with no move in it: still after b1, exactly where it was.
    const noMove = [
      chunk({ ids: ['a1'], op: 1 }), chunk({ ids: ['f1'], op: 1 }),
      chunk({ ids: ['b1'], op: 1 }), chunk({ ids: ['c1'], op: 1 }),
    ];
    const out = insertTitleChunks(noMove, [
      title({ id: 8, anchor_syl_id: 'b1', anchor_op_id: 1, anchor_after: true } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'c-f1-1', 'c-b1-1', 'T8', 'c-c1-1']);
  });
});

/**
 * The shape that was still jumping after the first fix, measured in the running bench.
 *
 * A HAIRLINE move injects read-only copies of its fragment into the destination chunk's
 * `tokens` (each marked `movedIn`) and leaves `sylIds` alone. Matching a title's anchor
 * against `tokens` therefore found the BORROWER — chunk 4, many rows above — instead of the
 * syllable's real home, and `anchor_after` placed the title beside it.
 */
describe('a chunk that holds BORROWED tokens', () => {
  const borrowed = (id: string, layoutId = 3) => ({ id, render: id, opId: null, movedIn: layoutId });

  const stream = () => [
    chunk({ ids: ['a1'], op: 1 }),
    // The hairline destination: its own text plus copies of f1, which lives further down.
    {
      ...chunk({ ids: ['d1'], op: 1 }),
      tokens: [{ id: 'd1', render: 'd1', opId: 1 }, borrowed('f1')],
    } as DerivedChunk,
    chunk({ ids: ['v1'], op: 1 }),
    chunk({ ids: ['f1'], op: 1 }),      // where f1 actually lives — the origin
    chunk({ ids: ['z1'], op: 1 }),
  ];

  it('does not capture an anchor whose syllable it only BORROWS', () => {
    const out = insertTitleChunks(stream(), [
      title({ id: 20, anchor_syl_id: 'f1', anchor_op_id: 1, anchor_after: true } as Partial<ChunkLayout> & { id: number }),
    ]);
    // After the OWNER (index 3), not after the borrower (index 1).
    expect(keys(out)).toEqual(['c-a1-1', 'c-d1-1', 'c-v1-1', 'c-f1-1', 'T20', 'c-z1-1']);
  });

  it('reads the occurrence from the owning token, not the copy', () => {
    // The copy carries opId null; the owner carries 1. An op-aware match must still find the
    // owner — matching the copy's op would send the title to the borrower.
    const out = insertTitleChunks(stream(), [
      title({ id: 21, anchor_syl_id: 'f1', anchor_op_id: 1 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'c-d1-1', 'c-v1-1', 'T21', 'c-f1-1', 'c-z1-1']);
  });
});

/**
 * A repeated PASSAGE sits in the gap where the title was clicked.
 *
 * The bench used to splice titles before passages, and a passage block is inserted at the index
 * of the chunk it precedes — so the passage rows landed between a title and its chunk, floating
 * the title to the top of the gap where it read as belonging to the segment above. Passages now
 * go in first; these cases pin the placement that results.
 */
describe('a title anchored past a passage block', () => {
  const passageRow = (ids: string[]): DerivedChunk => ({
    ...chunk({ ids, op: 1 }),
    key: `passage-${ids[0]}`,
    passage: { id: 1 } as unknown as DerivedChunk['passage'],
  });

  it('lands immediately before its chunk, BELOW the repeats', () => {
    const stream = [
      chunk({ ids: ['a1'], op: 1 }),          // #68 — the segment above the gap
      passageRow(['p1']),                     // repeated content, synthetic
      passageRow(['p2']),
      chunk({ ids: ['b1'], op: 1 }),          // #72 — what the title was anchored to
    ];
    const out = insertTitleChunks(stream, [
      title({ id: 30, anchor_syl_id: 'b1', anchor_op_id: 1 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['c-a1-1', 'passage-p1', 'passage-p2', 'T30', 'c-b1-1']);
  });

  it('never anchors to a passage row, which only repeats another chunk’s syllables', () => {
    const stream = [
      chunk({ ids: ['a1'], op: 1 }),
      passageRow(['a1']),                     // the repeat carries the SAME ids as a1
      chunk({ ids: ['b1'], op: 1 }),
    ];
    const out = insertTitleChunks(stream, [
      title({ id: 31, anchor_syl_id: 'a1', anchor_op_id: 1 } as Partial<ChunkLayout> & { id: number }),
    ]);
    expect(keys(out)).toEqual(['T31', 'c-a1-1', 'passage-a1', 'c-b1-1']);
  });
});

describe('the unchanged rules', () => {
  it('DROPS a title whose anchor names nothing in this stream', () => {
    // It belongs to another text. Appending it is what put ten of a compilation's section
    // titles under an unrelated five-line praise, and would print them in its booklet too.
    const out = insertTitleChunks(twice(), [title({ id: 11, anchor_syl_id: 'gone' })]);
    expect(out.some(c => c.titleLayout)).toBe(false);
    expect(out).toHaveLength(5);
  });

  it('appends a title with no anchor at all — the end-of-stream bar', () => {
    const out = insertTitleChunks(twice(), [title({ id: 12 })]);
    expect(keys(out)[5]).toBe('T12');
  });

  it('ignores a disabled title', () => {
    const out = insertTitleChunks(twice(), [title({ id: 13, anchor_syl_id: 'm1', disabled: true })]);
    expect(out).toHaveLength(5);
  });
});
