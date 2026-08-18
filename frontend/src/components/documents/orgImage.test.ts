import { describe, it, expect } from 'vitest';
import { orgImageFor } from './bookletRender';
import type { DocumentItem, OrgImage } from '../../api/client';

/**
 * WHICH OF THE HOUSE'S IMAGES A PAGE PRINTS.
 *
 * An organization keeps TWO lists — its cover seals and its back-cover images — and a page is
 * only ever offered, or resolved against, its own. A page that picks nothing gets the image
 * marked as its list's stand-in, which is exactly how the single org seal behaved before there
 * were lists: that is what makes growing them a no-op for every booklet nobody has touched.
 *
 * The booklet's OWN uploaded image outranks all of this and is resolved by the caller.
 */
const img = (over: Partial<OrgImage> & { id: number }): OrgImage =>
  ({ kind: 'cover', name: `image ${over.id}`, width_mm: null, height_mm: null,
     is_default: false, ...over });

const page = (kind: string, over: Partial<DocumentItem> = {}): DocumentItem =>
  ({ id: 1, document_id: 1, position: 0, kind, ...over } as DocumentItem);

const seal = img({ id: 10, name: 'Order seal', is_default: true });
const mark = img({ id: 11, kind: 'backcover', name: 'Colophon mark', is_default: true });
const logo = img({ id: 12, name: 'Centre logo' });
const library = [seal, mark, logo];

describe('the org image a page prints', () => {
  it('is the one the page picked', () => {
    expect(orgImageFor(library, page('cover', { org_image_id: 12 }), 'cover')).toBe(logo);
  });

  it('is the default for its kind when the page picked nothing', () => {
    expect(orgImageFor(library, page('cover'), 'cover')).toBe(seal);
    expect(orgImageFor(library, page('backcover'), 'backcover')).toBe(mark);
  });

  it('refuses an image from the OTHER list, falling back to its own stand-in', () => {
    // The lists are independent: a cover can no more print a back-cover image by a stale id
    // than by choosing one, so `11` resolves as if nothing had been picked.
    expect(orgImageFor(library, page('cover', { org_image_id: 11 }), 'cover')).toBe(seal);
  });

  it('falls back to the default when the picked image is gone', () => {
    // Deleting an image clears the pages that named it, so this is the belt to that braces —
    // a stale id must never leave a page with no picture rather than the house's.
    expect(orgImageFor(library, page('cover', { org_image_id: 999 }), 'cover')).toBe(seal);
  });

  it('is nothing when the list has no stand-in and the page picked none', () => {
    // A legitimate state: the caller then draws the ༀ glyph on a cover, and nothing at all on
    // a back cover, which has no ornament standing behind it.
    expect(orgImageFor([logo], page('cover'), 'cover')).toBeNull();
  });

  it('reads only its own list, however full the other is', () => {
    expect(orgImageFor([seal, logo], page('backcover'), 'backcover')).toBeNull();
  });

  it('is nothing when the library is empty', () => {
    expect(orgImageFor([], page('cover'), 'cover')).toBeNull();
  });
});
