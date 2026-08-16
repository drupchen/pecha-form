import { describe, it, expect } from 'vitest';
import { furnitureShiftLang } from './bookletRender';

/**
 * Which of a special page's blocks are placed ONCE for every edition, and which belong to the
 * edition that reads them.
 *
 * The split runs along the data, not along the block list: a block whose content is the same
 * string or the same picture in all four booklets is placed once. The seal and the Tibetan
 * title are the pair a reader sees as one unit at the head of the page, and keying them
 * differently was what let an edition drift — the image moved per edition while the Tibetan
 * above it did not.
 */
describe('a title-page block’s placement lang', () => {
  it('shares the booklet’s own Tibetan title lines', () => {
    for (const key of ['#title_tib0', '#title_tib1', '#title_tib2']) {
      expect(furnitureShiftLang(key, 'fr')).toBe('');
      expect(furnitureShiftLang(key, 'en')).toBe('');
    }
  });

  it('shares the image — the seal, the image page and the back cover are one picture', () => {
    expect(furnitureShiftLang('#image', 'fr')).toBe('');
    expect(furnitureShiftLang('#image', 'de')).toBe('');
  });

  it('keeps every translated block to its own edition', () => {
    for (const key of ['#title_main', '#title_sub0', '#title_sub1',
                       '#title_origin', '#title_author', '#toc:14', '#backcover0']) {
      expect(furnitureShiftLang(key, 'fr')).toBe('fr');
      expect(furnitureShiftLang(key, 'pt')).toBe('pt');
    }
  });
});
