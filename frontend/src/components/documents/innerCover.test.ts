import { describe, it, expect } from 'vitest';
import { coverFollowedBy, inheritedBodyOf, inheritedGroundOf } from './bookletRender';
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
