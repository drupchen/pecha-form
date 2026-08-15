import { describe, it, expect } from 'vitest';
import {
  applyPhoneticRules, compileRule, defaultRulesFor, mergeRules, type PhoneticRule,
} from './rules';
import { defaultBoStyle, STYLE_LANGS } from './generate';

const rule = (over: Partial<PhoneticRule>): PhoneticRule =>
  ({ find: '', replace: '', regex: false, note: '', ...over });

describe('applying replacement rules', () => {
  it('applies them TOP TO BOTTOM, each seeing the previous one’s output', () => {
    const out = applyPhoneticRules('a', [
      rule({ find: 'a', replace: 'b' }),
      rule({ find: 'b', replace: 'c' }),
    ]);
    expect(out).toBe('c');
    // Reversing the table reverses the outcome — that is what "drag to reorder" is for.
    expect(applyPhoneticRules('a', [
      rule({ find: 'b', replace: 'c' }),
      rule({ find: 'a', replace: 'b' }),
    ])).toBe('b');
  });

  it('replaces every occurrence', () => {
    expect(applyPhoneticRules('om om om', [rule({ find: 'om', replace: 'oṃ' })]))
      .toBe('oṃ oṃ oṃ');
  });

  it('treats a string rule as literal characters, not a pattern', () => {
    expect(applyPhoneticRules('a(b)c', [rule({ find: '(b)', replace: 'X' })])).toBe('aXc');
  });

  it('lets a regex rule use groups', () => {
    expect(applyPhoneticRules('Hung Hung', [
      rule({ find: '(H)ung', replace: '$1oung', regex: true }),
    ])).toBe('Houng Houng');
  });

  it('SKIPS a rule that cannot compile instead of throwing', () => {
    // A half-typed regex is a normal state of the editor; generation must survive it.
    const out = applyPhoneticRules('Pema', [
      rule({ find: '(', replace: 'x', regex: true }),
      rule({ find: 'Pema', replace: 'Péma' }),
    ]);
    expect(out).toBe('Péma');
    expect(compileRule(rule({ find: '(', regex: true }))).toHaveProperty('error');
  });

  it('is the identity for an empty table', () => {
    expect(applyPhoneticRules('Om Benza', [])).toBe('Om Benza');
  });
});

/**
 * The French Sanskrit conventions moved out of `sanskrit.ts` (its `FR_WORD` map and
 * `frenchifyToken`) and into the default rule list. These are the outputs that code produced,
 * asserted here so the move changed nothing a translator will see.
 */
describe('the built-in French Sanskrit rules reproduce what the code used to do', () => {
  const fr = (base: string) => applyPhoneticRules(base, defaultRulesFor('skt', 'fr'));

  it('derives the Tibetanized words the old FR_WORD map spelled out', () => {
    expect(fr('Hung')).toBe('Houng');       // from u → ou, no word rule needed
    expect(fr('Guru')).toBe('Gourou');      // idem, twice
    expect(fr('Pema')).toBe('Péma');
    expect(fr('Peme')).toBe('Pémé');
    expect(fr('Jyana')).toBe('Djana');
    expect(fr('Puja')).toBe('Pudja');
  });

  it('leaves the words the old map deliberately left alone', () => {
    for (const w of ['Om', 'Ah', 'Mani', 'Maha', 'Soha', 'Benza']) {
      expect(fr(w)).toBe(w);
    }
  });

  it('applies the systematic rules to the rest of the vocabulary', () => {
    expect(fr('Om Benza Guru Pema Siddhi Hung')).toBe('Om Benza Gourou Péma Siddhi Houng');
    expect(fr('Om Mani Peme Hung')).toBe('Om Mani Pémé Houng');
  });

  it('has no built-in rules for the other languages', () => {
    expect(defaultRulesFor('skt', 'en')).toEqual([]);
    expect(defaultRulesFor('bo', 'fr')).toEqual([]);
  });
});

/**
 * Copying rules between languages. English, German and Portuguese behave almost identically,
 * so their tables want to be near-copies — but a copy must not disturb the table it joins.
 */
describe('bringing rules from another language', () => {
  const target = [
    rule({ find: 'j', replace: 'dj', regex: true }),
    rule({ find: 'Pema', replace: 'Péma' }),
  ];

  it('appends at the END, where they cannot change what the target already does', () => {
    const { rules, added, skipped } = mergeRules(target, [
      rule({ find: 'u', replace: 'ou', regex: true }),
      rule({ find: 'Hung', replace: 'Houng' }),
    ]);
    expect(rules.map(r => r.find)).toEqual(['j', 'Pema', 'u', 'Hung']);
    expect([added, skipped]).toEqual([2, 0]);
  });

  it('skips a rule the target already has', () => {
    const { rules, added, skipped } = mergeRules(target, [
      rule({ find: 'Pema', replace: 'Péma' }),
      rule({ find: 'Soha', replace: 'Soha' }),
    ]);
    expect(rules.map(r => r.find)).toEqual(['j', 'Pema', 'Soha']);
    expect([added, skipped]).toEqual([1, 1]);
  });

  it('tells a string rule from a regex one with the same text', () => {
    // `u → ou` as a literal is not the regex `u → ou`: they match different things.
    const { added } = mergeRules([rule({ find: 'u', replace: 'ou', regex: true })],
                                 [rule({ find: 'u', replace: 'ou', regex: false })]);
    expect(added).toBe(1);
  });

  it('ignores the note when deciding what is a duplicate', () => {
    const { added, skipped } = mergeRules(
      [rule({ find: 'Pema', replace: 'Péma', note: 'house spelling' })],
      [rule({ find: 'Pema', replace: 'Péma', note: '' })]);
    expect([added, skipped]).toEqual([0, 1]);
  });

  it('dedupes the batch against itself and drops empty rows', () => {
    const { rules, added } = mergeRules([], [
      rule({ find: 'Hung', replace: 'Houng' }),
      rule({ find: 'Hung', replace: 'Houng' }),
      rule({ find: '', replace: 'x' }),          // an abandoned "add rule"
    ]);
    expect(rules.map(r => r.find)).toEqual(['Hung']);
    expect(added).toBe(1);
  });

  it('leaves the target untouched when it already has everything', () => {
    const { rules, added, skipped } = mergeRules(target, target);
    expect(rules).toEqual(target);
    expect([added, skipped]).toEqual([0, 2]);
  });

  it('copies rules as values, so editing one afterwards cannot reach back', () => {
    const incoming = [rule({ find: 'Hung', replace: 'Houng' })];
    const { rules } = mergeRules([], incoming);
    rules[0].replace = 'CHANGED';
    expect(incoming[0].replace).toBe('Houng');
  });
});

/**
 * Which phonetics style each language opens on. The pairing is not arbitrary: a style is
 * only worth defaulting to for a language it actually HAS a variant for, or the engine
 * silently falls back to the style's own default (Padmakara + de → Portuguese).
 */
describe('the default style per language', () => {
  it('gives each language a style that carries it', () => {
    expect(defaultBoStyle('en')).toBe('lotsawahouse');
    expect(defaultBoStyle('fr')).toBe('lotsawahouse');
    expect(defaultBoStyle('de')).toBe('lotsawahouse');
    expect(defaultBoStyle('pt')).toBe('padmakara');
    for (const l of ['en', 'fr', 'de', 'pt']) {
      expect(STYLE_LANGS[defaultBoStyle(l)]).toContain(l);
    }
  });

  it('falls back to the booklets’ house style for a language with none of its own', () => {
    expect(defaultBoStyle('es')).toBe('padmakara');
  });
});
