import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { useUndoStore } from './useUndoStore';

export interface Suggestion {
  id: number;
  text_id: number;
  start_offset: number;
  end_offset: number;
  suggested_text: string;
  created_at: string;
}

interface SuggestionState {
  suggestions: Suggestion[];
  loading: boolean;
  error: string | null;

  fetchSuggestions: (textId: number) => Promise<void>;
  // Suggestions are applied corrections (no accept/reject) — create or delete only.
  createSuggestion: (textId: number, start: number, end: number, suggested_text: string) => Promise<Suggestion>;
  deleteSuggestion: (suggestionId: number) => Promise<void>;
}

export const useSuggestionStore = create<SuggestionState>((set, get) => ({
  suggestions: [],
  loading: false,
  error: null,

  fetchSuggestions: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/suggestions`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ suggestions: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  createSuggestion: async (textId, start_offset, end_offset, suggested_text) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_offset, end_offset, suggested_text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const newSug: Suggestion = await res.json();
      set(state => ({ suggestions: [...state.suggestions, newSug] }));
      useUndoStore.getState().push({
        description: 'Add edit suggestion',
        undo: async () => { await get().deleteSuggestion(newSug.id); },
      });
      return newSug;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  deleteSuggestion: async (suggestionId) => {
    const before = get().suggestions.find(s => s.id === suggestionId);
    try {
      const res = await fetch(`${API_BASE}/suggestions/${suggestionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({ suggestions: state.suggestions.filter(s => s.id !== suggestionId) }));
      if (before) {
        useUndoStore.getState().push({
          description: 'Remove edit suggestion',
          undo: async () => {
            await get().createSuggestion(
              before.text_id, before.start_offset, before.end_offset, before.suggested_text,
            );
          },
        });
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },
}));
