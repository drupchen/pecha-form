import { describe, it, expect } from 'vitest';
import { blurOutcome } from './blur';

/**
 * Clearing a translation must stick.
 *
 * Before this rule, an empty box never committed, so the only way to empty a segment was to
 * leave a character in it (translators were typing a full stop) — which then printed. The
 * guard it replaced was there for a real reason, though: a box opened before its data arrived
 * mounts empty, and committing THAT would wipe the stored translation on a stray click.
 */
describe('what a blur commits', () => {
  const initial = '<p>Namo Guru</p>';

  it('SAVES the empty body when the translator emptied the box', () => {
    expect(blurOutcome({ blank: true, touched: true, initial, html: '<p></p>' })).toBe('');
  });

  it('restores the stored text when an untouched box was simply blank', () => {
    // The editor mounted before its data landed: a blur must not be a deletion.
    expect(blurOutcome({ blank: true, touched: false, initial, html: '' })).toBe(initial);
  });

  it('commits the edited text unchanged', () => {
    const html = '<p>Namo Guru Deva Dakini</p>';
    expect(blurOutcome({ blank: false, touched: true, initial, html })).toBe(html);
  });

  it('commits non-blank content even when nothing was touched', () => {
    // A no-op blur still returns what is there; the caller skips an unchanged body.
    expect(blurOutcome({ blank: false, touched: false, initial, html: initial })).toBe(initial);
  });
});
