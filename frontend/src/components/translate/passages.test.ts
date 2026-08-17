import { describe, it, expect } from 'vitest';
import { insertPassageChunks, retrievedPassageBody, type DerivedChunk } from './chunks';
import type { EditorToken, Passage, TranslationChunk } from '../../api/client';
import type { Span } from '../../store/useTagStore';

/**
 * A PASSAGE is earlier text marked to be recited again — so it is read again, and printed
 * again. Two shapes come out of the same rows:
 *
 *   the BENCH  — one card per same-type group, which is one translation unit to work on;
 *   the PAGE   — one row per printed line, because these are lines of a booklet and the flow
 *                breaks pages between them. Merged, a repeated four-line verse would arrive as
 *                a single row no page break could fall inside.
 */

let n = 0;
const tok = (text: string): EditorToken => {
  const idx = n++;
  return {
    idx, id: `s${idx}`, text, nature: text.trim() ? 'TEXT' : 'SPACE',
    inserted: false, start_offset: idx * 8, end_offset: idx * 8 + text.length,
  } as EditorToken;
};

/** Four verse lines, each ending on a break-carrying shad, then the anchor they repeat before.
 *  Three syllables a line, not two: `shortVerseGroupEnders` reads a ≤2-syllable group as a
 *  seed (ཧྲཱིཿ and the like) and suppresses its break, which would make the four lines one. */
function stream() {
  n = 0;
  return [
    tok('བཀྲ་'), tok('ཤིས་'), tok('ཆེ་'), tok('། '),
    tok('བདེ་'), tok('ལེགས་'), tok('ཆེ་'), tok('། '),
    tok('ཕུན་'), tok('སུམ་'), tok('ཆེ་'), tok('། '),
    tok('ཚོགས་'), tok('པར་'), tok('ཆེ་'), tok('། '),
    tok('ཤོག'),
  ];
}

const span = (tokens: EditorToken[], name: string): Span => ({
  id: 1, tag: { name, color: '#a00', tag_kind: 'regular' },
  start_offset: tokens[0].start_offset, end_offset: tokens[tokens.length - 1].end_offset,
  start_syl_id: tokens[0].id, end_syl_id: tokens[tokens.length - 1].id,
} as unknown as Span);

const passage = (over: Partial<Passage> = {}): Passage => ({
  id: 5, text_id: 1, anchor_syl_id: 's16', position: 0, own_segment: false, inherited: false,
  translations: {}, members: [{ src_start_syl_id: 's0', src_end_syl_id: 's15' }],
  ...over,
} as Passage);

/** The chunk the passage is anchored in front of — what the insert splices before. */
const anchorChunk = (): DerivedChunk => ({
  key: 'anchor', startSylId: 's16', endSylId: 's16', text: 'ཤོག', sylIds: ['s16'],
  startOffset: 128, tagType: 'verse', tagColor: null,
  tokens: [{ id: 's16', render: 'ཤོག' }],
} as DerivedChunk);

const GROUPS = { verse: true, sapche: true, mantra: true };
const insert = (shape?: Parameters<typeof insertPassageChunks>[7]) => insertPassageChunks(
  [anchorChunk()], [passage()], stream(), new Set<number>(), [span(stream(), 'verse')],
  new Map(), GROUPS, shape);

describe('a repeat, in the two shapes it must take', () => {
  it('is ONE row per same-type group for the bench — today’s behaviour, unchanged', () => {
    const rows = insert().filter(c => c.passage);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens.length).toBeGreaterThan(4);       // the whole run, in one card
  });

  it('is one row per printed LINE for the page', () => {
    const rows = insert({ lineLevel: true, splitInstructions: true, closeShads: false,
                          merge: false }).filter(c => c.passage);
    expect(rows).toHaveLength(4);                            // four verse lines, four rows
    expect(rows.map(r => r.tokens.map(t => t.render).join('').trim()))
      .toEqual(['བཀྲ་ཤིས་ཆེ་།', 'བདེ་ལེགས་ཆེ་།', 'ཕུན་སུམ་ཆེ་།', 'ཚོགས་པར་ཆེ་།']);
  });

  it('splices at the anchor, before the chunk it repeats in front of', () => {
    const out = insert({ lineLevel: true, merge: false });
    expect(out[out.length - 1].key).toBe('anchor');
    expect(out.slice(0, -1).every(c => c.passage != null)).toBe(true);
  });

  it('gives every row a unique key and no syllables of its own', () => {
    const rows = insert({ lineLevel: true, merge: false }).filter(c => c.passage);
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
    // The ids belong to the ORIGINAL: claiming them would make every id-keyed thing ambiguous.
    expect(rows.every(r => r.startSylId === '' && r.sylIds.length === 0)).toBe(true);
    // …but each carries the source range it repeats, which is how it finds its translation.
    expect(rows.every(r => !!r.passageUnitStart && !!r.passageUnitEnd)).toBe(true);
  });

  it('is the identity when the text has no passages', () => {
    const chunks = [anchorChunk()];
    expect(insertPassageChunks(chunks, [], stream(), new Set<number>(), [], new Map(), GROUPS))
      .toBe(chunks);
  });
});

describe('what a repeat says', () => {
  const pos = new Map<string, number>([['s0', 0], ['s3', 3], ['s6', 6], ['s9', 9], ['s12', 12],
                                       ['s16', 16]]);
  const chunk = (id: number, s: string, e: string, body: string): TranslationChunk => ({
    id, origin_text_id: 1, start_syl_id: s, end_syl_id: e, kind: 'text', level: null,
    render_as: null, translations: [{ lang: 'fr', body }],
  } as TranslationChunk);

  it('is the source’s translation, in stream order', () => {
    const chunks = [chunk(2, 's6', 's9', '<p>second</p>'), chunk(1, 's0', 's3', '<p>first</p>')];
    expect(retrievedPassageBody(chunks, pos, 's0', 's9', 'fr'))
      .toBe('<p>first</p><p>second</p>');
  });

  it('takes a chunk that merely OVERLAPS the range — a repeat may reuse part of a paragraph', () => {
    const chunks = [chunk(1, 's0', 's12', '<p>the whole paragraph</p>')];
    expect(retrievedPassageBody(chunks, pos, 's3', 's6', 'fr')).toBe('<p>the whole paragraph</p>');
  });

  it('collapses a chunk that covers several of the row’s units', () => {
    const chunks = [chunk(1, 's0', 's3', '<p>once</p>'), chunk(2, 's6', 's9', '<p>once</p>')];
    expect(retrievedPassageBody(chunks, pos, 's0', 's9', 'fr')).toBe('<p>once</p>');
  });

  it('says nothing when the range resolves nowhere, or the edition has no words', () => {
    expect(retrievedPassageBody([], pos, 's0', 's9', 'fr')).toBe('');
    expect(retrievedPassageBody([chunk(1, 's0', 's3', '<p>x</p>')], pos, 'gone', 's9', 'fr')).toBe('');
    expect(retrievedPassageBody([chunk(1, 's0', 's3', '<p>x</p>')], pos, 's0', 's3', 'de')).toBe('');
  });
});
