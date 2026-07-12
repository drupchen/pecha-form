import { create } from 'zustand';
import {
  getPassages, createPassage, updatePassage, deletePassage, splitPassage,
  type Passage, type PassageMemberInput,
} from '../api/client';

interface PassageState {
  passages: Passage[];
  fetchPassages: (textId: number) => Promise<void>;
  addPassage: (
    textId: number,
    body: { anchor_syl_id: string | null; members: PassageMemberInput[]; color?: string | null; position?: number; attach_prev?: boolean },
  ) => Promise<Passage>;
  editPassage: (
    passageId: number,
    patch: Partial<{ anchor_syl_id: string | null; position: number; color: string | null; own_segment: boolean; attach_prev: boolean; members: PassageMemberInput[] }>,
  ) => Promise<void>;
  removePassage: (passageId: number) => Promise<void>;
  splitPassageAt: (
    passageId: number,
    body: {
      after_syl_id: string;
      second_own_segment?: boolean;
      first_attach_prev?: boolean;
      second_attach_prev?: boolean;
    },
  ) => Promise<void>;
}

export const usePassageStore = create<PassageState>((set, get) => ({
  passages: [],

  fetchPassages: async (textId) => {
    try {
      const data = await getPassages(textId);
      set({ passages: data });
    } catch (e: any) {
      console.error('fetchPassages failed:', e.message);
      set({ passages: [] });
    }
  },

  addPassage: async (textId, body) => {
    // Rethrows on failure so the caller can surface the reason (e.g. the placement
    // banner) instead of the click silently doing nothing.
    const created = await createPassage(textId, body);
    set(state => ({ passages: [...state.passages, created] }));
    return created;
  },

  editPassage: async (passageId, patch) => {
    // Inherited passages are read-only here — edit them on their owning text.
    if (get().passages.find(p => p.id === passageId)?.inherited) return;
    try {
      const updated = await updatePassage(passageId, patch);
      set(state => ({ passages: state.passages.map(p => (p.id === passageId ? updated : p)) }));
    } catch (e: any) {
      console.error('updatePassage failed:', e.message);
    }
  },

  splitPassageAt: async (passageId, body) => {
    // Rethrows so the popover can surface the reason. The endpoint renumbers sibling
    // positions server-side, so refresh the whole list rather than patching in place.
    const p = get().passages.find(x => x.id === passageId);
    if (p?.inherited) return;
    await splitPassage(passageId, body);
    if (p?.text_id != null) await get().fetchPassages(p.text_id);
  },

  removePassage: async (passageId) => {
    if (get().passages.find(p => p.id === passageId)?.inherited) return;
    try {
      await deletePassage(passageId);
      set(state => ({ passages: state.passages.filter(p => p.id !== passageId) }));
    } catch (e: any) {
      console.error('deletePassage failed:', e.message);
    }
  },
}));
