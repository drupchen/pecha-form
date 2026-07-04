import { create } from 'zustand';
import { listTexts, getText, uploadText, deleteText, importCherrytree, setMainTextSrtDir, deriveText, extractText, cloneText } from '../api/client';

export type TextType = 'primary' | 'secondary';

export interface TextInfo {
  id: number;
  filename: string;
  title: string;
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
  currentText: TextDetail | null;
  loading: boolean;
  error: string | null;

  fetchTexts: () => Promise<void>;
  loadText: (id: number) => Promise<void>;
  uploadNewFile: (file: File) => Promise<number>;
  importCherrytreeFile: (file: File) => Promise<number>;
  removeText: (id: number) => Promise<void>;
  deriveSecondary: (parentId: number) => Promise<number>;
  extractSelection: (id: number, startSylId: string, endSylId: string) => Promise<number>;
  cloneWithEdits: (id: number) => Promise<number>;
  saveMainTextSrtDir: (id: number, dir: string) => Promise<void>;
}

export const useTextStore = create<TextState>((set, get) => ({
  texts: [],
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

  importCherrytreeFile: async (file: File) => {
    set({ loading: true, error: null });
    try {
      const doc = await importCherrytree(file);
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

  saveMainTextSrtDir: async (id: number, dir: string) => {
    const res = await setMainTextSrtDir(id, dir);
    set(state => ({
      currentText: state.currentText?.id === id
        ? { ...state.currentText, main_text_srt_dir: res.main_text_srt_dir }
        : state.currentText,
    }));
  }
}));
