import { describe, it, expect } from 'vitest';
import { flowPages, streamSignature, dirtySyllables, hash, toSigLines,
         type LineMetrics, type SigLine, type FlowInput } from './bookletMeasure';

/**
 * The pagination's arithmetic, tested without a DOM.
 *
 * `flowPages` decides where every page of every booklet breaks, and it is pure precisely so
 * that it can be pinned down here: the browser half (reading the rects, waiting for the
 * fonts) is thin and observable, this half is subtle and is not.
 *
 * The bug that started all this shipped because the measurement was never checked against
 * anything — it just looked plausible. These are the properties that would have caught it.
 */

/** Lines of the given heights, stacked with `gap` collapsed between them — exactly what
 *  `readStream` returns for a real continuous stream. */
const stack = (heights: number[], gap = 0): LineMetrics[] => {
  let y = 0;
  return heights.map((h) => { const m = { top: y, bottom: y + h }; y += h + gap; return m; });
};
const flow = (over: Partial<FlowInput> = {}): FlowInput => ({
  n: 0, forced: new Set(), hairlines: new Set(), contentHpx: 350, hairHpx: 0, ...over,
});

describe('flowPages', () => {
  it('fills a page to the maximum', () => {
    expect(flowPages([stack(Array(9).fill(100))], flow({ n: 9 })).starts).toEqual([0, 3, 6]);
  });

  it('keeps a line that lands exactly on the budget', () => {
    // 3 x 100 = 300. The third line must fit a 300px block, not be pushed off it.
    expect(flowPages([stack(Array(4).fill(100))], flow({ n: 4, contentHpx: 300 })).starts)
      .toEqual([0, 3]);
  });

  it('carries collapsed margins in the offsets instead of re-adding them', () => {
    // 100px lines, 20px collapsed between: three span 340, a fourth would reach 460.
    // Summing heights + margins per line would count 3 x 120 = 360 and break a line early.
    expect(flowPages([stack(Array(8).fill(100), 20)], flow({ n: 8 })).starts).toEqual([0, 3, 6]);
  });

  it('lets a line taller than the page sit alone without poisoning the next decision', () => {
    const m = stack([100, 100, 500, 100, 100, 100]);
    const { starts, overfull } = flowPages([m], flow({ n: 6 }));
    expect(starts).toEqual([0, 2, 3]);
    expect(overfull).toEqual([2]);   // reported, never acted on: it has nowhere else to go
  });

  it('breaks where the TALLEST edition demands, so the editions align AND fit', () => {
    const en = stack(Array(9).fill(100));   // 3 per page on its own
    const de = stack(Array(9).fill(170));   // 2 per page on its own
    expect(flowPages([en, de], flow({ n: 9 })).starts).toEqual([0, 2, 4, 6, 8]);
  });

  it('ignores a side that did not measure the whole stream', () => {
    expect(flowPages([stack(Array(9).fill(100)), stack(Array(2).fill(100))], flow({ n: 9 })).starts)
      .toEqual([0, 3, 6]);
  });

  it('honours a forced start and refills from it', () => {
    expect(flowPages([stack(Array(9).fill(100))], flow({ n: 9, forced: new Set([1]) })).starts)
      .toEqual([0, 1, 4, 7]);
  });

  it('charges a continuation rule to BOTH pages of its boundary', () => {
    // A rule at 3: the page starting there opens with it, and the segment before closes with
    // it — so both budget 350-60=290 and hold two lines rather than three.
    expect(flowPages([stack(Array(6).fill(100))], flow({
      n: 6, forced: new Set([3]), hairlines: new Set([3]), hairHpx: 60,
    })).starts).toEqual([0, 2, 3, 5]);
  });

  it('reserves the foot rule on every page of a segment that ends in one', () => {
    expect(flowPages([stack(Array(8).fill(100))], flow({
      n: 8, forced: new Set([4]), hairlines: new Set([4]), hairHpx: 60,
    })).starts).toEqual([0, 2, 4, 6]);
  });

  describe('unbreakable lines', () => {
    // A break is stored as (item, syllable), and transcluded text repeats its source's
    // syllable ids — so on some lines a row would resolve back to a DIFFERENT line and the
    // page would render somewhere other than where it was measured.
    it('falls back to the last line that can carry a row', () => {
      expect(flowPages([stack(Array(9).fill(100))], flow({ n: 9, unbreakable: new Set([3]) })).starts)
        .toEqual([0, 2, 5, 8]);
    });

    it('never overflows when falling back — it only costs fill', () => {
      const m = stack(Array(9).fill(100));
      const { starts } = flowPages([m], flow({ n: 9, unbreakable: new Set([2, 3]) }));
      expect(starts).toEqual([0, 1, 4, 7]);
      for (let k = 0; k < starts.length; k++) {
        const s = starts[k], e = (starts[k + 1] ?? 9) - 1;
        expect(m[e].bottom - m[s].top).toBeLessThanOrEqual(350);
      }
    });

    it('exempts a forced start — it is not chosen, it simply is', () => {
      expect(flowPages([stack(Array(6).fill(100))], flow({
        n: 6, forced: new Set([1]), unbreakable: new Set([1]),
      })).starts).toEqual([0, 1, 4]);
    });

    it('takes the natural boundary when a whole run is unanchorable', () => {
      expect(flowPages([stack(Array(5).fill(100))], flow({
        n: 5, unbreakable: new Set([1, 2, 3, 4]),
      })).starts).toEqual([0, 3]);
    });
  });

  describe('noTail — never end a page with only the sapche/toc run', () => {
    it('walks a break back so a heading opens the next page instead of closing this one', () => {
      // 350px budget, 100px lines: the natural break is at 3 — but line 2 is a heading,
      // and a break at 3 would leave it stranded as the page's last line.
      expect(flowPages([stack(Array(6).fill(100))], flow({
        n: 6, noTail: new Set([2]),
      })).starts).toEqual([0, 2, 5]);
    });

    it('walks back past a whole run of headings', () => {
      // Lines 1 and 2 are both headings: a break at 3 strands 2, a break at 2 strands 1 —
      // the run travels together to the next page.
      expect(flowPages([stack(Array(6).fill(100))], flow({
        n: 6, noTail: new Set([1, 2]),
      })).starts).toEqual([0, 1, 4]);
    });

    it('composes with unbreakable — both constraints hold at once', () => {
      // The natural break at 3 strands heading 2; stepping to 2 is forbidden by
      // `unbreakable`; 1 is the first position satisfying both.
      expect(flowPages([stack(Array(6).fill(100))], flow({
        n: 6, noTail: new Set([2]), unbreakable: new Set([2]),
      })).starts).toEqual([0, 1, 4]);
    });

    it('accepts the overflow rather than emptying the page', () => {
      // Every candidate closes on a heading: nothing valid remains in (start, i), so the
      // flow keeps the natural boundary and reports the page overfull, exactly like an
      // unanchorable run — it never silently deletes a page.
      const r = flowPages([stack(Array(5).fill(100))], flow({
        n: 5, noTail: new Set([0, 1, 2, 3, 4]),
      }));
      expect(r.starts).toEqual([0, 3]);
    });

    it('leaves a page ending before a forced start alone — it is not chosen', () => {
      expect(flowPages([stack(Array(4).fill(100))], flow({
        n: 4, forced: new Set([2]), noTail: new Set([1]),
      })).starts).toEqual([0, 2]);
    });
  });

  it('does not crash on an empty stream', () => {
    expect(flowPages([], flow({ n: 0 }))).toEqual({ starts: [], overfull: [] });
    expect(flowPages([[]], flow({ n: 0 }))).toEqual({ starts: [], overfull: [] });
    expect(flowPages([], flow({ n: 3 })).starts).toEqual([0]);
  });
});

describe('streamSignature / dirtySyllables', () => {
  const L = (i: number, over: Partial<SigLine> = {}): SigLine => ({
    itemId: 1, startSylId: `syl${i}`, role: 'verse', level: null,
    tokenCount: 7, phonetics: `phon ${i}`, translation: `trans ${i}`, emptyAfter: false,
    smallMask: '', ...over,
  });
  const ten = Array.from({ length: 10 }, (_, i) => L(i));

  it('reports no drift for an unchanged stream', () => {
    expect(dirtySyllables(streamSignature(ten), ten)).toBe(0);
  });

  it('claims no drift when there is no stamp to compare against', () => {
    expect(dirtySyllables(null, ten)).toBe(0);
  });

  it('counts an edited line at its own syllables', () => {
    const now = ten.map((l, i) => (i === 3 ? { ...l, translation: 'edited' } : l));
    expect(dirtySyllables(streamSignature(ten), now)).toBe(7);
  });

  it('counts each edited line at its own weight', () => {
    const now = ten.map((l, i) =>
      i === 2 ? { ...l, translation: 'x', tokenCount: 3 } :
      i === 8 ? { ...l, phonetics: 'y', tokenCount: 11 } : l);
    expect(dirtySyllables(streamSignature(ten), now)).toBe(14);
  });

  // Everything that changes a line's HEIGHT has to register, or the pagination goes stale
  // without the drift noticing.
  it.each([
    ['a heading level', { role: 'sapche', level: 2 }],
    ['an empty line',   { emptyAfter: true }],
    ['the phonetics',   { phonetics: 'different' }],
  ])('notices %s changing', (_what, patch) => {
    const now = ten.map((l, i) => (i === 5 ? { ...l, ...patch } : l));
    expect(dirtySyllables(streamSignature(ten), now)).toBeGreaterThan(0);
  });

  it('treats an inserted line as shifting everything after it', () => {
    const now = [...ten.slice(0, 4), L(99), ...ten.slice(4)];
    expect(dirtySyllables(streamSignature(ten), now)).toBe(49);
  });

  it('weighs a deleted line by what it was', () => {
    expect(dirtySyllables(streamSignature(ten), ten.slice(0, 9))).toBe(7);
  });

  it('is bounded by the booklet itself', () => {
    const now = ten.map((l) => ({ ...l, translation: 'all new' }));
    expect(dirtySyllables(streamSignature(ten), now)).toBe(70);
  });

  it('stays small enough to store per document', () => {
    // ~1600 lines is a real booklet; this is read on every open.
    const s = streamSignature(Array.from({ length: 1600 }, (_, i) => L(i)));
    expect(s.length).toBeLessThan(25_000);
  });

  // A small run prints at its own size mid-line, so re-tagging one re-wraps the line while
  // its role, token count and text all stay put. Nothing else in the signature can see it.
  it('notices a sub-run being tagged small', () => {
    const now = ten.map((l, i) => (i === 4 ? { ...l, smallMask: '0011100' } : l));
    expect(dirtySyllables(streamSignature(ten), now)).toBe(7);
  });

  it('notices a small run MOVING within the line', () => {
    // Same count, different place: [small, body] and [body, small] wrap differently.
    const a = ten.map((l, i) => (i === 4 ? { ...l, smallMask: '1100000' } : l));
    const b = ten.map((l, i) => (i === 4 ? { ...l, smallMask: '0000011' } : l));
    expect(dirtySyllables(streamSignature(a), b)).toBe(7);
  });

  it('leaves a booklet with no small runs hashing exactly as it did', () => {
    // The field is appended only when a line HAS one. A booklet without any must not be told
    // its pagination moved — the fingerprint carries a renderer change, not this.
    const noSmall = streamSignature(ten);
    expect(noSmall.split(' ')).toHaveLength(10);
    expect(dirtySyllables(noSmall, ten.map((l) => ({ ...l, smallMask: '' })))).toBe(0);
  });

  it('separates its fields, so no two lines can be confused', () => {
    // Without a separator, ('ab','c') and ('a','bc') would hash alike.
    const a = streamSignature([L(0, { phonetics: 'ab', translation: 'c' })]);
    const b = streamSignature([L(0, { phonetics: 'a', translation: 'bc' })]);
    expect(a).not.toBe(b);
  });
});

describe('toSigLines', () => {
  it('weighs a line by its syllables and keeps what changes its height', () => {
    expect(toSigLines([{
      itemId: 2, startSylId: 's', role: 'sapche', level: 1,
      tokens: [{}, {}, {}], phonetics: 'p', translation: 't', emptyAfter: true,
    }])).toEqual([{
      itemId: 2, startSylId: 's', role: 'sapche', level: 1,
      tokenCount: 3, phonetics: 'p', translation: 't', emptyAfter: true, smallMask: '',
    }]);
  });

  it('reads the small run off the tokens, by position', () => {
    expect(toSigLines([{
      itemId: 1, startSylId: 's', role: 'verse', level: null,
      tokens: [{}, { small: true }, { small: true }, {}],
      phonetics: 'p', translation: 't', emptyAfter: false,
    }])[0].smallMask).toBe('0110');
  });

  it('leaves the mask empty when nothing is small', () => {
    expect(toSigLines([{
      itemId: 1, startSylId: 's', role: 'verse', level: null,
      tokens: [{}, {}], phonetics: 'p', translation: 't', emptyAfter: false,
    }])[0].smallMask).toBe('');
  });
});

describe('hash', () => {
  it('is stable and 8 hex chars', () => {
    expect(hash('booklet')).toBe(hash('booklet'));
    expect(hash('booklet')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash('booklet')).not.toBe(hash('bookleu'));
  });
});
