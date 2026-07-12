import { create } from 'zustand';
import {
  getLanguages, getTextTranslations, upsertTranslation, setChunkLevel,
  type Language, type TranslationChunk,
} from '../api/client';

/**
 * Canonical translations for the current text (Phase T1). Server chunks are
 * anchored at their ORIGIN text and apply here because this text's stream
 * contains (part of) them — "translate once, ripple everywhere". Keyed by the
 * chunk's (start,end) syllable range for matching against derived units.
 */
interface TranslationState {
  languages: Language[];
  chunks: TranslationChunk[];
  textId: number | null;
  fetchLanguages: () => Promise<void>;
  fetchChunks: (textId: number) => Promise<void>;
  /** Upsert one translation; optimistic, keyed by the unit's syllable range. */
  save: (args: {
    contextTextId: number; startSylId: string; endSylId: string;
    lang: string; body: string; status?: 'draft' | 'final';
    translatedFrom?: string | null;
  }) => Promise<void>;
  /** Set/clear a chunk's title level (whole chunk, language-independent). */
  setLevel: (args: {
    contextTextId: number; startSylId: string; endSylId: string; level: number | null;
  }) => Promise<void>;
}

export const rangeKey = (start: string, end: string) => `${start}-${end}`;

export const useTranslationStore = create<TranslationState>((set, get) => ({
  languages: [],
  chunks: [],
  textId: null,

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

  save: async ({ contextTextId, startSylId, endSylId, lang, body, status, translatedFrom }) => {
    try {
      const updated = await upsertTranslation({
        context_text_id: contextTextId,
        start_syl_id: startSylId,
        end_syl_id: endSylId,
        lang, body,
        status: status ?? 'draft',
        translated_from: translatedFrom ?? null,
      });
      set(s => {
        const others = s.chunks.filter(c => c.id !== updated.id
          && rangeKey(c.start_syl_id, c.end_syl_id) !== rangeKey(startSylId, endSylId));
        return { chunks: [...others, updated] };
      });
    } catch (e: any) {
      console.error('save translation failed:', e.message);
      throw e;
    }
  },

  setLevel: async ({ contextTextId, startSylId, endSylId, level }) => {
    try {
      const updated = await setChunkLevel({
        context_text_id: contextTextId,
        start_syl_id: startSylId,
        end_syl_id: endSylId,
        level,
      });
      set(s => {
        const others = s.chunks.filter(c => c.id !== updated.id
          && rangeKey(c.start_syl_id, c.end_syl_id) !== rangeKey(startSylId, endSylId));
        return { chunks: [...others, updated] };
      });
    } catch (e: any) {
      console.error('setLevel failed:', e.message);
      throw e;
    }
  },
}));
