import { describe, it, expect } from 'vitest';
import { applyDocVars, yearOf } from './bookletRender';

/**
 * THE TEMPLATE VARIABLES a furniture body may carry — the copyright's, above all.
 *
 * Both values are passed IN rather than computed on the page, because re-rendering a frozen
 * version must reproduce it: a page that read the clock would print a different copyright
 * every January, and the whole point of freezing a version is that it does not move.
 */
describe('applyDocVars', () => {
  it('resolves both variables', () => {
    expect(applyDocVars('version {{version}}, © {{year}}', '1.2.0', '2026'))
      .toBe('version 1.2.0, © 2026');
  });

  it('resolves every occurrence, not just the first', () => {
    expect(applyDocVars('{{year}}–{{year}}', '', '2026')).toBe('2026–2026');
  });

  it('leaves an unknown token exactly as written', () => {
    // A small substitution, not a template language. Silently blanking something the author
    // typed would be worse than showing it back to them.
    expect(applyDocVars('{{translator}} · {{year}}', '', '2026')).toBe('{{translator}} · 2026');
  });

  it('renders an absent value as empty, never as "undefined"', () => {
    expect(applyDocVars('v{{version}} © {{year}}')).toBe('v © ');
  });

  it('leaves a body with no variables untouched', () => {
    expect(applyDocVars('Copyright © 2026 Shechen.', '1.0.0', '2026'))
      .toBe('Copyright © 2026 Shechen.');
  });
});

describe('the year {{year}} resolves to', () => {
  it('is the year the version was declared, not the year it is read in', () => {
    expect(yearOf('2026-08-18 11:04:22')).toBe('2026');
    expect(yearOf('2019-01-01 00:00:00')).toBe('2019');
  });

  it('falls back to the current year when there is no version to reproduce', () => {
    const now = String(new Date().getFullYear());
    expect(yearOf(undefined)).toBe(now);
    expect(yearOf(null)).toBe(now);
    expect(yearOf('')).toBe(now);
  });

  it('falls back rather than printing a fragment of a malformed stamp', () => {
    expect(yearOf('not-a-date')).toBe(String(new Date().getFullYear()));
  });
});
