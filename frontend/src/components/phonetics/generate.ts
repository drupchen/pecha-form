/**
 * Client-side phonetics generation (Phase P).
 *
 *  bo  → `tibetan-ewts-converter`'s phonetics engine (THL / Lotsawa House lineage),
 *        default style Padmakara to match the booklets' house style.
 *  skt → decode the Tibetan to EWTS (same library) then romanize deterministically
 *        (`sanskrit.ewtsToRoman`), because the phonetics engines mangle mantras.
 *
 * Both are FIRST APPROXIMATIONS the reviewer corrects.
 */
import { get_phonetics, EwtsConverter } from 'tibetan-ewts-converter';
import { ewtsToRoman, type SktLang } from './sanskrit';

export type BoStyle = 'padmakara' | 'thl' | 'lotsawahouse' | 'rigpa' | 'lhasey';
export type BoLang = 'en' | 'fr' | 'de' | 'pt' | 'es';

/** Languages each style actually supports (from the library's per-style
 *  `lang_opts`). Offering a lang a style lacks silently falls back to the
 *  style's default (e.g. Padmakara + 'de' → Portuguese), so the UI must gate
 *  the language list on the chosen style. THL and Lhasey have no real variants. */
export const STYLE_LANGS: Record<BoStyle, BoLang[]> = {
  padmakara: ['en', 'pt'],
  thl: ['en'],
  lotsawahouse: ['en', 'es', 'fr', 'de'],
  rigpa: ['en', 'es', 'fr', 'de'],
  lhasey: ['en'],
};

/**
 * The style each booklet language opens on — the built-in floor an organization can override
 * (see the phonetics settings store). Each of these is a style that actually HAS a variant for
 * its language, which is the whole point: Lotsawa House carries en/fr/de, and Padmakara is the
 * only one with Portuguese. A language with nothing of its own falls back to Padmakara, the
 * house style the booklets were set in.
 */
export const DEFAULT_BO_STYLE: Record<string, BoStyle> = {
  en: 'lotsawahouse',
  fr: 'lotsawahouse',
  de: 'lotsawahouse',
  pt: 'padmakara',
};

export const defaultBoStyle = (lang: string): BoStyle => DEFAULT_BO_STYLE[lang] ?? 'padmakara';

// Phonetics engines are stateful/heavy to build — cache one per (style, lang).
const boCache = new Map<string, any>();
function boEngine(style: BoStyle, lang: BoLang) {
  const key = `${style}:${lang}`;
  let eng = boCache.get(key);
  if (!eng) {
    eng = get_phonetics({ style, lang });
    boCache.set(key, eng);
  }
  return eng;
}

let _ewts: EwtsConverter | null = null;
const ewtsConv = () => (_ewts ??= new EwtsConverter());

/** Tibetan verse/prose line → romanized phonetics. */
export function generateBo(tibetan: string, style: BoStyle, lang: BoLang): string {
  const clean = tibetan.replace(/\n+/g, ' ').trim();
  if (!clean) return '';
  try {
    return boEngine(style, lang).phonetics(clean, { autosplit: true }).trim();
  } catch (e) {
    console.error('generateBo failed:', e);
    return '';
  }
}

/** Sanskrit mantra line → romanization via EWTS decode + deterministic mapping,
 *  in the booklet language (en/de/pt share the base; fr is rule-derived; iast is
 *  the scholarly form). A first-approximation fallback for lines the imported
 *  reviewed sheet strings don't cover. */
export function generateSkt(tibetan: string, lang: SktLang): string {
  const clean = tibetan.replace(/\n+/g, ' ').trim();
  if (!clean) return '';
  try {
    const ewts = ewtsConv().to_ewts(clean);
    return ewtsToRoman(ewts, lang);
  } catch (e) {
    console.error('generateSkt failed:', e);
    return '';
  }
}
