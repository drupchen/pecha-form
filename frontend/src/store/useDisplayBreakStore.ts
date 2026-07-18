import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { apiFetch } from '../api/http';

/**
 * Display-only line-break overrides (the ¶ mode), current text only. Keyed by
 * syllable uuid: `count` newlines render after that token while ¶ mode is on,
 * overriding the automatic verse/sapche/real-newline behavior. 0 = suppress.
 * No entry = automatic. Persisted server-side; optimistic updates here.
 */
interface DisplayBreakState {
  breaks: Map<string, number>;
  fetchBreaks: (textId: number) => Promise<void>;
  /** Upsert the override at one position (count 0 | 1 | 2). */
  setBreak: (textId: number, sylId: string, count: number) => Promise<void>;
  /** Remove the override — the position falls back to automatic behavior. */
  clearBreak: (textId: number, sylId: string) => Promise<void>;
}

export const useDisplayBreakStore = create<DisplayBreakState>((set, get) => ({
  breaks: new Map(),

  fetchBreaks: async (textId) => {
    try {
      const res = await apiFetch(`${API_BASE}/texts/${textId}/display-breaks`);
      if (!res.ok) throw new Error(await res.text());
      const data: { syl_id: string; count: number }[] = await res.json();
      set({ breaks: new Map(data.map(b => [b.syl_id, b.count])) });
    } catch (e: any) {
      console.error('fetchBreaks failed:', e.message);
    }
  },

  setBreak: async (textId, sylId, count) => {
    const before = get().breaks;
    const next = new Map(before);
    next.set(sylId, count);
    set({ breaks: next });
    try {
      const res = await apiFetch(`${API_BASE}/texts/${textId}/display-breaks/${sylId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      console.error('setBreak failed:', e.message);
      set({ breaks: before });
    }
  },

  clearBreak: async (textId, sylId) => {
    const before = get().breaks;
    const next = new Map(before);
    next.delete(sylId);
    set({ breaks: next });
    try {
      const res = await apiFetch(`${API_BASE}/texts/${textId}/display-breaks/${sylId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      console.error('clearBreak failed:', e.message);
      set({ breaks: before });
    }
  },
}));
