import { describe, it, expect } from 'vitest';
import { ROLE_DEFS, ORG_BASE, resolveStyles, compileStyleCss, type StyleProps } from './bookletStyles';

/**
 * The org template's promise: it always says what it is.
 *
 * An organisation's template is its single source of truth — nothing sits above it to inherit
 * from — so a field left empty there has no answer to give. `ORG_BASE` is what makes the promise
 * keepable, and these are the ways it could quietly stop doing so: a role added to `ROLE_DEFS`
 * and not to the template, a `var()` copied in from a default, a field forgotten.
 */
const FIELDS: (keyof StyleProps)[] =
  ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'color', 'align', 'indent', 'lineHeight'];

describe('ORG_BASE — the template floor', () => {
  it('covers every role the renderer has', () => {
    expect(Object.keys(ORG_BASE).sort()).toEqual(ROLE_DEFS.map((r) => r.role).sort());
  });

  it('leaves no field empty, for any role', () => {
    for (const role of Object.keys(ORG_BASE)) {
      for (const f of FIELDS) {
        expect(ORG_BASE[role][f], `${role}.${f}`).toBeDefined();
        expect(ORG_BASE[role][f], `${role}.${f}`).not.toBe('');
      }
    }
  });

  it('holds values a person can read, not CSS vars', () => {
    // `var(--font-tibetan)` is a real value and a useless one to show in a dropdown.
    expect(JSON.stringify(ORG_BASE)).not.toContain('var(');
  });

  it('keeps the pages that print centred centred', () => {
    // The regression this floor was rebuilt to avoid. `text-align` inherits, `ruleFor` scopes
    // its output under `.booklet-root` and so beats booklet.css, and these roles are silent
    // about `align` in their defaults — an assumed 'left' left-aligned all of them.
    for (const role of ['copyright', 'image_caption', 'title_tib', 'title_main', 'title_sub'])
      expect(ORG_BASE[role].align, role).toBe('center');
  });

  it('starts the folio where the page has always printed it', () => {
    // The folio's align went live when its box was stretched across the text block. The floor
    // has to be the OUTER edge — where a shrink-to-fit box pinned to `right: var(--m-outer)`
    // put the number for as long as the dropdown was doing nothing.
    expect(ORG_BASE.folio.align).toBe('right');
  });

  it('is a FLOOR: an org setting still wins, and a document still wins over that', () => {
    const org = { tibetan_body: { ...ORG_BASE.tibetan_body, fontSize: '20pt' } };
    const doc = { tibetan_body: { fontSize: '18pt' } };
    expect(resolveStyles(org, {}).tibetan_body.fontSize).toBe('20pt');
    expect(resolveStyles(org, doc).tibetan_body.fontSize).toBe('18pt');
  });

  it('emits a complete rule for every role — the point of writing it down', () => {
    const css = compileStyleCss(resolveStyles(ORG_BASE, {}), []);
    for (const { role, selector } of ROLE_DEFS) {
      const first = selector.split(',')[0].trim();
      expect(css, role).toContain(`.booklet-root ${first}`);
    }
    expect(css).not.toContain('var(');
  });
});
