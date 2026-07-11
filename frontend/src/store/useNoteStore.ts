import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { useUndoStore } from './useUndoStore';

export interface NoteCategory {
  id: number;
  text_id: number;
  name: string;
}

export interface Note {
  id: number;
  text_id: number;
  category_id: number | null;
  category_name: string | null;
  start_offset: number;
  end_offset: number;
  body: string;
  created_at: string;
  updated_at: string;
  /** Session tags this note is explicitly linked to. */
  session_tag_ids: number[];
  session_tag_names: string[];
  /** Set = a note ON that passage occurrence (renders only inside the passage run,
   *  never at the source occurrence of the shared syllables). */
  passage_id: number | null;
}

interface NoteState {
  notes: Note[];
  categories: NoteCategory[];
  loading: boolean;
  error: string | null;

  fetchNotes: (textId: number) => Promise<void>;
  fetchCategories: (textId: number) => Promise<void>;
  createCategory: (textId: number, name: string) => Promise<NoteCategory>;
  deleteCategory: (categoryId: number) => Promise<void>;
  createNote: (
    textId: number,
    categoryId: number | null,
    start: number,
    end: number,
    body: string,
    sessionTagIds?: number[],
    passageId?: number | null,
  ) => Promise<Note>;
  updateNote: (
    noteId: number,
    params: { category_id?: number | null; body?: string; session_tag_ids?: number[] },
  ) => Promise<void>;
  deleteNote: (noteId: number) => Promise<void>;
}

export const useNoteStore = create<NoteState>((set, get) => ({
  notes: [],
  categories: [],
  loading: false,
  error: null,

  fetchNotes: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/notes`);
      if (!res.ok) throw new Error(await res.text());
      const data: Note[] = await res.json();
      set({ notes: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchCategories: async (textId) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/note-categories`);
      if (!res.ok) throw new Error(await res.text());
      const data: NoteCategory[] = await res.json();
      set({ categories: data });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  createCategory: async (textId, name) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/note-categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      const newCat: NoteCategory = await res.json();
      set(state => ({ categories: [...state.categories, newCat] }));
      return newCat;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  deleteCategory: async (categoryId) => {
    try {
      const res = await fetch(`${API_BASE}/note-categories/${categoryId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({
        categories: state.categories.filter(c => c.id !== categoryId),
        // Notes that referenced this category are now uncategorized server-side.
        notes: state.notes.map(n =>
          n.category_id === categoryId ? { ...n, category_id: null, category_name: null } : n,
        ),
      }));
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  createNote: async (textId, categoryId, start_offset, end_offset, body, sessionTagIds = [], passageId = null) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_id: categoryId,
          start_offset,
          end_offset,
          body,
          session_tag_ids: sessionTagIds,
          passage_id: passageId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const newNote: Note = await res.json();
      set(state => ({ notes: [...state.notes, newNote] }));
      useUndoStore.getState().push({
        description: 'Add note',
        undo: async () => { await get().deleteNote(newNote.id); },
      });
      return newNote;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  updateNote: async (noteId, params) => {
    const before = get().notes.find(n => n.id === noteId);
    try {
      const res = await fetch(`${API_BASE}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated: Note = await res.json();
      set(state => ({ notes: state.notes.map(n => n.id === noteId ? updated : n) }));
      if (before) {
        useUndoStore.getState().push({
          description: 'Edit note',
          undo: async () => {
            await get().updateNote(noteId, {
              category_id: before.category_id,
              body: before.body,
              session_tag_ids: before.session_tag_ids,
            });
          },
        });
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  deleteNote: async (noteId) => {
    const before = get().notes.find(n => n.id === noteId);
    try {
      const res = await fetch(`${API_BASE}/notes/${noteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({ notes: state.notes.filter(n => n.id !== noteId) }));
      if (before) {
        useUndoStore.getState().push({
          description: 'Remove note',
          undo: async () => {
            await get().createNote(
              before.text_id,
              before.category_id,
              before.start_offset,
              before.end_offset,
              before.body,
              before.session_tag_ids,
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
