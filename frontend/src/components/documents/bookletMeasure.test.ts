import { describe, it, expect } from 'vitest';
import { flowPages, streamSignature, dirtySyllables, hash, toSigLines,
         type LineMetrics, type SigLine, type FlowInput,
         type ColBoundaries } from './bookletMeasure';

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
    expect(flowPages([], flow({ n: 0 }))).toEqual({ starts: [], overfull: [], splits: [] });
    expect(flowPages([[]], flow({ n: 0 }))).toEqual({ starts: [], overfull: [], splits: [] });
    expect(flowPages([], flow({ n: 3 })).starts).toEqual([0]);
  });

  describe('mid-line splits (subBoundaries)', () => {
    // The scenario every case builds on: a 350px block, two full 100px lines, then line 2 —
    // too tall to follow them whole, with rendered rows inside it the flow may cut at.
    // Boundaries are keyed [side][line]; anything unkeyed is uncuttable, as in real life.
    const SUB = (map: Record<number, Record<number, ColBoundaries>>) =>
      (side: number, line: number) => map[side]?.[line] ?? null;
    // Verso line 2: three 60px token rows (tokens 0-3, 4-7, 8-11), sitting at y 200-380.
    const versoRows: ColBoundaries = {
      kind: 'units', units: 12,
      rows: [{ start: 0, topPx: 200, bottomPx: 260 },
             { start: 4, topPx: 260, bottomPx: 320 },
             { start: 8, topPx: 320, bottomPx: 380 }],
    };

    it('splits at the LARGEST verso row boundary whose head still fits', () => {
      // budgetSplit = 350 − 10 (the split's own foot rule). Two head rows end at 320 ≤ 340,
      // all three at 380 > 340 — so the cut lands before token 8, not before 4.
      const r = flowPages([stack([100, 100, 180])],
                          flow({ n: 3, hairHpx: 10, subBoundaries: SUB({ 0: { 2: versoRows } }) }));
      expect(r.splits).toEqual([{ index: 2, cuts: [{ kind: 'unit', at: 8 }] }]);
      expect(r.starts).toEqual([0, 2]);
      expect(r.overfull).toEqual([]);
    });

    it('cuts a recto pair to fill ITS page — both halves keeping both elements', () => {
      // The pair: 2 phonetics rows (30px, words 0-2 / 3-5) + 10px gap + 3 translation rows
      // (30px, words 0-3 / 4-7 / 8-11). Whole pair = 160px > the 140 left; the best interior
      // combination is 1 phonetics row + 2 translation rows = 100px → (a=3, b=8).
      const pair: ColBoundaries = {
        kind: 'pair',
        phonWords: 6,
        phon: [{ start: 0, topPx: 200, bottomPx: 230 }, { start: 3, topPx: 230, bottomPx: 260 }],
        transWords: 12,
        trans: [{ start: 0, topPx: 270, bottomPx: 300 }, { start: 4, topPx: 300, bottomPx: 330 },
                { start: 8, topPx: 330, bottomPx: 360 }],
        gapPx: 10,
      };
      const r = flowPages(
        [stack([100, 100, 180, 100, 100]), stack([100, 100, 160, 100, 100])],
        flow({ n: 5, hairHpx: 10,
               subBoundaries: SUB({ 0: { 2: versoRows }, 1: { 2: pair } }) }));
      expect(r.splits).toEqual([{
        index: 2,
        cuts: [{ kind: 'unit', at: 8 }, { kind: 'pair', a: 3, b: 8 }],
      }]);
      // The page after the split flows from each column's own boundary: the verso tail
      // (60px) plus two 100px lines fit, so nothing else breaks.
      expect(r.starts).toEqual([0, 2]);
      expect(r.overfull).toEqual([]);
    });

    it('breaks a fill tie toward the Tibetan\'s fraction', () => {
      // 1+2 rows and 2+1 rows both make a 100px head. The verso cut is token 8 of 16
      // (halfway), so the proportional targets are a≈4 of 8 and b≈6 of 12 — and
      // (a=3, b=8) sits closer to that than (a=6, b=4).
      const verso: ColBoundaries = {
        kind: 'units', units: 16,
        rows: [{ start: 0, topPx: 200, bottomPx: 260 },
               { start: 8, topPx: 260, bottomPx: 320 },
               { start: 12, topPx: 320, bottomPx: 380 }],
      };
      const pair: ColBoundaries = {
        kind: 'pair',
        phonWords: 8,
        phon: [{ start: 0, topPx: 200, bottomPx: 230 }, { start: 3, topPx: 230, bottomPx: 260 },
               { start: 6, topPx: 260, bottomPx: 290 }],
        transWords: 12,
        trans: [{ start: 0, topPx: 300, bottomPx: 330 }, { start: 4, topPx: 330, bottomPx: 360 },
                { start: 8, topPx: 360, bottomPx: 390 }],
        gapPx: 10,
      };
      const r = flowPages(
        [stack([100, 100, 180]), stack([100, 100, 190])],
        flow({ n: 3, contentHpx: 310, hairHpx: 10,
               subBoundaries: SUB({ 0: { 2: verso }, 1: { 2: pair } }) }));
      expect(r.splits[0].cuts[1]).toEqual({ kind: 'pair', a: 3, b: 8 });
    });

    it('vetoes the split when ANY column cannot afford the head page\'s foot rule', () => {
      // The recto page holds 345 of 350: fine for a plain break, but the split's rule needs
      // 10 more — the page would close 5px overfull. The verso's room does not override the
      // veto; the flow breaks whole instead.
      const r = flowPages(
        [stack([100, 100, 180]), stack([172.5, 172.5, 130])],
        flow({ n: 3, hairHpx: 10, subBoundaries: SUB({ 0: { 2: versoRows } }) }));
      expect(r.splits).toEqual([]);
      expect(r.starts).toEqual([0, 2]);
      expect(r.overfull).toEqual([]);
    });

    it('sends the whole pair to the tail when not even its smallest head fits', () => {
      // The recto page already holds 330 of 340: no combination fits, and a mixed cut that
      // strands one element is not an option — so (0,0), and the pair opens the tail page.
      const pair: ColBoundaries = {
        kind: 'pair',
        phonWords: 6,
        phon: [{ start: 0, topPx: 330, bottomPx: 360 }, { start: 3, topPx: 360, bottomPx: 390 }],
        transWords: 8,
        trans: [{ start: 0, topPx: 400, bottomPx: 430 }, { start: 4, topPx: 430, bottomPx: 460 }],
        gapPx: 10,
      };
      const r = flowPages(
        [stack([100, 100, 180]), stack([165, 165, 130])],
        flow({ n: 3, hairHpx: 10,
               subBoundaries: SUB({ 0: { 2: versoRows }, 1: { 2: pair } }) }));
      expect(r.splits[0].cuts[1]).toEqual({ kind: 'pair', a: 0, b: 0 });
    });

    it('keeps the whole pair on the head when it fits entire', () => {
      const pair: ColBoundaries = {
        kind: 'pair',
        phonWords: 6,
        phon: [{ start: 0, topPx: 100, bottomPx: 130 }],
        transWords: 8,
        trans: [{ start: 0, topPx: 140, bottomPx: 180 }],
        gapPx: 10,
      };
      const r = flowPages(
        [stack([100, 100, 180]), stack([50, 50, 80])],
        flow({ n: 3, hairHpx: 10,
               subBoundaries: SUB({ 0: { 2: versoRows }, 1: { 2: pair } }) }));
      expect(r.splits[0].cuts[1]).toEqual({ kind: 'pair', a: 6, b: 8 });
    });

    it('cuts a single-text recto (mantra/homage) at its own word rows', () => {
      const mantra: ColBoundaries = {
        kind: 'units', units: 14,
        rows: [{ start: 0, topPx: 200, bottomPx: 230 }, { start: 5, topPx: 230, bottomPx: 260 },
               { start: 9, topPx: 260, bottomPx: 290 }],
      };
      const r = flowPages(
        [stack([100, 100, 180]), stack([100, 100, 90])],
        flow({ n: 3, hairHpx: 10,
               subBoundaries: SUB({ 0: { 2: versoRows }, 1: { 2: mantra } }) }));
      expect(r.splits[0].cuts[1]).toEqual({ kind: 'unit', at: 9 });
    });

    it('never splits an unsplittable or noTail line', () => {
      const subs = SUB({ 0: { 2: versoRows } });
      expect(flowPages([stack([100, 100, 180])],
        flow({ n: 3, hairHpx: 10, subBoundaries: subs, unsplittable: new Set([2]) })).splits)
        .toEqual([]);
      expect(flowPages([stack([100, 100, 180])],
        flow({ n: 3, hairHpx: 10, subBoundaries: subs, noTail: new Set([2]) })).splits)
        .toEqual([]);
    });

    it('skips a split not worth its hairline', () => {
      // The page holds 340 of the 340 the split could use: the head-side gain is zero.
      const r = flowPages([stack([170, 170, 180])],
        flow({ n: 3, hairHpx: 10, subBoundaries: SUB({ 0: { 2: {
          kind: 'units', units: 12,
          rows: [{ start: 0, topPx: 340, bottomPx: 400 }, { start: 6, topPx: 400, bottomPx: 460 }],
        } } }) }));
      expect(r.splits).toEqual([]);
      expect(r.starts).toEqual([0, 2]);
    });

    it('charges the split\'s rule to the head page it closes', () => {
      // One head row ends at 341: within the raw 350 budget, but not once the page has to
      // close with the continuation rule. No other boundary fits → no split.
      const r = flowPages([stack([100, 100, 180])],
        flow({ n: 3, hairHpx: 10, subBoundaries: SUB({ 0: { 2: {
          kind: 'units', units: 12,
          rows: [{ start: 0, topPx: 200, bottomPx: 341 }, { start: 6, topPx: 341, bottomPx: 380 }],
        } } }) }));
      expect(r.splits).toEqual([]);
    });

    it('flows the page AFTER a split from each column\'s own boundary', () => {
      // Verso tail = 60px (from y 320); with the tail page opening on a rule (budget 340)
      // it holds the tail plus lines 3 and 4 (260 used), and line 5 starts the next page.
      const r = flowPages([stack([100, 100, 180, 100, 100, 100, 100])],
        flow({ n: 7, hairHpx: 10, subBoundaries: SUB({ 0: { 2: versoRows } }) }));
      expect(r.splits.map((s) => s.index)).toEqual([2]);
      expect(r.starts).toEqual([0, 2, 5]);
    });
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
