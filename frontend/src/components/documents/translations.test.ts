import { describe, it, expect } from 'vitest';
import { joinDistinctBodies } from './compile';

/**
 * One passage, one translation of it — however many chunks claim it.
 *
 * A derived chunk can span several of the origin's chunks, so the compile concatenates every
 * translation anchored in it; taking only the first once threw the rest away (the colophon
 * that printed its opening and nothing else). But two of the origin's chunks may also START on
 * the same syllable and cover different lengths — an earlier one the translator superseded by
 * a longer one over the same passage — and both then answer for that derived chunk. On text 77
 * that printed the opening instruction's French twice, from chunks 542 and 543, whose bodies
 * are byte-identical.
 */
describe('joining the translations anchored in one chunk', () => {
  it('prints a repeated body ONCE — the duplicated-paragraph bug', () => {
    const body = '<p>Que celui qui désire réaliser la pratique quotidienne…</p>';
    expect(joinDistinctBodies([body, body])).toBe(body);
  });

  it('still prints every chunk that says something DIFFERENT', () => {
    expect(joinDistinctBodies(['<p>one</p>', '<p>two</p>'])).toBe('<p>one</p><p>two</p>');
  });

  it('keeps the stream order it was given', () => {
    expect(joinDistinctBodies(['<p>a</p>', '<p>b</p>', '<p>a</p>', '<p>c</p>']))
      .toBe('<p>a</p><p>b</p><p>c</p>');
  });

  it('is the empty string when the chunk has no translation at all', () => {
    expect(joinDistinctBodies([])).toBe('');
  });
});
