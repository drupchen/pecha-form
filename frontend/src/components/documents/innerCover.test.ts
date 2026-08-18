import { describe, it, expect } from 'vitest';
import { coverFollowedBy, deriveBooklet, inheritedBodyOf, inheritedGroundOf } from './bookletRender';
import type { DocLine } from './compile';
import type { DocumentItem, DocumentFurnitureRow } from '../../api/client';

/**
 * WHICH COVER AN INNER COVER FOLLOWS, and what following means.
 *
 * A cover records the aligned text its content was seeded from ("fill from the aligned text").
 * That text's own title page — its inner cover, the same page minus the seal — then follows
 * that cover: its words and its spacing, until this page is edited itself. Every other text is
 * built from its own title, and a cover written for a whole booklet is seeded from no text and
 * binds nobody.
 */

const item = (over: Partial<DocumentItem> & { id: number }): DocumentItem => ({
  document_id: 1, position: 0, kind: 'textpage', text_id: 7, text_title: 'a text',
  caption: null, body: null, ...over,
} as DocumentItem);

const cover = (over: Partial<DocumentItem> = {}) =>
  item({ id: 1, kind: 'cover', text_id: null, ...over });

const row = (over: Partial<DocumentFurnitureRow>): DocumentFurnitureRow => ({
  item_id: 0, lang: 'fr', block: '', body: '', ...over,
} as DocumentFurnitureRow);

describe('the cover an inner cover follows', () => {
  it('is the one seeded from this text', () => {
    const text = item({ id: 2 });
    const c = cover({ source_item_id: 2 });
    expect(coverFollowedBy([c, text], text)).toBe(c);
  });

  it('resolves through the id a REUSED aligned text also answers to', () => {
    // A booklet page reusing an aligned text carries its own id and the text page's; the
    // cover may have been seeded through either.
    const text = item({ id: 9, layout_item_id: 2 });
    const c = cover({ source_item_id: 2 });
    expect(coverFollowedBy([c, text], text)).toBe(c);
  });

  it('is nobody’s when the cover was seeded from no text — a booklet-wide title', () => {
    const text = item({ id: 2 });
    expect(coverFollowedBy([cover(), text], text)).toBeNull();
  });

  it('is nobody’s for the OTHER texts of a multi-text booklet', () => {
    const first = item({ id: 2 }), second = item({ id: 3 });
    const c = cover({ source_item_id: 2 });
    expect(coverFollowedBy([c, first, second], second)).toBeNull();
  });
});

describe('following the cover', () => {
  const text = item({ id: 2 });
  const c = cover({ source_item_id: 2 });

  it('takes the cover’s words where this page has none', () => {
    const furn = [row({ item_id: 1, block: 'title_main', body: '<p>Les Mots</p>' })];
    expect(inheritedBodyOf(furn, text, c, 'fr', 'title_main')).toBe('<p>Les Mots</p>');
  });

  it('prefers this page’s own, which is what editing one diverges', () => {
    const furn = [row({ item_id: 1, block: 'title_main', body: '<p>Les Mots</p>' }),
                  row({ item_id: 2, block: 'title_main', body: '<p>Autre</p>' })];
    expect(inheritedBodyOf(furn, text, c, 'fr', 'title_main')).toBe('<p>Autre</p>');
  });

  it('falls through to nothing — "follow the text" — when neither has a row', () => {
    expect(inheritedBodyOf([], text, c, 'fr', 'title_main')).toBeNull();
  });

  it('treats a CLEARED field as absent, and goes on following the cover', () => {
    // "reset" and "release" write an empty row rather than deleting it. An empty string is a
    // value to `??`, so this page would have stopped following and gone back to the text.
    const furn = [row({ item_id: 1, block: 'title_main', body: '<p>Les Mots</p>' }),
                  row({ item_id: 2, block: 'title_main', body: '' })];
    expect(inheritedBodyOf(furn, text, c, 'fr', 'title_main')).toBe('<p>Les Mots</p>');
  });

  it('reads a cover’s own cleared field as nothing, not as a blank title', () => {
    const furn = [row({ item_id: 1, block: 'title_main', body: '   ' })];
    expect(inheritedBodyOf(furn, text, c, 'fr', 'title_main')).toBeNull();
  });

  it('inherits a block’s PLACEMENT, so the cover’s spacing carries over', () => {
    const own = (key: string) => ({ valueMm: key === '#title_sub0' ? 2.5 : 0 });
    const cov = (key: string) => ({ valueMm: key === '#title_main' ? 1.6 : 9.9 });
    const g = inheritedGroundOf(own, cov);
    expect(g('#title_main').valueMm).toBe(1.6);   // not placed here → the cover's
    expect(g('#title_sub0').valueMm).toBe(2.5);   // placed here → its own, diverged
  });

  it('never inherits the SEAL’s placement — an inner cover has no seal', () => {
    const g = inheritedGroundOf(() => ({ valueMm: 0 }), () => ({ valueMm: 7.3 }));
    expect(g('#image').valueMm).toBe(0);
  });

  it('is the page’s own reading when it follows no cover', () => {
    const g = inheritedGroundOf((k) => ({ valueMm: k === '#title_main' ? 4 : 0 }), null);
    expect(g('#title_main').valueMm).toBe(4);
    expect(g('#title_sub0').valueMm).toBe(0);
  });
});

/**
 * WHOSE TITLE THE COVER CARRIES — and, falling out of the same answer, which texts print a
 * title page of their own.
 *
 * The cover used to be wired to the FIRST aligned text at both ends: its own unauthored slots
 * seeded from that text, and that text was the one denied a title page (its title being on the
 * cover already). Both now key off the text the cover actually carries, which is either the one
 * it was filled from, or — detached — nobody at all.
 */
describe('the text whose title the cover carries', () => {
  /** One title line and one body line per text, sharing the item id the LINES carry. */
  const lineOf = (itemId: number, id: string, role: string): DocLine => ({
    itemId, textId: itemId, key: `${itemId}:${id}`, role,
    startSylId: id, endSylId: id, tokens: [{ id, render: 'ཨ' }],
    opId: null, phonetics: '', translation: null, emptyAfter: false, level: null,
  } as DocLine);

  // Two aligned texts: #2 first, #3 second. `text_title` (not a translated paragraph) supplies
  // the TOC entry, which keeps this fixture clear of the HTML path — these tests run without a
  // DOM.
  const t1 = item({ id: 2, position: 1, text_title: 'One' });
  const t2 = item({ id: 3, position: 2, text_title: 'Two' });
  const title1 = [lineOf(2, 'a', 'title')], title2 = [lineOf(3, 'c', 'title')];
  const lines = [lineOf(2, 'b', 'verse'), lineOf(3, 'd', 'verse')];
  const titles = new Map([[2, title1], [3, title2]]);

  /** The texts given a title page of their own, by item id. */
  const titlePages = (d: ReturnType<typeof deriveBooklet>) =>
    d.bodyUnits.filter((u) => u.kind === 'title')
      .map((u) => (u as { item: DocumentItem }).item.id);
  const blankTitlePages = (d: ReturnType<typeof deriveBooklet>) =>
    d.bodyUnits.filter((u) => u.kind === 'title_blank')
      .map((u) => (u as { item: DocumentItem }).item.id);

  it('adds no inner title pages when nothing says otherwise', () => {
    const d = deriveBooklet([cover({ position: 0 }), t1, t2], [], lines, titles);
    expect(d.coverSourceItemId).toBe(2);
    expect(d.mainTitleLines).toBe(title1);
    expect(titlePages(d)).toEqual([]);
  });

  it('is the text it was FILLED FROM — so the first text gets its page back', () => {
    const c = cover({ position: 0, source_item_id: 3 });
    const d = deriveBooklet([c, t1, t2], [], lines, titles);
    expect(d.coverSourceItemId).toBe(3);
    expect(d.mainTitleLines).toBe(title2);
    expect(titlePages(d)).toEqual([]);
  });

  it('resolves a fill recorded through a REUSED text’s layout id', () => {
    const reused = item({ id: 9, layout_item_id: 3, position: 2, text_title: 'Two' });
    const c = cover({ position: 0, source_item_id: 3 });
    const d = deriveBooklet([c, t1, reused], [], lines, titles);
    expect(d.coverSourceItemId).toBe(3);
    expect(titlePages(d)).toEqual([]);
  });

  it('is NOBODY once the cover is detached: every text derives its own title page', () => {
    const c = cover({ position: 0, title_disposition: 'own' });
    const d = deriveBooklet([c, t1, t2], [], lines, titles);
    expect(d.coverSourceItemId).toBeNull();
    // No lines to seed from is what makes a blank slot print blank: `TitleContent` reads its
    // fallbacks out of these, so an unauthored slot has nothing to fall back to.
    expect(d.mainTitleLines).toEqual([]);
    expect(titlePages(d)).toEqual([]);
    for (const t of [t1, t2]) expect(coverFollowedBy([c, t1, t2], t)).toBeNull();
  });

  it('is nobody when the text it named has left the booklet', () => {
    // Rather than silently adopting another text's title: the cover keeps the words it was
    // filled with, and seeds nothing new.
    const c = cover({ position: 0, source_item_id: 44 });
    const d = deriveBooklet([c, t1, t2], [], lines, titles);
    expect(d.coverSourceItemId).toBeNull();
    expect(d.mainTitleLines).toEqual([]);
    expect(titlePages(d)).toEqual([]);
  });

  it('still lets a text say where its own title goes, whatever the cover carries', () => {
    const asked = item({ id: 2, position: 1, text_title: 'One', title_disposition: 'page' });
    const kept = item({ id: 3, position: 2, text_title: 'Two', title_disposition: 'body' });
    const d = deriveBooklet([cover({ position: 0 }), asked, kept], [], lines, titles);
    expect(titlePages(d)).toEqual([2]);
    expect(blankTitlePages(d)).toEqual([2]);
  });

  it('can explicitly put the inner title directly after the preceding page', () => {
    const direct = item({ id: 2, position: 1, text_title: 'One', title_disposition: 'page_direct' });
    const d = deriveBooklet([cover({ position: 0 }), direct, t2], [], lines, titles);
    expect(titlePages(d)).toEqual([2]);
    expect(blankTitlePages(d)).toEqual([]);
  });

  it('explicitly suppresses an inner title page with none', () => {
    const hidden = item({ id: 2, position: 1, text_title: 'One', title_disposition: 'none' });
    const d = deriveBooklet([cover({ position: 0 }), hidden, t2], [], lines, titles);
    expect(titlePages(d)).toEqual([]);
  });
});
