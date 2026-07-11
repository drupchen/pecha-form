import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { useUndoStore } from './useUndoStore';

export interface TreeNode {
  id: number;
  text_id: number;
  parent_id: number | null;
  position: number;
  title: string | null;
  segment_start: number | null;
  /** Set when this sapche section IS a passage occurrence (exclusive w/ segment_start). */
  passage_id: number | null;
  transparent: boolean;
  created_at: string;
  updated_at: string;
}

export interface NestedTreeNode extends TreeNode {
  children: NestedTreeNode[];
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface TreeNodeState {
  nodes: TreeNode[];
  loading: boolean;
  error: string | null;
  saveStatus: SaveStatus;
  /**
   * The tree node currently "expecting input" from the tagger. When the user
   * selects text in the tagger AND this node has a placeholder title, the
   * selected text auto-fills the title. Set when a node is created or its
   * title is clicked; cleared after auto-fill or rename.
   */
  activeNodeId: number | null;

  /**
   * Closure registered by a TreeNodeCard while it is in rename mode. When
   * present, a tagger selection appends to the current rename input instead
   * of running the placeholder-driven auto-fill. Null when nothing is being
   * renamed.
   */
  editingAppend: ((text: string) => void) | null;

  fetchNodes: (textId: number) => Promise<void>;
  createNode: (textId: number, params: {
    parent_id?: number | null;
    position?: number;
    title?: string | null;
    segment_start?: number | null;
    /** Part 6: syllable that starts the linked segment (preferred over segment_start). */
    segment_start_syl_id?: string | null;
    transparent?: boolean;
  }) => Promise<TreeNode>;
  updateNode: (nodeId: number, params: {
    title?: string | null;
    transparent?: boolean;
    /** integer offset to link to a segment, null to unlink, omit to leave alone */
    segment_start?: number | null;
    /** Part 6: syllable that starts the linked segment (preferred over segment_start). */
    segment_start_syl_id?: string | null;
    /** Link the node to a passage occurrence (clears the segment link); null unlinks. */
    passage_id?: number | null;
  }) => Promise<TreeNode>;
  moveNode: (nodeId: number, new_parent_id: number | null, new_position: number) => Promise<void>;
  reorderSiblings: (textId: number, parent_id: number | null, ordered_ids: number[]) => Promise<void>;
  deleteNode: (nodeId: number, onChildren?: 'promote' | 'cascade') => Promise<void>;

  // Local-state helpers for optimistic updates
  applyNodeLocally: (node: TreeNode) => void;
  removeNodeLocally: (nodeId: number) => void;
  setNodesLocally: (nodes: TreeNode[]) => void;

  setActiveNode: (id: number | null) => void;
  setEditingAppend: (fn: ((text: string) => void) | null) => void;
}

export const useTreeNodeStore = create<TreeNodeState>((set, get) => ({
  nodes: [],
  loading: false,
  error: null,
  saveStatus: 'idle',
  activeNodeId: null,
  editingAppend: null,

  fetchNodes: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/tree-nodes`);
      if (!res.ok) throw new Error(await res.text());
      const data: TreeNode[] = await res.json();
      set({ nodes: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  createNode: async (textId, params) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/tree-nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_id: params.parent_id ?? null,
          position: params.position,
          title: params.title ?? null,
          // Part 6: send the syllable id when we have it; the server derives the offset.
          segment_start: params.segment_start ?? null,
          segment_start_syl_id: params.segment_start_syl_id ?? null,
          transparent: params.transparent ?? false,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const newNode: TreeNode = await res.json();
      // Refetch to get correct positions (since insertion at non-end shifts siblings)
      await get().fetchNodes(textId);
      useUndoStore.getState().push({
        description: `Add tree node`,
        undo: async () => { await get().deleteNode(newNode.id, 'cascade'); },
      });
      return newNode;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  updateNode: async (nodeId, params) => {
    const before = get().nodes.find(n => n.id === nodeId);
    set({ saveStatus: 'saving' });
    try {
      const res = await fetch(`${API_BASE}/tree-nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated: TreeNode = await res.json();
      set(state => ({
        nodes: state.nodes.map(n => n.id === nodeId ? updated : n),
        saveStatus: 'saved',
      }));
      if (before) {
        useUndoStore.getState().push({
          description: `Edit tree node "${before.title || '#' + before.id}"`,
          undo: async () => {
            await get().updateNode(nodeId, {
              title: before.title,
              transparent: before.transparent,
              segment_start: before.segment_start,
            });
          },
        });
      }
      return updated;
    } catch (e: any) {
      set({ error: e.message, saveStatus: 'error' });
      throw e;
    }
  },

  moveNode: async (nodeId, new_parent_id, new_position) => {
    const before = get().nodes.find(n => n.id === nodeId);
    const oldParent = before?.parent_id ?? null;
    const oldPosition = before?.position ?? 0;
    set({ saveStatus: 'saving' });
    try {
      const res = await fetch(`${API_BASE}/tree-nodes/${nodeId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_parent_id, new_position }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Refetch — moves cascade position changes to siblings
      if (before) await get().fetchNodes(before.text_id);
      set({ saveStatus: 'saved' });
      if (before) {
        useUndoStore.getState().push({
          description: `Move tree node "${before.title || '#' + before.id}"`,
          undo: async () => { await get().moveNode(nodeId, oldParent, oldPosition); },
        });
      }
    } catch (e: any) {
      set({ error: e.message, saveStatus: 'error' });
      throw e;
    }
  },

  reorderSiblings: async (textId, parent_id, ordered_ids) => {
    set({ saveStatus: 'saving' });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/tree-nodes/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id, ordered_ids }),
      });
      if (!res.ok) throw new Error(await res.text());
      await get().fetchNodes(textId);
      set({ saveStatus: 'saved' });
    } catch (e: any) {
      set({ error: e.message, saveStatus: 'error' });
      throw e;
    }
  },

  deleteNode: async (nodeId, onChildren = 'promote') => {
    const before = get().nodes.find(n => n.id === nodeId);
    // Capture direct children's pre-delete (parent_id, position) so undo can
    // move them back. Only relevant for the 'promote' path — cascade wipes
    // the subtree, which we can't faithfully reconstruct here.
    const beforeChildren = get().nodes
      .filter(n => n.parent_id === nodeId)
      .map(n => ({ id: n.id, position: n.position }));
    try {
      const res = await fetch(`${API_BASE}/tree-nodes/${nodeId}?on_children=${onChildren}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      if (before) await get().fetchNodes(before.text_id);
      if (before) {
        useUndoStore.getState().push({
          description: `Delete tree node "${before.title || '#' + before.id}"`,
          undo: async () => {
            if (onChildren === 'cascade') {
              console.warn('Undo for cascade-deleted subtrees is not supported; recreating only the top node.');
            }
            // Recreate the node at its original parent + position.
            const recreated = await get().createNode(before.text_id, {
              parent_id: before.parent_id,
              position: before.position,
              title: before.title,
              segment_start: before.segment_start,
              transparent: before.transparent,
            });
            // Re-parent each direct child back under the recreated node at its
            // original position (children IDs are unchanged under 'promote').
            for (const c of beforeChildren) {
              await get().moveNode(c.id, recreated.id, c.position);
            }
          },
        });
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  applyNodeLocally: (node) => set(state => ({
    nodes: state.nodes.some(n => n.id === node.id)
      ? state.nodes.map(n => n.id === node.id ? node : n)
      : [...state.nodes, node],
  })),
  removeNodeLocally: (nodeId) => set(state => ({
    nodes: state.nodes.filter(n => n.id !== nodeId),
  })),
  setNodesLocally: (nodes) => set({ nodes }),

  setActiveNode: (id) => set({ activeNodeId: id }),
  setEditingAppend: (fn) => set({ editingAppend: fn }),
}));

// ─── Helpers (pure) ───────────────────────────────────────────────────────────

export function buildNestedTree(flat: TreeNode[]): NestedTreeNode[] {
  const byId = new Map<number, NestedTreeNode>();
  for (const n of flat) byId.set(n.id, { ...n, children: [] });
  const roots: NestedTreeNode[] = [];
  for (const n of flat) {
    const wrapped = byId.get(n.id)!;
    if (n.parent_id === null) roots.push(wrapped);
    else byId.get(n.parent_id)?.children.push(wrapped);
  }
  const sortRec = (nodes: NestedTreeNode[]) => {
    nodes.sort((a, b) => a.position - b.position);
    nodes.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}
