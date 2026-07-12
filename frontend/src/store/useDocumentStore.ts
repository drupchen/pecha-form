import { create } from 'zustand';
import {
  getDocuments, createDocument, getDocument, renameDocument, deleteDocument,
  addDocumentItem, deleteDocumentItem, reorderDocumentItems,
  setDocumentLanguages, getDocumentToc,
  type DocumentSummary, type DocumentDetail, type DocumentItemKind, type TocEntry,
} from '../api/client';

/**
 * Documents (Phase D1): the booklet composition state. `list` is the left rail;
 * `current` + `toc` back the editor. Actions refetch the affected pieces so the
 * item list, languages, and TOC stay consistent (D1 favours correctness over
 * optimistic churn — the payloads are small).
 */
interface DocumentState {
  list: DocumentSummary[];
  current: DocumentDetail | null;
  toc: TocEntry[];
  error: string | null;

  fetchList: () => Promise<void>;
  open: (id: number) => Promise<void>;
  create: (title: string) => Promise<number | null>;
  rename: (id: number, title: string) => Promise<void>;
  remove: (id: number) => Promise<void>;

  addItem: (kind: DocumentItemKind, textId?: number | null) => Promise<void>;
  removeItem: (itemId: number) => Promise<void>;
  reorder: (orderedIds: number[]) => Promise<void>;
  moveItem: (itemId: number, dir: -1 | 1) => Promise<void>;
  setLanguages: (langs: string[]) => Promise<void>;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  list: [],
  current: null,
  toc: [],
  error: null,

  fetchList: async () => {
    try { set({ list: await getDocuments(), error: null }); }
    catch (e: any) { set({ error: e.message }); }
  },

  open: async (id) => {
    try {
      const [current, toc] = await Promise.all([getDocument(id), getDocumentToc(id)]);
      set({ current, toc, error: null });
    } catch (e: any) { set({ error: e.message }); }
  },

  create: async (title) => {
    try {
      const doc = await createDocument(title);
      await get().fetchList();
      await get().open(doc.id);
      return doc.id;
    } catch (e: any) { set({ error: e.message }); return null; }
  },

  rename: async (id, title) => {
    try {
      await renameDocument(id, title);
      await get().fetchList();
      if (get().current?.id === id) await get().open(id);
    } catch (e: any) { set({ error: e.message }); }
  },

  remove: async (id) => {
    try {
      await deleteDocument(id);
      if (get().current?.id === id) set({ current: null, toc: [] });
      await get().fetchList();
    } catch (e: any) { set({ error: e.message }); }
  },

  addItem: async (kind, textId) => {
    const id = get().current?.id;
    if (id == null) return;
    try {
      await addDocumentItem(id, { kind, text_id: kind === 'text' ? textId : undefined });
      await get().open(id);
      await get().fetchList();
    } catch (e: any) { set({ error: e.message }); }
  },

  removeItem: async (itemId) => {
    const id = get().current?.id;
    if (id == null) return;
    try {
      await deleteDocumentItem(itemId);
      await get().open(id);
      await get().fetchList();
    } catch (e: any) { set({ error: e.message }); }
  },

  reorder: async (orderedIds) => {
    const id = get().current?.id;
    if (id == null) return;
    try {
      await reorderDocumentItems(id, orderedIds);
      await get().open(id);
    } catch (e: any) { set({ error: e.message }); }
  },

  moveItem: async (itemId, dir) => {
    const cur = get().current;
    if (!cur) return;
    const ids = cur.items.map(i => i.id);
    const idx = ids.indexOf(itemId);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    await get().reorder(ids);
  },

  setLanguages: async (langs) => {
    const id = get().current?.id;
    if (id == null) return;
    try {
      await setDocumentLanguages(id, langs);
      await get().open(id);
      await get().fetchList();
    } catch (e: any) { set({ error: e.message }); }
  },
}));
