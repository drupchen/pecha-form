import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { useUndoStore } from './useUndoStore';

export interface Marker {
  id: number;
  text_id: number;
  position: number;
  // Part 6: syllable that starts the new segment (source of truth for the boundary).
  syl_id: string | null;
}

interface MarkerState {
  markers: Marker[];
  fetchMarkers: (textId: number) => Promise<void>;
  createMarker: (textId: number, position: number, sylId?: string | null) => Promise<Marker | null>;
  deleteMarker: (markerId: number) => Promise<void>;
}

export const useMarkerStore = create<MarkerState>((set, get) => ({
  markers: [],

  fetchMarkers: async (textId) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/markers`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ markers: data });
    } catch (e: any) {
      console.error('fetchMarkers failed:', e.message);
    }
  },

  createMarker: async (textId, position, sylId) => {
    try {
      // Part 6: prefer the syllable id — the server derives the position from the
      // same syllables table the frontend rendered (no units_json boundary check).
      const body = sylId ? { syl_id: sylId } : { position };
      const res = await fetch(`${API_BASE}/texts/${textId}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const newMarker: Marker = await res.json();
      set(state => ({
        markers: [...state.markers, newMarker].sort((a, b) => a.position - b.position),
      }));
      useUndoStore.getState().push({
        description: `Add separator @${position}`,
        undo: async () => { await get().deleteMarker(newMarker.id); },
      });
      return newMarker;
    } catch {
      return null;
    }
  },

  deleteMarker: async (markerId) => {
    const before = get().markers.find(m => m.id === markerId);
    try {
      const res = await fetch(`${API_BASE}/markers/${markerId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({ markers: state.markers.filter(m => m.id !== markerId) }));
      if (before) {
        useUndoStore.getState().push({
          description: `Remove separator @${before.position}`,
          undo: async () => { await get().createMarker(before.text_id, before.position, before.syl_id); },
        });
      }
    } catch (e: any) {
      console.error('deleteMarker failed:', e.message);
    }
  },
}));
