import { create } from 'zustand';
import {
  getPassages, createPassage, updatePassage, deletePassage,
  type Passage, type PassageMemberInput,
} from '../api/client';

interface PassageState {
  passages: Passage[];
  fetchPassages: (textId: number) => Promise<void>;
  addPassage: (
    textId: number,
    body: { anchor_syl_id: string | null; members: PassageMemberInput[]; color?: string | null },
  ) => Promise<Passage | null>;
  editPassage: (
    passageId: number,
    patch: Partial<{ anchor_syl_id: string | null; position: number; color: string | null; members: PassageMemberInput[] }>,
  ) => Promise<void>;
  removePassage: (passageId: number) => Promise<void>;
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
    try {
      const created = await createPassage(textId, body);
      set(state => ({ passages: [...state.passages, created] }));
      return created;
    } catch (e: any) {
      console.error('createPassage failed:', e.message);
      return null;
    }
  },

  editPassage: async (passageId, patch) => {
    try {
      const updated = await updatePassage(passageId, patch);
      set(state => ({ passages: state.passages.map(p => (p.id === passageId ? updated : p)) }));
    } catch (e: any) {
      console.error('updatePassage failed:', e.message);
    }
  },

  removePassage: async (passageId) => {
    try {
      await deletePassage(passageId);
      set(state => ({ passages: state.passages.filter(p => p.id !== passageId) }));
    } catch (e: any) {
      console.error('deletePassage failed:', e.message);
    }
  },
}));
