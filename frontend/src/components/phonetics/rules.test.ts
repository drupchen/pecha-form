import { describe, it, expect } from 'vitest';
import {
  applyPhoneticRules, compileRule, defaultRulesFor, type PhoneticRule,
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
