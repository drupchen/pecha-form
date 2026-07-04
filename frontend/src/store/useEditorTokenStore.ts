import { create } from 'zustand';
import { getEditorTokens, type EditorToken } from '../api/client';

/**
 * The corrected root syllable layer for the workspace tagger (Phase 3 E1/E2).
 *
 * One fetch per document; the tagger renders the segment body from these tokens
 * (corrected text = the live selectable text) and derives both syllable-UUID
 * anchors and raw offsets from each token's `data-` attributes. Re-fetched
 * whenever the suggestions change (a correction edits the corrected text).
 */
interface EditorTokenState {
  tokens: EditorToken[];
  textId: number | null;
  loading: boolean;
  error: string | null;
  fetchTokens: (textId: number) => Promise<void>;
  clear: () => void;
}

export const useEditorTokenStore = create<EditorTokenState>((set) => ({
  tokens: [],
  textId: null,
  loading: false,
  error: null,

  fetchTokens: async (textId) => {
    set({ loading: true, error: null });
    try {
      const tokens = await getEditorTokens(textId);
      set({ tokens, textId, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  clear: () => set({ tokens: [], textId: null }),
}));
