import { create } from 'zustand';

/**
 * Each undoable action carries a human description and an `undo()` closure
 * that re-applies the inverse via the underlying store actions.
 */
export interface UndoableAction {
  description: string;
  undo: () => Promise<void> | void;
}

interface UndoState {
  history: UndoableAction[];
  /**
   * False while an undo is in flight. Store actions check this before
   * pushing so the inverse work itself doesn't end up back in history.
   */
  recording: boolean;
  push: (action: UndoableAction) => void;
  undo: () => Promise<void>;
  canUndo: () => boolean;
  /** Last description, for the button tooltip. */
  topDescription: () => string | null;
  clear: () => void;
}

const MAX_HISTORY = 50;

export const useUndoStore = create<UndoState>((set, get) => ({
  history: [],
  recording: true,

  push: (action) => {
    if (!get().recording) return;
    set(s => {
      const next = [...s.history, action];
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      return { history: next };
    });
  },

  undo: async () => {
    const { history, recording } = get();
    if (!recording || history.length === 0) return;
    const action = history[history.length - 1];
    set({ recording: false, history: history.slice(0, -1) });
    try {
      await action.undo();
    } catch (e: any) {
      alert(`Undo failed: ${e?.message ?? e}`);
    } finally {
      set({ recording: true });
    }
  },

  canUndo: () => get().history.length > 0,
  topDescription: () => {
    const h = get().history;
    return h.length > 0 ? h[h.length - 1].description : null;
  },
  clear: () => set({ history: [] }),
}));
