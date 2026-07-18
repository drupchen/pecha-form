import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { apiFetch } from '../api/http';
import { useUndoStore } from './useUndoStore';

export interface Suggestion {
  id: number;
  text_id: number;
  start_offset: number;
  end_offset: number;
  suggested_text: string;
  created_at: string;
  // Part 6: syllable anchors (source of truth); end null for a zero-width insertion.
  start_syl_id: string | null;
  end_syl_id: string | null;
  // Set when this delete came from /extract: the text the range was moved into.
  extracted_text_id: number | null;
  // Upstream review flow: 'applied' = live correction; 'pending' = incoming from a
  // derived text (origin_*), awaiting review here — no effect until accepted.
  status: 'applied' | 'pending';
  origin_text_id: number | null;
  origin_title: string | null;
}

interface SuggestionState {
  suggestions: Suggestion[];
  loading: boolean;
  error: string | null;

  fetchSuggestions: (textId: number) => Promise<void>;
  // Suggestions are applied corrections (no accept/reject) — create or delete only.
  createSuggestion: (
    textId: number, start: number, end: number, suggested_text: string,
    sylIds?: { startSylId: string | null; endSylId: string | null },
  ) => Promise<Suggestion>;
  deleteSuggestion: (suggestionId: number) => Promise<void>;
}

export const useSuggestionStore = create<SuggestionState>((set, get) => ({
  suggestions: [],
  loading: false,
  error: null,

  fetchSuggestions: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch(`${API_BASE}/texts/${textId}/suggestions`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ suggestions: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  createSuggestion: async (textId, start_offset, end_offset, suggested_text, sylIds) => {
    try {
      // Part 6: prefer syllable anchors. A zero-width insertion sends end_syl_id
      // null; the server derives offsets from the syllables table (no units_json).
      const body = sylIds?.startSylId
        ? { start_syl_id: sylIds.startSylId, end_syl_id: sylIds.endSylId, suggested_text }
        : { start_offset, end_offset, suggested_text };
      const res = await apiFetch(`${API_BASE}/texts/${textId}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      const res = await apiFetch(`${API_BASE}/suggestions/${suggestionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({ suggestions: state.suggestions.filter(s => s.id !== suggestionId) }));
      if (before) {
        useUndoStore.getState().push({
          description: 'Remove edit suggestion',
          undo: async () => {
            await get().createSuggestion(
              before.text_id, before.start_offset, before.end_offset, before.suggested_text,
              { startSylId: before.start_syl_id, endSylId: before.end_syl_id },
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
