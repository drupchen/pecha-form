import { describe, it, expect } from 'vitest';
import { deriveChunks } from './chunks';
import type { EditorToken } from '../../api/client';
import type { Span } from '../../store/useTagStore';

/**
 * NO SPACE BEFORE A SHAD, at the end of a verse line.
 *
 * Tibetan writes none: `ཅིག །` and `སོ། །` carry a gap only because ཀ ག ཤ take no tsheg and the
 * scribe leaves a blank where it would have been. The reader should not see it — on screen or
 * in the PDF, which prints the same components.
 *
 * The rule is deliberately narrow, and each limit below is a case the corpus actually holds:
 *   - VERSE only (`verse` and the small-letter `small - verses`);
 *   - at a LINE END only — which is what keeps the opening head mark `༄༅། །` out of it;
 *   - single shad to single shad — the text-closing flourish `།། །།` keeps its gap.
 *
 * And it is a RENDER change: the token count, every id and every `opId` come out untouched, or
 * the row contract, the page-break anchors and the split machinery would be addressing
 * something that no longer exists.
 */

const TAGS: Record<string, { name: string; color: string }> = {
  verse: { name: 'verse', color: '#a00' },
  prose: { name: 'prose', color: '#0a0' },
  mantra: { name: 'mantra', color: '#00a' },
  smallVerses: { name: 'small - verses', color: '#aa0' },
  smallInstructions: { name: 'small - instructions', color: '#a0a' },
};

/** A token stream with true offsets, and one regular span of `tag` covering all of it. */
function stream(texts: string[], tag = TAGS.verse): { tokens: EditorToken[]; spans: Span[] } {
  let off = 0;
  const tokens = texts.map((text, idx) => {
    const start = off;
    off += text.length;
    return {
      idx, id: `s${idx}`, text,
      nature: text.trim() === '' ? 'SPACE' : /[ཀ-࿚]/u.test(text.trim()[0]) ? 'TEXT' : 'PUNCT',
      inserted: false, start_offset: start, end_offset: off, op_id: 7,
    } as EditorToken;
  });
  // Shad-only tokens are PUNCT, not TEXT — `shortVerseGroupEnders` counts TEXT syllables.
  for (const t of tokens) if (/^[།༎༏༐༑༔༴༄-༊\s]+$/u.test(t.text)) (t as { nature: string }).nature = 'PUNCT';
  const spans: Span[] = [{
    id: 1, tag: { ...tag, tag_kind: 'regular' }, start_offset: 0, end_offset: off,
    start_syl_id: tokens[0].id, end_syl_id: tokens[tokens.length - 1].id,
  } as unknown as Span];
  return { tokens, spans };
}

const GROUPS = { verse: true, sapche: true, mantra: true };

/** The rendered Tibetan of the whole stream, as the benches and the booklet draw it. */
function render(texts: string[], tag = TAGS.verse, overrides = new Map<string, number>()): string {
  const { tokens, spans } = stream(texts, tag);
  const chunks = deriveChunks(tokens, new Set<number>(), spans, overrides, GROUPS);
  return chunks.flatMap((c) => c.tokens).map((t) => t.render).join('');
}

/** A verse line ending in ག — one of the three letters that take no tsheg, so the corpus
 *  writes ` །` after it. Four syllables, so `shortVerseGroupEnders` does not suppress the
 *  line's own break (a ≤2-syllable group reads as a seed and stays with what follows). */
const LINE = ['བཀྲ་', 'ཤིས་', 'བདེ་', 'ལེགས་', 'ཤོག'];

describe('the space before a shad at a verse line end', () => {
  it('closes it after ཀ ག ཤ — the letters that take no tsheg', () => {
    expect(render([...LINE, ' །'])).toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག།\n');
    expect(render(['ཐམས་', 'ཅད་', 'ལེགས་', 'བཞག', ' །'])).toBe('ཐམས་ཅད་ལེགས་བཞག།\n');
    expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'ཅིག', ' ། '])).toBe('ཐམས་ཅད་བདེ་ཅིག། \n');
  });

  it('closes it after a vowel sign on ཀ ག ཤ (`གི །`)', () => {
    expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'གི', ' །'])).toBe('ཐམས་ཅད་བདེ་གི།\n');
  });

  it('closes the double shad `། །`', () => {
    expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'སོ', '། ། '])).toBe('ཐམས་ཅད་བདེ་སོ།། \n');
  });

  it('removes ALL of the spaces when there are several', () => {
    expect(render([...LINE, '   །'])).toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག།\n');
    expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'སོ', '།   ། '])).toBe('ཐམས་ཅད་བདེ་སོ།། \n');
  });

  it('closes the last line of a chunk, which has no trailing break of its own', () => {
    // The break after the final cluster overridden away: the chunk simply ends there, and its
    // tail is a line all the same.
    expect(render([...LINE, ' །'], TAGS.verse, new Map([['s5', 0]])))
      .toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག།');
  });

  it('closes the small-letter verses too (`small - verses`)', () => {
    // No automatic break here — the verse break rule keys on the literal `verse` tag — so this
    // is also the chunk-tail case: a line ends where the chunk does.
    expect(render([...LINE, ' །'], TAGS.smallVerses)).toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག།');
  });
});

describe('what it must not touch', () => {
  it('leaves the text-closing flourish `།། །།` alone', () => {
    expect(render([...LINE, '།། །། '])).toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག།། །། \n');
  });

  it('leaves the opening head mark `༄༅། །` alone', () => {
    // It opens the line it introduces — never its end — and a yig-mgo is excluded outright.
    expect(render(['༄༅། །', ...LINE])).toBe('༄༅། །བཀྲ་ཤིས་བདེ་ལེགས་ཤོག');
  });

  it('leaves the ordinary space after a shad, before the next word', () => {
    expect(render([...LINE, '། ', 'དེ་', 'ནས་', 'སོང་', 'ངོ']))
      .toBe('བཀྲ་ཤིས་བདེ་ལེགས་ཤོག། \nདེ་ནས་སོང་ངོ');
  });

  it('leaves a `། །` that is NOT at the end of its line', () => {
    // The break after the cluster suppressed (a display-break override of 0): the shads now sit
    // inside the line, and the rule reaches only a line's end.
    const overrides = new Map<string, number>([['s4', 0]]);
    expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'སོ', '། ། ', 'གཉིས་', 'པའོ'], TAGS.verse, overrides))
      .toBe('ཐམས་ཅད་བདེ་སོ། ། གཉིས་པའོ');
  });

  it('leaves prose, mantra and instructions exactly as typed', () => {
    for (const tag of [TAGS.prose, TAGS.mantra, TAGS.smallInstructions]) {
      expect(render(['ཐམས་', 'ཅད་', 'བདེ་', 'སོ', '། ། '], tag)).toContain('སོ། ། ');
      expect(render([...LINE, ' །'], tag)).toContain('ཤོག །');
    }
  });
});

describe('the invariants the rest of the app addresses', () => {
  const texts = ['ཐམས་', 'ཅད་', 'བདེ་', 'སོ', '། ། ', ...LINE, ' །'];

  it('changes no token id, no opId and no token count', () => {
    const { tokens, spans } = stream(texts);
    const chunks = deriveChunks(tokens, new Set<number>(), spans, new Map(), GROUPS);
    const out = chunks.flatMap((c) => c.tokens);
    expect(out).toHaveLength(tokens.length);
    expect(out.map((t) => t.id)).toEqual(tokens.map((t) => t.id));
    expect(out.every((t) => t.opId === 7)).toBe(true);
    // Every chunk still owns exactly the syllables it did.
    expect(chunks.flatMap((c) => c.sylIds)).toEqual(tokens.map((t) => t.id));
  });

  it('deletes only spaces — the Tibetan itself is byte-identical', () => {
    const before = texts.join('');
    const after = render(texts).replace(/\n/g, '');
    expect(after.replace(/\s/g, '')).toBe(before.replace(/\s/g, ''));
    expect(after.length).toBeLessThan(before.length);
  });

  it('leaves a stream with nothing to close untouched', () => {
    const plain = ['ཐམས་', 'ཅད་', 'བདེ་', 'ལེགས་', 'སོ'];
    expect(render(plain)).toBe(plain.join(''));
  });
});
