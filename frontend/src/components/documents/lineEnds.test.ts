import { describe, it, expect } from 'vitest';
import { closeVerseLineEnds } from './compile';
import type { DocLine } from './compile';

/**
 * The shad rule, asked of the line the booklet PRINTS.
 *
 * A booklet line is not final when `deriveChunks` makes it: the continuation rule appends a
 * small-instructions run's Tibetan to the line above it. So the question — does this line end
 * on a space and a shad, and is that ending verse? — can only be asked afterwards, which is
 * where `closeVerseLineEnds` sits.
 *
 * The two answers that matter:
 *   `བདག །`  → `བདག།`         a verse line ending on ` །`
 *   `མཆི། །ལན་གསུམ།` → unchanged   a line that runs on into its gloss ends on the gloss
 */

let n = 0;
const tok = (render: string, small?: boolean) =>
  ({ id: `s${n++}`, render, opId: 7, ...(small ? { small: true } : {}) });

const line = (over: Partial<DocLine> & { tokens: { id: string; render: string }[] }): DocLine => ({
  itemId: 1, textId: 1, key: `k${over.tokens[0]?.id ?? 'x'}`, role: 'verse',
  startSylId: over.tokens[0]?.id ?? '', endSylId: over.tokens[over.tokens.length - 1]?.id ?? '',
  opId: 7, phonetics: '', translation: null, emptyAfter: false, level: null,
  ...over,
} as DocLine);

const text = (l: DocLine) => l.tokens.map((t) => t.render).join('');

/** A verse line whose last token is the closing shad cluster. */
const verseLine = (cluster = '། །', stem = 'ལ') => {
  n = 0;
  return line({ tokens: [tok('གུ་རུ་'), tok('པདྨ་'), tok('རྒྱལ་'), tok('པོ་'), tok(stem), tok(cluster)] });
};

/** The same line after the continuation rule appended `ལན་གསུམ།` to it. */
const withGloss = () => {
  const l = verseLine();
  return line({ ...l, tokens: [...l.tokens, tok('ལན་', true), tok('གསུམ', true), tok('། ', true)] });
};

describe('closing a verse line’s own ending', () => {
  it('closes a line that ends on a space and a shad', () => {
    const out = closeVerseLineEnds([verseLine()]);
    expect(text(out[0])).toBe('གུ་རུ་པདྨ་རྒྱལ་པོ་ལ།།');
  });

  it('closes it after ཀ ག ཤ too — the letters that take no tsheg', () => {
    const out = closeVerseLineEnds([verseLine(' །', 'ཤོག')]);
    expect(text(out[0])).toBe('གུ་རུ་པདྨ་རྒྱལ་པོ་ཤོག།');
    // …and not after any other letter: the space there is not the tsheg-shaped gap.
    const other = [verseLine(' །')];
    expect(closeVerseLineEnds(other)).toBe(other);
  });

  it('LEAVES a line that runs on into its gloss — by identity', () => {
    const before = withGloss();
    const out = closeVerseLineEnds([before]);
    expect(out[0]).toBe(before);
    expect(text(out[0])).toBe('གུ་རུ་པདྨ་རྒྱལ་པོ་ལ། །ལན་གསུམ། ');
  });

  it('closes a small-letter verse line, whose tokens are small throughout', () => {
    const l = verseLine();
    const small = line({ ...l, role: 'small', smallKind: 'verses',
                         tokens: l.tokens.map((t) => ({ ...t, small: true })) });
    expect(text(closeVerseLineEnds([small])[0])).toBe('གུ་རུ་པདྨ་རྒྱལ་པོ་ལ།།');
  });

  it('leaves prose, mantra and instructions alone', () => {
    for (const role of ['prose', 'mantra', 'sapche', 'title']) {
      const l = line({ ...verseLine(), role });
      expect(closeVerseLineEnds([l])[0]).toBe(l);
    }
    const instr = line({ ...verseLine(), role: 'small', smallKind: 'instructions' });
    expect(closeVerseLineEnds([instr])[0]).toBe(instr);
  });

  it('leaves the closing flourish and the head mark', () => {
    expect(text(closeVerseLineEnds([verseLine('།། །། ')])[0])).toBe('གུ་རུ་པདྨ་རྒྱལ་པོ་ལ།། །། ');
    n = 0;
    const head = line({ tokens: [tok('༄༅། །'), tok('རང་'), tok('བྱུང་')] });
    expect(closeVerseLineEnds([head])[0]).toBe(head);
  });

  it('changes no id, no opId and no token count — and returns the list by identity when it changes nothing', () => {
    const before = verseLine();
    const out = closeVerseLineEnds([before]);
    expect(out[0].tokens).toHaveLength(before.tokens.length);
    expect(out[0].tokens.map((t) => t.id)).toEqual(before.tokens.map((t) => t.id));
    expect(out[0].startSylId).toBe(before.startSylId);
    const plain = [line({ ...verseLine(), role: 'prose' })];
    expect(closeVerseLineEnds(plain)).toBe(plain);
  });
});
