import { describe, it, expect } from 'vitest';
import { tocTitleSeed } from './bookletRender';
import type { DocLine } from './compile';
import type { DocumentItem } from '../../api/client';

/**
 * THE TOC TITLE A TEXT SUPPLIES OF ITS OWN — what an unauthored contents entry prints.
 *
 * `tocTitleSeed` is one function called by both the page (`tocRows`) and the panel
 * (`DocumentsView`), so the words you are shown to edit are the words on the page.
 * Its fallback chain: the compiled title's first paragraph → the first title line's
 * translation → `text_title` → empty. The first two go through `inlineHtml`, which
 * needs a DOM; they are verified via the browser check, not here.
 */

const item = (over: Partial<DocumentItem> & { id: number }): DocumentItem => ({
  document_id: 1, position: 0, kind: 'textpage', text_id: 7, text_title: 'a text',
  caption: null, body: null, ...over,
} as DocumentItem);

/** A title line with no paragraphs and no translation — the path that skips `inlineHtml`. */
const titleLine = (itemId: number): DocLine => ({
  itemId, textId: itemId, key: `${itemId}:t`, role: 'title',
  startSylId: 't', endSylId: 't', tokens: [{ id: 't', render: 'ཨ' }],
  opId: null, phonetics: '', translation: null, emptyAfter: false, level: null,
} as DocLine);

describe('tocTitleSeed — the fallback chain', () => {
  // The first two tiers — paragraphs[0] and translation — pass through `inlineHtml`,
  // which needs `DOMParser`. They are covered by the browser verification (doc 21),
  // not by these unit tests which run without a DOM.

  it('falls back to text_title when the title chunk has no paragraphs and no translation', () => {
    const t = item({ id: 5, text_title: 'Essence of Accomplishment' });
    const titles = new Map([[5, [titleLine(5)]]]);
    expect(tocTitleSeed(titles, t)).toBe('Essence of Accomplishment');
  });

  it('falls back to text_title when there are no title lines at all', () => {
    const t = item({ id: 5, text_title: 'The Heart Sūtra' });
    expect(tocTitleSeed(new Map(), t)).toBe('The Heart Sūtra');
  });

  it('returns empty when the text has no title lines and no text_title', () => {
    const t = item({ id: 5, text_title: '' });
    expect(tocTitleSeed(new Map(), t)).toBe('');
  });

  it('returns empty when text_title is null', () => {
    const t = item({ id: 5, text_title: null as unknown as string });
    expect(tocTitleSeed(new Map(), t)).toBe('');
  });

  it('resolves a REUSED text page through layout_item_id', () => {
    // The booklet page's own id is 9, but the text page it reuses has item 5.
    // The title map is keyed by 5, so tocTitleSeed must look up layout_item_id.
    const reused = item({ id: 9, layout_item_id: 5, text_title: 'Fallback' });
    const titles = new Map([[5, [titleLine(5)]]]);
    // Title line has no paragraphs and no translation → falls through to text_title,
    // but the lookup itself must have found the entry under 5, not missed it under 9.
    expect(tocTitleSeed(titles, reused)).toBe('Fallback');
  });

  it('misses when layout_item_id does not match', () => {
    const t = item({ id: 9, layout_item_id: 5, text_title: 'Used' });
    // Title map keyed by 99 — neither 9 nor 5 matches.
    const titles = new Map([[99, [titleLine(99)]]]);
    expect(tocTitleSeed(titles, t)).toBe('Used');
  });
});
