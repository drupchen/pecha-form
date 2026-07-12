import { create } from 'zustand';
import {
  getPhonetics, putPhonetic, deletePhonetic, type Phonetic,
} from '../api/client';

/**
 * Phonetics for the current document (Phase P), scoped to ONE language at a time.
 * Rows are anchored at their ORIGIN text and apply here because this document's
 * stream contains (part of) them — so a row authored in any other document that
 * includes the same primary/secondary shows up live. The booklets ship distinct
 * phonetics per language (skt fr "Houng" vs en "Hung"), so the store refetches on
 * a language change. Keyed by `${kind}:${start}-${end}` within the current lang.
 */
export const phonKey = (kind: string, start: string, end: string) =>
  `${kind}:${start}-${end}`;

interface PhoneticsState {
  rows: Phonetic[];
  textId: number | null;
  lang: string;
  fetchPhonetics: (textId: number, lang: string) => Promise<void>;
  save: (args: {
    contextTextId: number; startSylId: string; endSylId: string;
    kind: 'bo' | 'skt'; lang: string; body: string;
    status: 'auto' | 'edited' | 'reviewed';
  }) => Promise<void>;
  remove: (args: {
    contextTextId: number; startSylId: string; endSylId: string;
    kind: 'bo' | 'skt'; lang: string;
  }) => Promise<void>;
}

export const usePhoneticsStore = create<PhoneticsState>((set, get) => ({
  rows: [],
  textId: null,
  lang: 'en',

  fetchPhonetics: async (textId, lang) => {
    try {
      const rows = await getPhonetics(textId, lang);
      set({ rows, textId, lang });
    } catch (e: any) {
      console.error('fetchPhonetics failed:', e.message);
    }
  },

  save: async ({ contextTextId, startSylId, endSylId, kind, lang, body, status }) => {
    const updated = await putPhonetic({
      context_text_id: contextTextId,
      start_syl_id: startSylId, end_syl_id: endSylId,
      kind, lang, body, status,
    });
    // Ignore a response for a language we're no longer viewing (racey switches).
    if (lang !== get().lang) return;
    set(s => ({
      rows: [
        ...s.rows.filter(r => !(r.kind === kind
          && r.start_syl_id === startSylId && r.end_syl_id === endSylId)),
        updated,
      ],
    }));
  },

  remove: async ({ contextTextId, startSylId, endSylId, kind, lang }) => {
    await deletePhonetic({
      context_text_id: contextTextId,
      start_syl_id: startSylId, end_syl_id: endSylId, kind, lang,
    });
    if (lang !== get().lang) return;
    set(s => ({
      rows: s.rows.filter(r => !(r.kind === kind
        && r.start_syl_id === startSylId && r.end_syl_id === endSylId)),
    }));
  },
}));
