import { create } from 'zustand';
import { listTexts, getText, uploadText, deleteText, setMainTextSrtDir, deriveText, extractText, cloneText, updateTextMeta, listTextGroups, createTextGroup, moveTextGroup, reorderTextGroup, deleteTextGroup } from '../api/client';
import { useSuggestionStore } from './useSuggestionStore';

export type TextType = 'primary' | 'secondary';

export interface TextInfo {
  id: number;
  filename: string;
  title: string;
  // User-assigned collection label; null == ungrouped (Part 10).
  text_group: string | null;
  text_type: TextType;
  parent_text_id: number | null;
  // "Duplicate (bake edits)" provenance: the original this was cloned from (NULLed when
  // the original is deleted). `has_clone` marks the reverse — a text that has a duplicate.
  cloned_from_text_id: number | null;
  has_clone: boolean;
  created_at: string;
  updated_at: string;
  span_count: number;
  tag_count: number;
}

export interface TextDetail extends TextInfo {
  raw_text: string;
  units: [number, number, string][];
  instance_id?: string | null;
  main_text_srt_dir?: string | null;
}

interface TextState {
  texts: TextInfo[];
  // Part 12: persisted group paths (so empty groups survive). The texts tree is built
  // from the union of these and the texts' own text_group values.
  groups: string[];
  currentText: TextDetail | null;
  loading: boolean;
  error: string | null;

  fetchTexts: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  createGroup: (path: string) => Promise<void>;
  moveGroup: (src: string, dest: string) => Promise<void>;
  reorderGroup: (src: string, parent: string, beforePath: string) => Promise<void>;
  deleteGroup: (path: string) => Promise<void>;
  loadText: (id: number) => Promise<void>;
  uploadNewFile: (file: File) => Promise<number>;
  removeText: (id: number) => Promise<void>;
  deriveSecondary: (parentId: number) => Promise<number>;
  extractSelection: (id: number, startSylId: string, endSylId: string) => Promise<number>;
  cloneWithEdits: (id: number) => Promise<number>;
  updateMeta: (id: number, patch: { title?: string; text_group?: string | null }) => Promise<void>;
  saveMainTextSrtDir: (id: number, dir: string) => Promise<void>;
}

export const useTextStore = create<TextState>((set, get) => ({
  texts: [],
  groups: [],
  currentText: null,
  loading: false,
  error: null,

  fetchTexts: async () => {
    set({ loading: true, error: null });
    try {
      const docs = await listTexts();
      set({ texts: docs, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchGroups: async () => {
    try {
      const groups = await listTextGroups();
      set({ groups });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  createGroup: async (path: string) => {
    const groups = await createTextGroup(path);
    set({ groups });
  },

  // A move rewrites many texts' paths at once, so refetch texts alongside the registry.
  moveGroup: async (src: string, dest: string) => {
    const groups = await moveTextGroup(src, dest);
    set({ groups });
    await get().fetchTexts();
  },

  // A reorder can reparent (promote a sub-group to root), rewriting texts' paths — refetch texts.
  reorderGroup: async (src: string, parent: string, beforePath: string) => {
    const groups = await reorderTextGroup(src, parent, beforePath);
    set({ groups });
    await get().fetchTexts();
  },

  deleteGroup: async (path: string) => {
    const groups = await deleteTextGroup(path);
    set({ groups });
  },

  loadText: async (id: number) => {
    set({ loading: true, error: null });
    try {
      const doc = await getText(id);
      set({ currentText: doc, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  uploadNewFile: async (file: File) => {
    set({ loading: true, error: null });
    try {
      const doc = await uploadText(file);
      await get().fetchTexts();
      set({ currentText: doc, loading: false });
      return doc.id;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  removeText: async (id: number) => {
    set({ loading: true, error: null });
    try {
      await deleteText(id);
      set(state => ({
        texts: state.texts.filter(d => d.id !== id),
        currentText: state.currentText?.id === id ? null : state.currentText,
        loading: false
      }));
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  deriveSecondary: async (parentId: number) => {
    set({ loading: true, error: null });
    try {
      const doc = await deriveText(parentId);
      await get().fetchTexts();
      set({ loading: false });
      return doc.id;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  extractSelection: async (id: number, startSylId: string, endSylId: string) => {
    set({ loading: true, error: null });
    try {
      const doc = await extractText(id, { start_syl_id: startSylId, end_syl_id: endSylId });
      await get().fetchTexts();
      // Extract adds a delete-suggestion to the source on the backend; refresh the open
      // source's suggestions so the corrected token layer re-fetches and the extracted
      // range disappears (same mechanism a normal delete-section relies on).
      if (get().currentText?.id === id) {
        await useSuggestionStore.getState().fetchSuggestions(id);
      }
      set({ loading: false });
      return doc.id;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  cloneWithEdits: async (id: number) => {
    set({ loading: true, error: null });
    try {
      const doc = await cloneText(id);
      await get().fetchTexts();
      set({ loading: false });
      return doc.id;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  updateMeta: async (id, patch) => {
    // Patch title/group in place (no full refetch, so the picker's collapse state
    // and scroll position survive an inline rename or regroup).
    const updated = await updateTextMeta(id, patch);
    set(state => ({
      texts: state.texts.map(d =>
        d.id === id ? { ...d, title: updated.title, text_group: updated.text_group } : d),
      currentText: state.currentText?.id === id
        ? { ...state.currentText, title: updated.title, text_group: updated.text_group }
        : state.currentText,
    }));
  },

  saveMainTextSrtDir: async (id: number, dir: string) => {
    const res = await setMainTextSrtDir(id, dir);
    set(state => ({
      currentText: state.currentText?.id === id
        ? { ...state.currentText, main_text_srt_dir: res.main_text_srt_dir }
        : state.currentText,
    }));
  }
}));
