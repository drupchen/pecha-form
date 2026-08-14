/**
 * Per-language replacement rules for generated phonetics.
 *
 * Generation is a first approximation, and the corrections a reviewer makes are mostly the
 * same house spellings over and over. These rules apply them automatically, in order, to
 * every string the generator produces — before it is stored, so the bench, the booklet and
 * the PDF all read the same text.
 *
 * The French Sanskrit conventions USED TO LIVE IN THE CODE (`sanskrit.ts`'s `FR_WORD` map and
 * `frenchifyToken`): a translator who disagreed with "Pudja" had no way to change it. They are
 * now the built-in defaults below — visible in the popup, and editable like any other rule.
 */

export interface PhoneticRule {
  /** What to look for: a literal string, or a regular expression when `regex`. */
  find: string;
  /** What to put in its place. A regex rule may use `$1`. */
  replace: string;
  regex: boolean;
  /** Free text — why this rule exists. Never applied. */
  note: string;
}

export const emptyRule = (): PhoneticRule => ({ find: '', replace: '', regex: false, note: '' });

/** A rule ready to run, or the reason it cannot. A half-typed regex is a normal state of the
 *  editor, so it must be a value the caller can render — never a thrown error. */
export function compileRule(rule: PhoneticRule): { re: RegExp } | { error: string } {
  if (!rule.find) return { error: 'nothing to find' };
  if (!rule.regex) return { re: new RegExp(escapeLiteral(rule.find), 'g') };
  try {
    return { re: new RegExp(rule.find, 'g') };
  } catch (e: any) {
    return { error: e?.message ?? 'invalid regular expression' };
  }
}

/** Escape a literal so a string rule means exactly its characters — a reviewer typing `(a)`
 *  wants those three characters, not a capture group. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run the rules over a generated string, TOP TO BOTTOM — the order in the table IS the order
 * of application, so a later rule sees what the earlier ones produced. Each rule replaces
 * every occurrence.
 *
 * A rule that cannot compile is SKIPPED, not fatal: a broken regex left in the table must
 * never stop the bench from generating.
 */
export function applyPhoneticRules(text: string, rules: readonly PhoneticRule[]): string {
  let out = text;
  for (const rule of rules) {
    const c = compileRule(rule);
    if ('error' in c) continue;
    // `replace` is used verbatim: `$1` in a regex rule is the point of having regex rules.
    out = out.replace(c.re, rule.replace);
  }
  return out;
}

const r = (find: string, replace: string, note = ''): PhoneticRule =>
  ({ find, replace, regex: true, note });
const s = (find: string, replace: string, note = ''): PhoneticRule =>
  ({ find, replace, regex: false, note });

/**
 * The built-in floor, returned whenever an organization has stored no list of its own (the
 * same arrangement as `ORG_BASE` for styles). Saving a list replaces these wholesale.
 *
 * `skt`/`fr` reproduces what `frenchifyToken` did, reordered for a flat list: the systematic
 * rules first, then the word fixes that correct their output. Hung→Houng and Guru→Gourou need
 * no rule of their own — `u → ou` already produces them — and Om, Ah, Mani, Maha, Soha and
 * Benza come through every rule untouched, which is why the old code's identity entries for
 * them are gone.
 */
export const DEFAULT_PHONETIC_RULES: Record<string, PhoneticRule[]> = {
  'skt:fr': [
    r('j', 'dj', 'systematic French form'),
    r('J', 'Dj', 'systematic French form'),
    r('u', 'ou', 'systematic French form'),
    r('U', 'Ou', 'systematic French form'),
    r('e\\b', 'é', 'stressed final e'),
    s('Poudja', 'Pudja', 'exception to u → ou'),
    s('Djyana', 'Djana', 'exception to j → dj'),
    s('Pema', 'Péma'),
    s('Pemé', 'Pémé'),
  ],
};

export const ruleListKey = (kind: string, lang: string) => `${kind}:${lang}`;

/** The list to apply for one (kind, language), falling back to the built-in floor. */
export function defaultRulesFor(kind: string, lang: string): PhoneticRule[] {
  return DEFAULT_PHONETIC_RULES[ruleListKey(kind, lang)] ?? [];
}
