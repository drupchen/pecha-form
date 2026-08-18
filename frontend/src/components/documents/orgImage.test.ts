import { describe, it, expect } from 'vitest';
import { orgImageFor } from './bookletRender';
import type { DocumentItem, OrgImage } from '../../api/client';

/**
 * WHICH OF THE HOUSE'S IMAGES A PAGE PRINTS.
 *
 * An organization keeps a library — an order's seal, a centre's logo, a colophon mark — and any
 * cover or back cover picks one. A page that picks nothing gets the image marked for its kind,
 * which is exactly how the single org seal behaved before there was a library: that is what
 * makes growing this into a list a no-op for every booklet nobody has touched.
 *
 * The booklet's OWN uploaded image outranks all of this and is resolved by the caller — only
 * it carries a resize grip, so only it is the page's to move.
 */
const img = (over: Partial<OrgImage> & { id: number }): OrgImage =>
  ({ name: `image ${over.id}`, width_mm: null, height_mm: null, default_for: null, ...over });

const page = (kind: string, over: Partial<DocumentItem> = {}): DocumentItem =>
  ({ id: 1, document_id: 1, position: 0, kind, ...over } as DocumentItem);

const seal = img({ id: 10, name: 'Order seal', default_for: 'cover' });
const mark = img({ id: 11, name: 'Colophon mark', default_for: 'backcover' });
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

  it('lets a page pick an image that stands in for the OTHER kind', () => {
    // The library is flat: a mark is a mark, and a house may want its colophon on a cover.
    expect(orgImageFor(library, page('cover', { org_image_id: 11 }), 'cover')).toBe(mark);
  });

  it('falls back to the default when the picked image is gone', () => {
    // Deleting an image clears the pages that named it, so this is the belt to that braces —
    // a stale id must never leave a page with no picture rather than the house's.
    expect(orgImageFor(library, page('cover', { org_image_id: 999 }), 'cover')).toBe(seal);
  });

  it('is nothing when the role has no default and the page picked none', () => {
    // A legitimate state: the caller then draws the ༀ glyph on a cover, and nothing at all on
    // a back cover, which has no ornament standing behind it.
    expect(orgImageFor([logo], page('cover'), 'cover')).toBeNull();
    expect(orgImageFor(library, page('backcover'), 'cover')).toBe(seal);
  });

  it('is nothing when the library is empty', () => {
    expect(orgImageFor([], page('cover'), 'cover')).toBeNull();
  });
});
