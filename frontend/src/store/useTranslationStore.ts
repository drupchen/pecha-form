import { create } from 'zustand';
import {
  getLanguages, getTextTranslations, upsertTranslation, setChunkLevel, setChunkRenderAs,
  getOverrides, putOverride, ackOverride, deleteOverride,
  getSeen, markSeen as apiMarkSeen,
  getSuggestions, createSuggestion, resolveSuggestion,
  getLayouts, createLayout, patchLayout, deleteLayout, putLayoutTitle,
  type Language, type TranslationChunk, type TranslationOverride,
  type TranslationSuggestion, type ChunkLayout,
} from '../api/client';
import { useUndoStore } from './useUndoStore';

/**
 * Canonical translations for the current text (Phase T1) plus the Phase T2
 * collaboration state: booklet-local overrides, seen watermarks (update
 * notifications), upstream suggestions, and the scramble layouts (moves +
 * synthetic title chunks). Server chunks are anchored at their ORIGIN text and
 * apply here because this text's stream contains (part of) them.
 */
interface TranslationState {
  languages: Language[];
  chunks: TranslationChunk[];
  overrides: TranslationOverride[];
  seen: Map<string, string>;          // `${chunkId}:${lang}` -> seen_updated_at
  suggestions: TranslationSuggestion[];
  layouts: ChunkLayout[];
  textId: number | null;
  /** Bumped whenever a heading's label, level, or existence changes (translation body,
   *  chunk level, or a title layout). The booklet preview + PDF navigation derive from the
   *  translation pane, so they watch this to re-compile as headings are curated. */
  version: number;
  fetchLanguages: () => Promise<void>;
  fetchChunks: (textId: number) => Promise<void>;
  fetchCollab: (textId: number) => Promise<void>;
  save: (args: {
    contextTextId: number; startSylId: string; endSylId: string;
    lang: string; body: string; status?: 'draft' | 'final';
    translatedFrom?: string | null;
  }) => Promise<void>;
  setLevel: (args: {
    contextTextId: number; startSylId: string; endSylId: string; level: number | null;
  }) => Promise<void>;
  setRenderAs: (args: {
    contextTextId: number; startSylId: string; endSylId: string; renderAs: string | null;
  }) => Promise<void>;
  // T2 — overrides
  saveOverride: (textId: number, chunkId: number, lang: string, body: string) => Promise<void>;
  revertOverride: (textId: number, chunkId: number, lang: string) => Promise<void>;
  acknowledgeBase: (textId: number, chunkId: number, lang: string) => Promise<void>;
  // T2 — watermarks
  markSeen: (textId: number, chunkId: number, lang: string, seenUpdatedAt: string) => Promise<void>;
  // T2 — suggestions
  suggestUpstream: (chunkId: number, lang: string, body: string, fromTextId: number) => Promise<void>;
  resolve: (id: number, accept: boolean, textId: number) => Promise<void>;
  // T2 — scramble layouts
  addMove: (args: {
    textId: number | null; srcStart: string; srcEnd: string; anchor: string | null;
    mode: 'inline' | 'segment'; anchorAfter?: boolean; lang?: string | null;
  }) => Promise<void>;
  addTitle: (args: { textId: number | null; anchor: string | null; level: number }) => Promise<void>;
  setTitleBody: (layoutId: number, lang: string, body: string) => Promise<void>;
  setTitleLevel: (layoutId: number, level: number) => Promise<void>;
  setTitleRenderAs: (layoutId: number, renderAs: string | null) => Promise<void>;
  removeLayout: (layoutId: number) => Promise<void>;
}

export const rangeKey = (start: string, end: string) => `${start}-${end}`;
export const ovKey = (chunkId: number, lang: string) => `${chunkId}:${lang}`;

export const useTranslationStore = create<TranslationState>((set, get) => ({
  languages: [],
  chunks: [],
  overrides: [],
  seen: new Map(),
  suggestions: [],
  layouts: [],
  textId: null,
  version: 0,

  fetchLanguages: async () => {
    try {
      set({ languages: await getLanguages() });
    } catch (e: any) {
      console.error('fetchLanguages failed:', e.message);
    }
  },

  fetchChunks: async (textId) => {
    try {
      const chunks = await getTextTranslations(textId);
      set({ chunks, textId });
    } catch (e: any) {
      console.error('fetchChunks failed:', e.message);
    }
  },

  fetchCollab: async (textId) => {
    try {
      const [overrides, seenRows, suggestions, layouts] = await Promise.all([
        getOverrides(textId), getSeen(textId), getSuggestions(textId), getLayouts(textId),
      ]);
      set({
        overrides, suggestions, layouts,
        seen: new Map(seenRows.map(r => [ovKey(r.chunk_id, r.lang), r.seen_updated_at])),
      });
    } catch (e: any) {
      console.error('fetchCollab failed:', e.message);
    }
  },

  save: async ({ contextTextId, startSylId, endSylId, lang, body, status, translatedFrom }) => {
    const updated = await upsertTranslation({
      context_text_id: contextTextId,
      start_syl_id: startSylId,
      end_syl_id: endSylId,
      lang, body,
      status: status ?? 'draft',
      translated_from: translatedFrom ?? null,
    });
    set(s => ({
      chunks: [...s.chunks.filter(c => c.id !== updated.id
        && rangeKey(c.start_syl_id, c.end_syl_id) !== rangeKey(startSylId, endSylId)), updated],
      version: s.version + 1,
    }));
  },

  setLevel: async ({ contextTextId, startSylId, endSylId, level }) => {
    const updated = await setChunkLevel({
      context_text_id: contextTextId,
      start_syl_id: startSylId,
      end_syl_id: endSylId,
      level,
    });
    set(s => ({
      chunks: [...s.chunks.filter(c => c.id !== updated.id
        && rangeKey(c.start_syl_id, c.end_syl_id) !== rangeKey(startSylId, endSylId)), updated],
      version: s.version + 1,
    }));
  },

  setRenderAs: async ({ contextTextId, startSylId, endSylId, renderAs }) => {
    const updated = await setChunkRenderAs({
      context_text_id: contextTextId,
      start_syl_id: startSylId,
      end_syl_id: endSylId,
      render_as: renderAs,
    });
    set(s => ({
      chunks: [...s.chunks.filter(c => c.id !== updated.id
        && rangeKey(c.start_syl_id, c.end_syl_id) !== rangeKey(startSylId, endSylId)), updated],
      version: s.version + 1,
    }));
  },

  saveOverride: async (textId, chunkId, lang, body) => {
    const row = await putOverride(textId, { chunk_id: chunkId, lang, body });
    set(s => ({
      overrides: [...s.overrides.filter(o => ovKey(o.chunk_id, o.lang) !== ovKey(chunkId, lang)), row],
    }));
  },

  revertOverride: async (textId, chunkId, lang) => {
    await deleteOverride(textId, chunkId, lang);
    set(s => ({
      overrides: s.overrides.filter(o => ovKey(o.chunk_id, o.lang) !== ovKey(chunkId, lang)),
    }));
  },

  acknowledgeBase: async (textId, chunkId, lang) => {
    const row = await ackOverride(textId, { chunk_id: chunkId, lang });
    set(s => ({
      overrides: [...s.overrides.filter(o => ovKey(o.chunk_id, o.lang) !== ovKey(chunkId, lang)), row],
    }));
  },

  markSeen: async (textId, chunkId, lang, seenUpdatedAt) => {
    await apiMarkSeen(textId, { chunk_id: chunkId, lang, seen_updated_at: seenUpdatedAt });
    set(s => {
      const seen = new Map(s.seen);
      seen.set(ovKey(chunkId, lang), seenUpdatedAt);
      return { seen };
    });
  },

  suggestUpstream: async (chunkId, lang, body, fromTextId) => {
    const row = await createSuggestion({ chunk_id: chunkId, lang, body, from_text_id: fromTextId });
    set(s => ({ suggestions: [...s.suggestions, row] }));
  },

  resolve: async (id, accept, textId) => {
    await resolveSuggestion(id, accept);
    set(s => ({ suggestions: s.suggestions.filter(x => x.id !== id) }));
    // Accepting rewrites the canonical body → refresh chunks.
    if (accept) { await get().fetchChunks(textId); set(st => ({ version: st.version + 1 })); }
  },

  addMove: async ({ textId, srcStart, srcEnd, anchor, mode, anchorAfter, lang }) => {
    const row = await createLayout({
      text_id: textId, kind: 'move',
      src_start_syl_id: srcStart, src_end_syl_id: srcEnd, anchor_syl_id: anchor,
      move_mode: mode, anchor_after: !!anchorAfter, lang: lang ?? null,
    });
    set(s => ({ layouts: [...s.layouts, row] }));
    // A move (a run or a syllable range relocated) is undoable from the navbar Undo button:
    // undo simply removes the layout row, and the bench re-derives without it.
    useUndoStore.getState().push({
      description: 'Relocate run',
      undo: async () => { await get().removeLayout(row.id); },
    });
  },

  addTitle: async ({ textId, anchor, level }) => {
    const row = await createLayout({
      text_id: textId, kind: 'title', anchor_syl_id: anchor, level,
    });
    set(s => ({ layouts: [...s.layouts, row], version: s.version + 1 }));
  },

  setTitleBody: async (layoutId, lang, body) => {
    const row = await putLayoutTitle(layoutId, { lang, body });
    set(s => ({ layouts: s.layouts.map(l => l.id === layoutId ? row : l), version: s.version + 1 }));
  },

  setTitleLevel: async (layoutId, level) => {
    const row = await patchLayout(layoutId, { level });
    set(s => ({ layouts: s.layouts.map(l => l.id === layoutId ? row : l), version: s.version + 1 }));
  },

  setTitleRenderAs: async (layoutId, renderAs) => {
    const row = await patchLayout(layoutId, { render_as: renderAs });
    set(s => ({ layouts: s.layouts.map(l => l.id === layoutId ? row : l), version: s.version + 1 }));
  },

  removeLayout: async (layoutId) => {
    await deleteLayout(layoutId);
    set(s => ({ layouts: s.layouts.filter(l => l.id !== layoutId), version: s.version + 1 }));
  },
}));
