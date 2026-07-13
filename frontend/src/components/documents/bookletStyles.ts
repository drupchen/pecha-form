import { API_BASE, getOrgStyles, getDocStyles, getOrgFonts, type OrgFont } from '../../api/client';

/**
 * Booklet style designer (Phase 4) — data-driven typography. Each named ROLE maps to a
 * CSS selector inside the booklet; the built-in defaults below reproduce `booklet.css`
 * EXACTLY (so "no styles set" === today's look). Resolution is default ← org template ←
 * per-document override; the compiled CSS is injected into the booklet root by BOTH the
 * bench and the print page, so they stay pixel-identical.
 *
 * The style system owns only TYPOGRAPHY (family/size/weight/italic/colour/leading/align).
 * Structural rules (margins, indents, page breaks, geometry) stay in booklet.css.
 */

export interface StyleProps {
  fontFamily?: string;   // a CSS font-family value (a var(), a quoted family, or a stack)
  fontSize?: string;     // a CSS length, var() or calc()
  fontWeight?: number;
  italic?: boolean;
  color?: string;
  lineHeight?: string;   // unitless number as string, or var()
  align?: 'left' | 'center' | 'right' | 'justify';
  indent?: string;       // left indent (→ margin-left), a CSS length like '10mm'
}

export interface RoleDef { role: string; label: string; selector: string; def: StyleProps }

/** The editable roles, their selectors, and defaults matching booklet.css. */
export const ROLE_DEFS: RoleDef[] = [
  // Defaults GROUNDED in the reference docx's named styles (font/size/weight/italic/indent),
  // not Western assumptions: e.g. small letters are SMALLER than translation, and the
  // phonetics/mantra/section styles are UPRIGHT (the body runs carry no direct italic).
  { role: 'tibetan_body', label: 'Tibetan (body)', selector: '.bk-tibetan',
    def: { fontFamily: 'var(--font-tibetan)', fontSize: 'var(--tibetan-pt)', lineHeight: 'var(--leading)' } },  // བོད་ཡིག 16, left
  { role: 'tibetan_title', label: 'Tibetan (section heading)', selector: '.bk-role-title .bk-tibetan, .booklet-root .bk-role-sapche .bk-tibetan',
    def: { fontFamily: 'var(--font-tibetan)', fontSize: '11pt', align: 'left', indent: '4mm' } },  // ས་བཅད 11, left, indent (NOT enlarged/centred)
  { role: 'phonetics', label: 'Phonetics', selector: '.bk-phonetics',
    def: { fontFamily: 'var(--font-phonetics)', fontSize: 'var(--phonetics-pt)', fontWeight: 600, italic: false, indent: '10mm' } },  // Raleway SemiBold 10, upright, indent 28.4pt
  { role: 'translation', label: 'Translation', selector: '.bk-translation',
    def: { fontFamily: 'var(--font-translation)', fontSize: 'var(--translation-pt)', italic: false, indent: '15mm', align: 'left' } },  // Gentium 11, indent 42.5pt
  { role: 'mantra', label: 'Mantra', selector: '.bk-role-mantra .bk-phonetics',
    def: { fontFamily: 'var(--font-translation)', fontSize: '12pt', fontWeight: 700, italic: false, indent: '10mm' } },  // Mantras (Words) Gentium 12 bold, upright
  { role: 'small', label: 'Small letters / homage', selector: '.bk-role-small .bk-translation',
    def: { fontFamily: 'var(--font-small)', fontSize: '9pt', italic: false, indent: '0' } },  // Small Letters Libertinus Serif Display 9, upright
  { role: 'section', label: 'Section heading', selector: '.bk-section',
    def: { fontFamily: 'var(--font-small)', fontSize: '15pt', fontWeight: 400, italic: false } },  // Sections Libertinus Serif Display 15, upright, not bold
  { role: 'title_tib', label: 'Title page — Tibetan', selector: '.bk-title-tib',
    def: { fontFamily: 'var(--font-tibetan)', fontSize: '24pt', align: 'center', lineHeight: '1.4' } },  // ཁ་བྱང 24, centred
  { role: 'title_main', label: 'Title page — main title', selector: '.bk-title-main',
    def: { fontFamily: 'var(--font-title)', fontSize: '18pt', align: 'center', lineHeight: '1.35' } },  // Title Libertinus Serif Semibold 18, centred
  { role: 'title_sub', label: 'Title page — subtitle', selector: '.bk-title-sub',
    def: { fontFamily: 'Calibri', fontSize: '12pt', italic: true, align: 'center', lineHeight: '1.35' } },  // Subtitle Calibri 12 italic
  { role: 'copyright', label: 'Copyright', selector: '.bk-copyright',
    def: { fontFamily: 'var(--font-translation)', fontSize: '11pt', color: '#333' } },  // no docx style — Normal-ish
  { role: 'toc', label: 'Table of contents', selector: '.bk-toc',
    def: { fontFamily: 'var(--font-translation)', fontSize: '11pt' } },  // toc file separate; Gentium 11
  { role: 'folio', label: 'Page number (folio)', selector: '.booklet-folio',
    def: { fontFamily: 'Georgia, serif', fontSize: '9pt', fontWeight: 400, lineHeight: '1', color: '#666' } },
  { role: 'image_caption', label: 'Image caption', selector: '.bk-image-caption',
    def: { fontFamily: 'var(--font-translation)', fontSize: '12pt', italic: true, color: '#444' } },  // Caption 12 italic
];

/** Bundled font families (booklet.css @font-face) selectable in the designer, plus the
 *  role-var stacks and generic fallbacks. Org-uploaded families extend this at runtime. */
export const BUNDLED_FONTS = [
  'Chogyal', 'Jomolhari', 'Gentium Basic', 'Raleway',
  'Libertinus Serif Display', 'Libertinus Serif', 'Ubuntu Booklet', 'Georgia',
];

type StyleMap = Record<string, StyleProps>;

/** Merge default ← org template ← per-document override for every role. */
export function resolveStyles(org: StyleMap, doc: StyleMap): Record<string, StyleProps> {
  const out: Record<string, StyleProps> = {};
  for (const { role, def } of ROLE_DEFS) {
    out[role] = { ...def, ...(org[role] ?? {}), ...(doc[role] ?? {}) };
  }
  return out;
}

/** A stored family value is a var()/stack (defaults) or a plain family name (a designer
 *  choice) — plain names get quoted + a serif fallback. */
export function formatFamily(v: string): string {
  return /^var\(|,/.test(v) ? v : `'${v}', serif`;
}

function ruleFor(selector: string, p: StyleProps): string {
  const decls: string[] = [];
  if (p.fontFamily) decls.push(`font-family: ${formatFamily(p.fontFamily)}`);
  if (p.fontSize) decls.push(`font-size: ${p.fontSize}`);
  if (p.fontWeight != null) decls.push(`font-weight: ${p.fontWeight}`);
  if (p.italic != null) decls.push(`font-style: ${p.italic ? 'italic' : 'normal'}`);
  if (p.color) decls.push(`color: ${p.color}`);
  if (p.lineHeight) decls.push(`line-height: ${p.lineHeight}`);
  if (p.align) decls.push(`text-align: ${p.align}`);
  if (p.indent) decls.push(`margin-left: ${p.indent}`);
  if (!decls.length) return '';
  // Scope under .booklet-root so these win over booklet.css's unscoped role rules.
  return `.booklet-root ${selector} { ${decls.join('; ')}; }`;
}

/** Generate the booklet's typographic CSS from resolved role props + org fonts. */
export function compileStyleCss(resolved: Record<string, StyleProps>, fonts: OrgFont[]): string {
  const faces = fonts.map(f =>
    `@font-face { font-family: '${f.family}'; src: url('${API_BASE}/org-fonts/${f.id}/file'); ` +
    `font-weight: ${f.weight}; font-style: ${f.italic ? 'italic' : 'normal'}; font-display: swap; }`);
  const rules = ROLE_DEFS.map(rd => ruleFor(rd.selector, resolved[rd.role] ?? rd.def)).filter(Boolean);
  return [...faces, ...rules].join('\n');
}

/** Fetch org styles + per-doc overrides + org fonts, resolve, and compile to CSS. */
export async function loadBookletStyleCss(documentId: number): Promise<string> {
  const [org, doc, fonts] = await Promise.all([
    getOrgStyles().catch(() => ({})),
    getDocStyles(documentId).catch(() => ({})),
    getOrgFonts().catch(() => [] as OrgFont[]),
  ]);
  return compileStyleCss(resolveStyles(org, doc), fonts);
}
