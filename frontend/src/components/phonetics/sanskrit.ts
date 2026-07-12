/**
 * EWTS-Sanskrit → romanization (Phase P, mantra generation), language-aware.
 *
 * The phonetics engines mangle mantras (they read Sanskrit stacks as Tibetan), so
 * we decode the Tibetan to EWTS with the library's `EwtsConverter.to_ewts` and
 * romanize the EWTS deterministically here. It is a FIRST APPROXIMATION the reviewer
 * corrects — and only a FALLBACK: the booklets' human-reviewed per-language strings
 * are imported, so generation only fills lines the sheets don't cover.
 *
 * Empirically (see the plan), the four booklet languages collapse to two Sanskrit
 * transcriptions: an English base shared by en/de/pt, and French (systematic
 * `u→ou`, `j→dj`, stressed `e→é`, Tibetanized words: Houng, Gourou, Djana, Péma).
 * So the base is the Tibetanized-chant English form (Benza, Pema, Soha, aspiration
 * kept), and `fr` is derived from it by rule. `iast` stays available as a scholarly
 * mode.
 *
 * EWTS notation reminders: `+` joins a stack (pad+ma = padma); capitals are the
 * long vowels / retroflexes / anusvāra-visarga (A/I/U = ā/ī/ū, T/Th/D/Dh/N =
 * ṭ/ṭh/ḍ/ḍh/ṇ, Sh = ṣ, M = ṃ, H = ḥ, ~M = candrabindu nasal); `dz` = ja.
 */

export type SktLang = 'en' | 'fr' | 'de' | 'pt' | 'iast';

/** EWTS unit → [iast, base]. Longest keys matched first (greedy). The base keeps
 *  aspiration (bh/dh/gh/jh) to match the booklets' English Sanskrit column. */
const UNIT: Record<string, [string, string]> = {
  '~M': ['ṃ', 'm'], "M": ['ṃ', 'm'], "H": ['ḥ', 'h'],
  'tsh': ['tsh', 'ts'], 'ts': ['ts', 'ts'], 'dz': ['j', 'dz'],
  'Th': ['ṭh', 'th'], 'Dh': ['ḍh', 'dh'], 'Sh': ['ṣ', 'sh'],
  'kh': ['kh', 'kh'], 'gh': ['gh', 'gh'], 'ng': ['ṅ', 'ng'],
  'ch': ['ch', 'ch'], 'jh': ['jh', 'jh'], 'ny': ['ñ', 'ny'],
  'th': ['th', 'th'], 'dh': ['dh', 'dh'], 'ph': ['ph', 'ph'], 'bh': ['bh', 'bh'],
  'sh': ['ś', 'sh'],
  'T': ['ṭ', 't'], 'D': ['ḍ', 'd'], 'N': ['ṇ', 'n'],
  'A': ['ā', 'a'], 'I': ['ī', 'i'], 'U': ['ū', 'u'],
  'k': ['k', 'k'], 'g': ['g', 'g'], 'c': ['c', 'ch'], 'j': ['j', 'j'],
  't': ['t', 't'], 'd': ['d', 'd'], 'n': ['n', 'n'],
  'p': ['p', 'p'], 'b': ['b', 'b'], 'm': ['m', 'm'],
  'y': ['y', 'y'], 'r': ['r', 'r'], 'l': ['l', 'l'], 'w': ['v', 'w'], 'v': ['v', 'w'],
  's': ['s', 's'], 'h': ['h', 'h'],
  'a': ['a', 'a'], 'i': ['i', 'i'], 'u': ['u', 'u'], 'e': ['e', 'e'], 'o': ['o', 'o'],
};
const UNIT_KEYS = Object.keys(UNIT).sort((a, b) => b.length - a.length);

/** Whole-token overrides keyed by the `+`-stripped lowercased EWTS token, in the
 *  Tibetanized chant convention the booklets use. [iast, base]. */
const WORD: Record<string, [string, string]> = {
  'om': ['oṃ', 'Om'],
  'ah': ['āḥ', 'Ah'],
  'hu~m': ['hūṃ', 'Hung'], 'hum': ['hūṃ', 'Hung'],
  'ahhu~m': ['āḥ hūṃ', 'Ah Hung'],
  'badzra': ['vajra', 'Benza'], 'badza': ['vajra', 'Benza'],
  'padma': ['padma', 'Pema'], 'padme': ['padme', 'Peme'],
  'siddhi': ['siddhi', 'Siddhi'],
  'phat': ['phaṭ', 'Phet'],
  'swaha': ['svāhā', 'Soha'], 'svaha': ['svāhā', 'Soha'],
  'mani': ['maṇi', 'Mani'], 'guru': ['guru', 'Guru'],
};

const isIast = (l: SktLang) => l === 'iast';
const idx = (l: SktLang) => (isIast(l) ? 0 : 1);

function translitToken(tok: string, lang: SktLang): string {
  const joined = tok.replace(/\+/g, '');
  const core = joined.replace(/^[^A-Za-z~]+|[^A-Za-z~]+$/g, '');
  if (!core) return '';
  const wordHit = WORD[core.toLowerCase()];
  if (wordHit) return wordHit[idx(lang)];
  let out = '';
  let i = 0;
  while (i < core.length) {
    const key = UNIT_KEYS.find(k => core.startsWith(k, i));
    if (key) { out += UNIT[key][idx(lang)]; i += key.length; }
    else { out += core[i]; i += 1; }
  }
  if (!isIast(lang) && out) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

/** French word overrides (applied whole-token, before the general rules). */
const FR_WORD: Record<string, string> = {
  Hung: 'Houng', Guru: 'Gourou', Pema: 'Péma', Peme: 'Pémé',
  Soha: 'Soha', Benza: 'Benza', Om: 'Om', Ah: 'Ah', Mani: 'Mani',
  Jyana: 'Djana', Puja: 'Pudja', Maha: 'Maha',
};

/** Turn a base (English) Sanskrit token into its French approximation: the
 *  systematic booklet rules `u→ou`, `j→dj`, stressed final `e→é`. Deterministic
 *  first approximation — the imported reviewed strings are exact; this only fills
 *  uncovered lines. */
function frenchifyToken(t: string): string {
  if (FR_WORD[t]) return FR_WORD[t];
  let s = t;
  s = s.replace(/j/g, 'dj').replace(/J/g, 'Dj');   // j → dj
  s = s.replace(/u/g, 'ou').replace(/U/g, 'Ou');   // u → ou
  s = s.replace(/e\b/g, 'é');                       // final e → é
  return s;
}

const frenchify = (base: string) =>
  base.split(/\s+/).map(frenchifyToken).filter(Boolean).join(' ');

/** Romanize a full EWTS string (space-separated tsekbar tokens) for a language. */
export function ewtsToRoman(ewts: string, lang: SktLang): string {
  const tokens = ewts.split(/\s+/).map(t => translitToken(t, lang === 'fr' ? 'en' : lang));
  const base = tokens.filter(Boolean).join(' ');
  return lang === 'fr' ? frenchify(base) : base;
}
