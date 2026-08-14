import { describe, it, expect } from 'vitest';
import { buildNestedTree, levelIsMixed, ownRunPosition, type TreeNode } from './useTreeNodeStore';

/**
 * Outline order on a text that inherits sections.
 *
 * `position` numbers siblings within ONE owner, so a secondary's own sections restart at
 * 0 alongside inherited ones already occupying 0..n. Only the server's `sort_index` —
 * composed from the nodes' anchors — describes the level, and these tests pin the two
 * ways that went wrong: sorting by `position`, and a write response whose index defaults
 * to 0 outranking real ones.
 */

const node = (p: Partial<TreeNode> & { id: number }): TreeNode => ({
  text_id: 69,
  parent_id: null,
  position: 0,
  title: `#${p.id}`,
  segment_start: null,
  passage_id: null,
  transparent: false,
  created_at: '',
  updated_at: '',
  ...p,
});

// Three inherited sections (owned by 63) plus two the secondary added, anchored after
// all of them — the real shape of text 69.
const LEVEL: TreeNode[] = [
  node({ id: 180, owner_text_id: 63, inherited: true, position: 0, sort_index: 0, segment_start: 94 }),
  node({ id: 181, owner_text_id: 63, inherited: true, position: 1, sort_index: 1, segment_start: 318 }),
  node({ id: 182, owner_text_id: 63, inherited: true, position: 2, sort_index: 2, segment_start: 1148 }),
  node({ id: 190, owner_text_id: 69, position: 0, sort_index: 3, segment_start: 1494 }),
  node({ id: 191, owner_text_id: 69, position: 1, sort_index: 4, segment_start: 1671 }),
];

describe('buildNestedTree ordering', () => {
  it('follows sort_index, not position', () => {
    // Sorting by `position` would interleave the two owners' 0s and 1s.
    expect(buildNestedTree(LEVEL).map(n => n.id)).toEqual([180, 181, 182, 190, 191]);
  });

  it('keeps the given order regardless of the order rows arrive in', () => {
    const shuffled = [LEVEL[4], LEVEL[0], LEVEL[3], LEVEL[2], LEVEL[1]];
    expect(buildNestedTree(shuffled).map(n => n.id)).toEqual([180, 181, 182, 190, 191]);
  });

  it('does not let a node with no sort_index outrank the rest', () => {
    // What a PATCH response used to inject: a linked section claiming index 0.
    const justLinked = LEVEL.map(n =>
      n.id === 191 ? { ...n, sort_index: undefined } : n);
    const order = buildNestedTree(justLinked).map(n => n.id);
    expect(order.indexOf(191)).toBeGreaterThan(order.indexOf(180));
  });

  it('nests children under their parent', () => {
    const withChild = [...LEVEL, node({ id: 200, parent_id: 181, owner_text_id: 69, sort_index: 0 })];
    const roots = buildNestedTree(withChild);
    expect(roots.map(n => n.id)).toEqual([180, 181, 182, 190, 191]);
    expect(roots.find(n => n.id === 181)!.children.map(c => c.id)).toEqual([200]);
  });
});

describe('own-run helpers', () => {
  it('detects a level that mixes owners', () => {
    expect(levelIsMixed(LEVEL, 69)).toBe(true);
    expect(levelIsMixed(LEVEL.filter(n => n.owner_text_id === 63), 63)).toBe(false);
  });

  it('counts only this text\'s own siblings before the slot', () => {
    // Slot after all five rendered rows: only two of them are ours.
    expect(ownRunPosition(LEVEL, 5, 69)).toBe(2);
    // Slot right after the first inherited section: none of ours yet.
    expect(ownRunPosition(LEVEL, 1, 69)).toBe(0);
    // On a single-owner level it is just the rendered index.
    expect(ownRunPosition(LEVEL, 3, 63)).toBe(3);
  });
});
