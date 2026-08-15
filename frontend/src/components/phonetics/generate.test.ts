import { describe, it, expect } from 'vitest';
import { generateBo, generateSkt, tsekAfterVisarga } from './generate';
import { applyPhoneticRules, defaultRulesFor } from './rules';

/**
 * ཿ ends a syllable, and the generators have to know it.
 *
 * `བཛྲ་ས་མ་ཡ་ཛཿཛཿ` romanized as "Benza Sa Ma Ya Dzahdzah": the last two syllables fused into
 * one word. The corpus never thought so — botok stores `ཛཿ` and `ཛཿ` as two syllables — but
 * the EWTS converter reads everything after the last tsek as one word, so the romanizer had
 * nothing to split on.
 */
describe('the visarga as a syllable boundary', () => {
  it('splits the reported line into two syllables', () => {
    expect(generateSkt('བཛྲ་ས་མ་ཡ་ཛཿཛཿ', 'en')).toBe('Benza Sa Ma Ya Dzah Dzah');
  });

  it('carries through to the French edition, whose rules then apply per syllable', () => {
    const fr = applyPhoneticRules(generateSkt('བཛྲ་ས་མ་ཡ་ཛཿཛཿ', 'fr'),
                                  defaultRulesFor('skt', 'fr'));
    expect(fr).toContain('Dzah Dzah');
    expect(fr).not.toContain('Dzahdzah');
  });

  it('leaves the Tibetan phonetics engine’s output as it was', () => {
    // It already separated them; the added tsek must change nothing here.
    expect(generateBo('བཛྲ་ས་མ་ཡ་ཛཿཛཿ', 'lotsawahouse', 'en'))
      .toBe(generateBo('བཛྲ་ས་མ་ཡ་ཛཿ་ཛཿ', 'lotsawahouse', 'en'));
  });
});

describe('where the tsek is added', () => {
  it('adds one only when a Tibetan letter follows', () => {
    expect(tsekAfterVisarga('ཛཿཛཿ')).toBe('ཛཿ་ཛཿ');
    expect(tsekAfterVisarga('ཧཱུྃ་ཕཊཿཛཿམུཿ')).toBe('ཧཱུྃ་ཕཊཿ་ཛཿ་མུཿ');
  });

  it('leaves a visarga that already ends something alone', () => {
    for (const s of ['ཛཿ', 'ཛཿ།', 'ཛཿ ཛཿ', 'ཛཿ\nཛཿ']) {
      expect(tsekAfterVisarga(s)).toBe(s);
    }
  });

  it('is the identity for text without a visarga', () => {
    // Nothing else in the corpus may shift because of this.
    const line = 'ན་མོ། བླ་མ་མཆོག་གསུམ་རིག་བྱེད་མར། །';
    expect(tsekAfterVisarga(line)).toBe(line);
  });
});
