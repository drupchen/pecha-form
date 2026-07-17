import { create } from 'zustand';

/**
 * Each undoable action carries a human description and an `undo()` closure
 * that re-applies the inverse via the underlying store actions.
 */
export interface UndoableAction {
  description: string;
  undo: () => Promise<void> | void;
  /** Re-apply the action, for REDO. Optional: entries from stores that predate redo
   *  simply cannot be redone once undone — they are not pushed to the redo stack. */
  redo?: () => Promise<void> | void;
  /**
   * Consecutive pushes carrying the same key within `COALESCE_MS` merge into ONE entry:
   * the merged entry keeps the OLDEST captured prior state (its `undo`) and the NEWEST
   * result (its `redo`/description). A +/+/+ spacing run or a slider drag is one undo,
   * and the 50-slot history holds a real working session instead of one gesture.
   */
  coalesceKey?: string;
}

interface Entry extends UndoableAction { at: number }

interface UndoState {
  history: Entry[];
  redoStack: Entry[];
  /**
   * False while an undo/redo is in flight. Store actions check this before
   * pushing so the inverse work itself doesn't end up back in history.
   */
  recording: boolean;
  push: (action: UndoableAction) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Last description, for the button tooltips. */
  topDescription: () => string | null;
  topRedoDescription: () => string | null;
  clear: () => void;
}

const MAX_HISTORY = 50;
const COALESCE_MS = 3000;

export const useUndoStore = create<UndoState>((set, get) => ({
  history: [],
  redoStack: [],
  recording: true,

  push: (action) => {
    if (!get().recording) return;
    set(s => {
      const top = s.history[s.history.length - 1];
      const now = Date.now();
      if (action.coalesceKey && top && top.coalesceKey === action.coalesceKey
          && now - top.at < COALESCE_MS) {
        // Merge: the old entry's undo (oldest prior state), the new one's redo/description.
        const merged: Entry = { ...action, undo: top.undo, at: now };
        return { history: [...s.history.slice(0, -1), merged], redoStack: [] };
      }
      const next = [...s.history, { ...action, at: now }];
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      // A fresh action forks history: whatever was undone can no longer be redone.
      return { history: next, redoStack: [] };
    });
  },

  undo: async () => {
    const { history, recording } = get();
    if (!recording || history.length === 0) return;
    const action = history[history.length - 1];
    set(s => ({
      recording: false,
      history: s.history.slice(0, -1),
      // Only redoable entries ride the redo stack — an entry with no `redo` is gone.
      redoStack: action.redo ? [...s.redoStack, action] : s.redoStack,
    }));
    try {
      await action.undo();
    } catch (e: any) {
      alert(`Undo failed: ${e?.message ?? e}`);
    } finally {
      set({ recording: true });
    }
  },

  redo: async () => {
    const { redoStack, recording } = get();
    if (!recording || redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    set(s => ({
      recording: false,
      redoStack: s.redoStack.slice(0, -1),
      history: [...s.history, { ...action, at: Date.now() }],
    }));
    try {
      await action.redo!();
    } catch (e: any) {
      alert(`Redo failed: ${e?.message ?? e}`);
    } finally {
      set({ recording: true });
    }
  },

  canUndo: () => get().history.length > 0,
  canRedo: () => get().redoStack.length > 0,
  topDescription: () => {
    const h = get().history;
    return h.length > 0 ? h[h.length - 1].description : null;
  },
  topRedoDescription: () => {
    const r = get().redoStack;
    return r.length > 0 ? r[r.length - 1].description : null;
  },
  clear: () => set({ history: [], redoStack: [] }),
}));
