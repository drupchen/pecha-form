import { describe, it, expect } from 'vitest';
import { moveDisplays } from './chunks';
import { applyMovesToRecto } from '../documents/compile';
import type { DocLine } from '../documents/compile';
import type { EditorToken, ChunkLayout } from '../../api/client';

/**
 * The move layer on the printed page.
 *
 * A translator relocates the small instruction that introduces a mantra, because Tibetan and
 * Latin languages do not read in the same order. What the booklet may do about it is narrow:
 *
 *  1. **The Tibetan never moves**, and neither do the phonetics — they transliterate the
 *     Tibetan printed beside them, so text may never appear against another row's Tibetan.
 *  2. **Only the gloss travels.** Exactly two rows change: the donor goes empty, the
 *     destination prints the gloss above its own text. Every other row is returned by
 *     IDENTITY. The first attempt rotated the payloads in between instead, which put the
 *     wrong phonetics beside 200 rows of Tibetan and broke splitting.
 *  3. Resolution is per edition: shared is the basis, a language row overrides, a disabled
 *     language row cancels.
 */

let n = 0;
const tok = (text: string): EditorToken => {
  const idx = n++;
  return {
    idx, id: `syl-${idx}`, text, nature: text.trim() ? 'TEXT' : 'SPACE',
    inserted: false, start_offset: idx * 8, end_offset: idx * 8 + text.length,
  } as EditorToken;
};

/** Four recited lines, then the instruction that introduces the first of them. */
function stream() {
  n = 0;
  return [tok('MANTRA'), tok('LINE-B'), tok('LINE-C'), tok('LINE-D'), tok('INSTRUCTION')];
}

/** A recited row: its own Tibetan and its own phonetics. */
const recited = (t: EditorToken): DocLine => ({
  itemId: 1, textId: 1, key: `k-${t.id}`, role: 'mantra',
  startSylId: t.id, endSylId: t.id, opId: 7,
  tokens: [{ id: t.id, render: t.text }],
  phonetics: t.text.toLowerCase(), translation: `tr(${t.text})`,
  emptyAfter: false, level: null,
} as DocLine);

/** A gloss row as the continuation rule leaves it: no Tibetan, no phonetics, a translation. */
const gloss = (t: EditorToken): DocLine => ({
  itemId: 1, textId: 1, key: `k-${t.id}`, role: 'small', smallKind: 'instructions',
  startSylId: t.id, endSylId: t.id, opId: 7,
  tokens: [], phonetics: '', translation: 'Recite as many times as possible:',
  emptyAfter: false, level: null,
} as DocLine);

const lines = () => {
  const t = stream();
  return [recited(t[0]), recited(t[1]), recited(t[2]), recited(t[3]), gloss(t[4])];
};

const move = (over: Partial<ChunkLayout>): ChunkLayout => ({
  id: 1, text_id: null, kind: 'move',
  src_start_syl_id: null, src_end_syl_id: null, anchor_syl_id: null,
  move_mode: 'segment', anchor_after: false, level: null, lang: null,
  render_as: null, disabled: false, position: 0, titles: {},
  ...over,
} as ChunkLayout);

/** Read the INSTRUCTION (syl-4) before the MANTRA (syl-0) — four rows away. */
const INVERT = [move({
  src_start_syl_id: 'syl-4', src_end_syl_id: 'syl-4', anchor_syl_id: 'syl-0',
})];

const placementsFor = (layouts: ChunkLayout[], lang = 'en') =>
  moveDisplays(stream(), layouts, lang).placements;

describe('a move on the page', () => {
  it('LEAVES EVERY OTHER ROW UNTOUCHED, BY IDENTITY — the rotation test', () => {
    const verso = lines();
    const out = applyMovesToRecto(verso, placementsFor(INVERT));
    // Only the destination (0) and the donor (4) may differ. Rows 1-3 sit between them and a
    // rotation would have handed each its neighbour's text.
    expect(out[1]).toBe(verso[1]);
    expect(out[2]).toBe(verso[2]);
    expect(out[3]).toBe(verso[3]);
  });

  it('never changes any row’s phonetics', () => {
    const verso = lines();
    const out = applyMovesToRecto(verso, placementsFor(INVERT));
    expect(out.map(l => l.phonetics)).toEqual(verso.map(l => l.phonetics));
  });

  it('keeps every row’s Tibetan and identity', () => {
    const verso = lines();
    const out = applyMovesToRecto(verso, placementsFor(INVERT));
    expect(out).toHaveLength(verso.length);
    verso.forEach((l, i) => {
      expect(out[i].key).toBe(l.key);
      expect(out[i].startSylId).toBe(l.startSylId);
      expect(out[i].opId).toBe(l.opId);
      expect(out[i].tokens).toEqual(l.tokens);
    });
  });

  it('prints the gloss at its destination and empties its own row', () => {
    const out = applyMovesToRecto(lines(), placementsFor(INVERT));
    expect(out[0].borrowed).toHaveLength(1);
    expect(out[0].borrowed![0].html).toBe('Recite as many times as possible:');
    // It keeps the face it had at its origin.
    expect(out[0].borrowed![0].role).toBe('small');
    expect(out[0].borrowed![0].smallKind).toBe('instructions');
    // The destination's own text is untouched; the donor's row is now empty.
    expect(out[0].translation).toBe('tr(MANTRA)');
    expect(out[4].translation).toBeNull();
  });

  it('REFUSES to move a row that carries Tibetan', () => {
    // The bug the user hit: a row with its own Tibetan owns its phonetics, so its text stays.
    const verso = lines();
    const layouts = [move({
      src_start_syl_id: 'syl-3', src_end_syl_id: 'syl-3', anchor_syl_id: 'syl-0',
    })];
    expect(applyMovesToRecto(verso, placementsFor(layouts))).toBe(verso);
  });

  it('is the identity when nothing is moved', () => {
    const verso = lines();
    expect(applyMovesToRecto(verso, [])).toBe(verso);
  });

  it('applies a shared move to every edition', () => {
    expect(placementsFor(INVERT, 'en')).toHaveLength(1);
    expect(placementsFor(INVERT, 'de')).toEqual(placementsFor(INVERT, 'en'));
  });

  it('lets a language row override the shared move for that edition only', () => {
    const layouts = [
      INVERT[0],
      move({ id: 2, src_start_syl_id: 'syl-4', src_end_syl_id: 'syl-4',
             anchor_syl_id: 'syl-2', lang: 'de' }),
    ];
    expect(placementsFor(layouts, 'en')[0].anchorId).toBe('syl-0');
    expect(placementsFor(layouts, 'de')[0].anchorId).toBe('syl-2');
    expect(applyMovesToRecto(lines(), placementsFor(layouts, 'de'))[2].borrowed).toHaveLength(1);
  });

  it('lets a disabled language row cancel the shared move there and nowhere else', () => {
    const layouts = [
      INVERT[0],
      // What `cancelMoveHere` writes: same range, this edition, disabled.
      move({ id: 2, src_start_syl_id: 'syl-4', src_end_syl_id: 'syl-4',
             anchor_syl_id: 'syl-0', lang: 'fr', disabled: true }),
    ];
    const verso = lines();
    expect(placementsFor(layouts, 'fr')).toHaveLength(0);
    expect(applyMovesToRecto(verso, placementsFor(layouts, 'fr'))).toBe(verso);
    expect(applyMovesToRecto(verso, placementsFor(layouts, 'en'))[0].borrowed).toHaveLength(1);
  });
});
