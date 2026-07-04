import { create } from 'zustand';
import { API_BASE } from '../api/client';
import { useUndoStore } from './useUndoStore';

export interface Tag {
  id: number;
  text_id: number;
  name: string;
  color: string;
  tag_kind: 'regular' | 'session';
  open_position: number | null;
  close_position: number | null;
}

export interface Span {
  id: number;
  text_id: number;
  tag_id: number;
  start_offset: number;
  end_offset: number;
  tag: Tag;
}

interface TagState {
  tags: Tag[];
  spans: Span[];
  loading: boolean;
  error: string | null;

  fetchTags: (textId: number) => Promise<void>;
  fetchSpans: (textId: number) => Promise<void>;
  createTag: (
    textId: number,
    name: string,
    color?: string,
    kind?: 'regular' | 'session',
    openPosition?: number,
  ) => Promise<Tag>;
  updateTag: (
    tagId: number,
    params: { name?: string; color?: string; open_position?: number | null; close_position?: number | null },
  ) => Promise<Tag>;
  deleteTag: (tagId: number) => Promise<void>;
  createSpan: (
    textId: number,
    tagId: number,
    start: number,
    end: number,
  ) => Promise<Span>;
  deleteSpan: (spanId: number) => Promise<void>;
  updateSpan: (spanId: number, tagId: number) => Promise<Span>;
}

export const useTagStore = create<TagState>((set, get) => ({
  tags: [],
  spans: [],
  loading: false,
  error: null,

  fetchTags: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/tags`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ tags: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchSpans: async (textId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/spans`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ spans: data, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  createTag: async (textId, name, color, kind = 'regular', openPosition) => {
    try {
      const body: Record<string, unknown> = { name, color, tag_kind: kind };
      if (openPosition !== undefined) body.open_position = openPosition;
      const res = await fetch(`${API_BASE}/texts/${textId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const newTag = await res.json();
      set(state => ({ tags: [...state.tags, newTag] }));
      useUndoStore.getState().push({
        description: `Add tag "${name}"`,
        undo: async () => { await get().deleteTag(newTag.id); },
      });
      return newTag;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  updateTag: async (tagId, params) => {
    const before = get().tags.find(t => t.id === tagId);
    try {
      const res = await fetch(`${API_BASE}/tags/${tagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(await res.text());
      const updatedTag: Tag = await res.json();
      set(state => ({
        tags: state.tags.map(t => t.id === tagId ? updatedTag : t),
        spans: state.spans.map(s => s.tag_id === tagId ? { ...s, tag: updatedTag } : s),
      }));
      if (before) {
        useUndoStore.getState().push({
          description: `Edit tag "${before.name}"`,
          undo: async () => {
            await get().updateTag(tagId, {
              name: before.name,
              color: before.color,
              open_position: before.open_position,
              close_position: before.close_position,
            });
          },
        });
      }
      return updatedTag;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  deleteTag: async (tagId) => {
    const before = get().tags.find(t => t.id === tagId);
    const beforeSpans = get().spans.filter(s => s.tag_id === tagId);
    try {
      const res = await fetch(`${API_BASE}/tags/${tagId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      set(state => ({
        tags: state.tags.filter(t => t.id !== tagId),
        spans: state.spans.filter(s => s.tag_id !== tagId),
      }));
      if (before) {
        useUndoStore.getState().push({
          description: `Delete tag "${before.name}"`,
          undo: async () => {
            // Recreate the tag (gets a fresh id), then recreate each span.
            const recreated = await get().createTag(
              before.text_id,
              before.name,
              before.color,
              before.tag_kind,
              before.open_position ?? undefined,
            );
            // Session tags also need close_position restored.
            if (before.close_position != null) {
              await get().updateTag(recreated.id, { close_position: before.close_position });
            }
            for (const s of beforeSpans) {
              await get().createSpan(before.text_id, recreated.id, s.start_offset, s.end_offset);
            }
          },
        });
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  createSpan: async (textId, tagId, start, end) => {
    try {
      const res = await fetch(`${API_BASE}/texts/${textId}/spans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: tagId, start_offset: start, end_offset: end }),
      });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).detail?.error || msg; } catch {}
        throw new Error(msg);
      }
      const span: Span = await res.json();
      set(state => ({
        spans: [...state.spans, span].sort((a, b) => a.start_offset - b.start_offset),
      }));
      useUndoStore.getState().push({
        description: `Tag selection (${span.tag.name})`,
        undo: async () => { await get().deleteSpan(span.id); },
      });
      return span;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  deleteSpan: async (spanId) => {
    const before = get().spans.find(s => s.id === spanId);
    try {
      const res = await fetch(`${API_BASE}/spans/${spanId}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      set(state => ({ spans: state.spans.filter(s => s.id !== spanId) }));
      if (before) {
        useUndoStore.getState().push({
          description: `Remove tag (${before.tag.name})`,
          undo: async () => {
            await get().createSpan(before.text_id, before.tag_id, before.start_offset, before.end_offset);
          },
        });
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  updateSpan: async (spanId, tagId) => {
    const before = get().spans.find(s => s.id === spanId);
    try {
      const res = await fetch(`${API_BASE}/spans/${spanId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: tagId }),
      });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).detail || msg; } catch {}
        throw new Error(msg);
      }
      const updated: Span = await res.json();
      set(state => ({
        spans: state.spans.map(s => s.id === spanId ? updated : s),
      }));
      if (before) {
        useUndoStore.getState().push({
          description: `Change tag`,
          undo: async () => { await get().updateSpan(spanId, before.tag_id); },
        });
      }
      return updated;
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },
}));

// ─── Selectors ───────────────────────────────────────────────────────────────

export const selectRegularTags = (state: TagState) =>
  state.tags.filter(t => t.tag_kind === 'regular');
export const selectSessionTags = (state: TagState) =>
  state.tags
    .filter(t => t.tag_kind === 'session')
    // Natural order: A1, A2, …, A9, A10, … then B1, B2, … (not lexicographic).
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
