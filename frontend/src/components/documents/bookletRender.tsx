import React from 'react';
import {
  itemImageUrl,
  type DocumentItem, type LayoutConfig, type DocumentLayoutRow, type DocumentFurnitureRow,
} from '../../api/client';
import { type DocLine } from './compile';
import { sanitizeTranslationHtml } from '../translate/sanitize';

/**
 * Shared booklet rendering (Phase D2/D3). The pagination bench (interactive) and the
 * print page (static, for the Chromium PDF) use the SAME presentational components and
 * the SAME `deriveBooklet` composition so the on-screen bench and the printed PDF are
 * pixel-identical — the WYSIWYG guarantee. Interactivity (break controls, balancing
 * handlers) is layered on top by the bench via the optional `LineAdj` handlers.
 */

export const MM_PX = 96 / 25.4;

export function rootVars(c: LayoutConfig): React.CSSProperties {
  return {
    ['--page-w' as any]: `${c.page_width_mm}mm`,
    ['--page-h' as any]: `${c.page_height_mm}mm`,
    ['--m-top' as any]: `${c.margin_top_mm}mm`,
    ['--m-bottom' as any]: `${c.margin_bottom_mm}mm`,
    ['--m-bind' as any]: `${c.margin_bind_mm}mm`,
    ['--m-outer' as any]: `${c.margin_outer_mm}mm`,
    ['--tibetan-pt' as any]: `${c.tibetan_pt}pt`,
    ['--phonetics-pt' as any]: `${c.phonetics_pt}pt`,
    ['--translation-pt' as any]: `${c.translation_pt}pt`,
    ['--leading' as any]: `${c.leading}`,
  };
}

/** Balancing state applied to one line, plus (interactive only) the handlers. */
export interface LineAdj {
  gapDeltaMm: number;   // empty-line spacing delta
  noSpace: boolean;     // blank line removed
  wrapMm: number;       // rightward wrap-limit push for the translation
  onGap?: (delta: number) => void;
  onToggleNoSpace?: () => void;
  onWrap?: (delta: number) => void;
}
export const NO_ADJ: LineAdj = { gapDeltaMm: 0, noSpace: false, wrapMm: 0 };

/** The empty-line gap between chunks — the primary balancing lever. */
export const Gap: React.FC<{ adj: LineAdj }> = ({ adj }) => {
  if (adj.noSpace) {
    return adj.onToggleNoSpace ? (
      <div className="bk-gap-removed">
        <button type="button" className="bk-gapctl" title="Restore blank line"
                onClick={adj.onToggleNoSpace}>+ line</button>
      </div>
    ) : null;
  }
  return (
    <div className="bk-gap" style={{ height: `calc(var(--translation-pt) * var(--leading) + ${adj.gapDeltaMm}mm)` }}>
      {adj.onGap && (
        <span className="bk-gapctl-group">
          <button type="button" className="bk-gapctl" title="Less space" onClick={() => adj.onGap!(-1)}>−</button>
          <button type="button" className="bk-gapctl" title="More space" onClick={() => adj.onGap!(1)}>+</button>
          <button type="button" className="bk-gapctl" title="Remove blank line" onClick={adj.onToggleNoSpace}>×</button>
        </span>
      )}
    </div>
  );
};

export const Verso: React.FC<{ l: DocLine; adj?: LineAdj }> = ({ l, adj = NO_ADJ }) => (
  <div className={`bk-line bk-role-${l.role}`}>
    <div className="bk-tibetan">{l.tokens.map((t, i) => <span key={i}>{t.render}</span>)}</div>
    {l.emptyAfter && <Gap adj={adj} />}
  </div>
);

/* The recto unit, by role:
 *  - section (title/sapche): the translated heading only (Libertinus, large);
 *  - mantra: the romanised mantra only (the phonetics), standalone bold-italic;
 *  - verse/prose/small: an INTERLINEAR PAIR — phonetics then its indented translation,
 *    kept together (the whole `.bk-line` has break-inside: avoid). */
export const Recto: React.FC<{ l: DocLine; adj?: LineAdj }> = ({ l, adj = NO_ADJ }) => {
  const isSection = l.role === 'title' || l.role === 'sapche';
  const isMantra = l.role === 'mantra';
  return (
    <div className={`bk-line bk-pair bk-role-${l.role}`}>
      {isSection ? (
        l.translation != null && (
          <div className="bk-section"
               // Step the heading size down by outline depth (top = 15pt, floor 10.5pt).
               style={l.level != null ? { fontSize: `${Math.max(10.5, 15 - l.level * 1.5)}pt` } : undefined}
               dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
        )
      ) : (
        <>
          {l.phonetics && <div className="bk-phonetics">{l.phonetics}</div>}
          {!isMantra && l.translation != null && (
            <div className="bk-translation" style={adj.wrapMm ? { marginRight: `-${adj.wrapMm}mm` } : undefined}>
              <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
              {adj.onWrap && (
                <span className="bk-wrapctl">
                  <button type="button" title="Narrower" onClick={() => adj.onWrap!(-1)}>−</button>
                  <button type="button" title="Wider (into the outer margin)" onClick={() => adj.onWrap!(1)}>+</button>
                </span>
              )}
            </div>
          )}
        </>
      )}
      {l.emptyAfter && <Gap adj={adj} />}
    </div>
  );
};

export interface TocRow {
  title: string;
  page: number;
  /** Indent depth (0 = flush). Text headers and top sapche sections are 0; nested
   *  sapche sections step in by their outline depth. */
  level: number;
  /** A text's title heading its section group (multi-text booklets only) — rendered
   *  bold, ungapped from its sections. */
  isTextHeader?: boolean;
}

/** The centred title block (Tibetan title + translated main title / italic subtitle),
 *  shared by the booklet cover and each text's internal title page. `seal` shows the
 *  ༀ ornament (cover only). */
export const TitleContent: React.FC<{ titleLines: DocLine[]; seal?: boolean }> = ({ titleLines, seal }) => {
  // The translated title's parts: the first is the main title, the rest the subtitle.
  // Prefer the title chunk's `<p>` structure (carried on any title line); fall back to
  // one entry per title line.
  const trans = (titleLines.find((t) => t.paragraphs?.length)?.paragraphs)
    ?? titleLines.map((t) => t.translation).filter((x): x is string => !!x);
  return (
    <div className="bk-titlepage">
      {seal && <div className="bk-seal">ༀ</div>}
      {titleLines.map((t, i) => (
        <div key={i} className="bk-tibetan bk-title-tib">
          {t.tokens.map((tk, k) => <span key={k}>{tk.render}</span>)}
        </div>
      ))}
      {trans[0] && (
        <div className="bk-title-main"
             dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(trans[0]) }} />
      )}
      {trans.slice(1).map((p, i) => (
        <div key={`sub${i}`} className="bk-title-sub"
             dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(p) }} />
      ))}
    </div>
  );
};

/** The inner content of a furniture page (cover/copyright/toc/image), WITHOUT the page
 *  frame — so the bench (facing-page mock) and the print page (physical sheet) can each
 *  wrap it in their own page element. */
export const FurnitureContent: React.FC<{
  item: DocumentItem; titleLines: DocLine[]; body: string | null; toc: TocRow[];
}> = ({ item, titleLines, body, toc }) => {
  if (item.kind === 'cover') return <TitleContent titleLines={titleLines} seal />;
  if (item.kind === 'copyright') {
    return body
      ? <div className="bk-copyright" dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />
      : <div className="bk-copyright bk-placeholder">Copyright text — add it in the Documents tab.</div>;
  }
  if (item.kind === 'toc') {
    return (
      <div className="bk-toc">
        {toc.length === 0 && <div className="bk-placeholder">No sections yet.</div>}
        {toc.map((e, i) => (
          <div key={i} className={`bk-toc-entry${e.isTextHeader ? ' bk-toc-head' : ''}`}
               style={{ paddingLeft: `${e.level * 5}mm` }}>
            {/* Inner HTML (block tags already flattened) so entities/emphasis render as
                on the body headings, not as raw &#x27; text. */}
            <span className="bk-toc-title" dangerouslySetInnerHTML={{ __html: e.title }} />
            <span className="bk-toc-dots" />
            <span className="bk-toc-page">{e.page}</span>
          </div>
        ))}
      </div>
    );
  }
  if (item.kind === 'image_page') {
    return item.has_image
      ? (
        <div className="bk-imagepage">
          <img className="bk-image" src={itemImageUrl(item.id)} alt="" />
          {body && (
            <div className="bk-image-caption"
                 dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />
          )}
        </div>
      )
      : <div className="bk-placeholder">Image page — add an image in the Documents tab.</div>;
  }
  return null;
};

/** A furniture page as a facing-page mock (bench use). */
export const FurniturePage: React.FC<{
  item: DocumentItem; titleLines: DocLine[]; body: string | null; toc: TocRow[];
}> = (props) => (
  <div className="booklet-spread">
    <div className="booklet-page furniture">
      <div className="booklet-content"><FurnitureContent {...props} /></div>
    </div>
  </div>
);

/** A text's internal title page as a facing-page mock (bench use). */
export const InternalTitlePage: React.FC<{ titleLines: DocLine[] }> = ({ titleLines }) => (
  <div className="booklet-spread">
    <div className="booklet-page furniture">
      <div className="booklet-content"><TitleContent titleLines={titleLines} /></div>
    </div>
  </div>
);

// ── Composition (shared by bench + print) ──────────────────────────────────────

export type PageUnit =
  | { kind: 'spread'; s: { start: number; end: number } }
  | { kind: 'title'; item: DocumentItem; titleLines: DocLine[] };

/** A node in the PDF navigation outline (bookmarks): plain-text title, the 0-based
 *  PHYSICAL page index the bookmark points at, the reader-facing `folio` (recto page
 *  number, for previews), and nested children (a text's sapche sections). */
export interface NavNode { title: string; pageIndex: number; folio: number; children: NavNode[] }

export interface DerivedBooklet {
  breakSet: Set<number>;
  hairlineSet: Set<number>;
  spreads: { start: number; end: number }[];
  bodyUnits: PageUnit[];
  frontMatter: DocumentItem[];
  backMatter: DocumentItem[];
  tocRows: TocRow[];
  mainTitleLines: DocLine[];
  /** Recto folio (1-based) of the body-unit holding line `idx`. */
  folioOfLine: (idx: number) => number;
  /** The full navigation hierarchy (per text → its sapche sections) for PDF bookmarks. */
  navOutline: NavNode[];
}

/** Flatten a translation body to a single inline HTML run: sanitize, drop block tags
 *  (p/div/br → space), keep inline emphasis + entities — so a TOC entry renders like
 *  the body heading it mirrors (entities decoded), not as raw `&#x27;` text. */
const inlineHtml = (h: string) =>
  sanitizeTranslationHtml(h)
    .replace(/<\/?(?:p|div)\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Plain-text projection (entities decoded, tags stripped) — for PDF bookmark labels. */
const plainTextOf = (h: string): string => {
  if (!h) return '';
  if (!/[<>&]/.test(h)) return h.replace(/\s+/g, ' ').trim();
  return new DOMParser().parseFromString(h, 'text/html').body.textContent
    ?.replace(/\s+/g, ' ').trim() ?? '';
};

/** Build a nested outline from flat sapche entries, nesting by their depth `level`. */
function nestByLevel(items: { title: string; pageIndex: number; folio: number; level: number }[]): NavNode[] {
  const roots: NavNode[] = [];
  const stack: { node: NavNode; level: number }[] = [];
  for (const it of items) {
    const node: NavNode = { title: it.title, pageIndex: it.pageIndex, folio: it.folio, children: [] };
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ node, level: it.level });
  }
  return roots;
}

/** Pure composition of a document's page structure from its items, stored layout rows,
 *  compiled line stream and lifted per-text titles. Deterministic → the bench and the
 *  print/PDF path lay out identically. */
export function deriveBooklet(
  items: DocumentItem[],
  rows: DocumentLayoutRow[],
  lines: DocLine[],
  titleByItem: Map<number, DocLine[]>,
  furniture?: DocumentFurnitureRow[],
  lang?: string,
): DerivedBooklet {
  const findIdx = (r: DocumentLayoutRow) =>
    lines.findIndex((l) => l.itemId === r.item_id && l.startSylId === r.anchor_syl_id);
  const breakSet = new Set<number>();
  const hairlineSet = new Set<number>();
  for (const r of rows) {
    if (r.kind === 'page_break') { const i = findIdx(r); if (i > 0) breakSet.add(i); }
    else if (r.kind === 'hairline') { const i = findIdx(r); if (i > 0) hairlineSet.add(i); }
  }

  // Each text always starts a fresh spread (so its internal title page sits cleanly
  // before its first body page — no two texts share a spread).
  const spreads: { start: number; end: number }[] = [];
  if (lines.length) {
    const forced = new Set<number>(breakSet);
    for (let i = 1; i < lines.length; i++) if (lines[i].itemId !== lines[i - 1].itemId) forced.add(i);
    const starts = [0, ...Array.from(forced).sort((a, b) => a - b)];
    starts.forEach((s, i) => spreads.push({ start: s, end: i + 1 < starts.length ? starts[i + 1] : lines.length }));
  }

  const textItems = items.filter((it) => it.kind === 'text' && it.text_id != null);
  const firstTextPos = textItems.length ? Math.min(...textItems.map((i) => i.position)) : Infinity;
  const lastTextPos = textItems.length ? Math.max(...textItems.map((i) => i.position)) : -Infinity;
  const firstTextItemId = firstTextPos !== Infinity
    ? textItems.find((i) => i.position === firstTextPos)!.id : null;
  const frontMatter = items
    .filter((it) => it.kind !== 'text' && it.position < firstTextPos)
    .sort((a, b) => a.position - b.position);
  const backMatter = items
    .filter((it) => it.kind !== 'text' && it.position > lastTextPos)
    .sort((a, b) => a.position - b.position);

  const itemStartLine = new Map<number, number>();
  lines.forEach((l, i) => { if (!itemStartLine.has(l.itemId)) itemStartLine.set(l.itemId, i); });

  const bodyUnits: PageUnit[] = [];
  for (const s of spreads) {
    const startItemId = lines[s.start]?.itemId;
    const startsText = startItemId != null && itemStartLine.get(startItemId) === s.start;
    if (startsText && startItemId !== firstTextItemId) {
      const item = textItems.find((i) => i.id === startItemId);
      const tl = titleByItem.get(startItemId) ?? [];
      if (item && tl.length) bodyUnits.push({ kind: 'title', item, titleLines: tl });
    }
    bodyUnits.push({ kind: 'spread', s });
  }

  const spreadUnitIdx = new Map<number, number>();
  bodyUnits.forEach((u, i) => { if (u.kind === 'spread') spreadUnitIdx.set(u.s.start, i); });
  const folioOfLine = (idx: number) => {
    for (const u of bodyUnits) {
      if (u.kind === 'spread' && u.s.start <= idx && idx < u.s.end) return (spreadUnitIdx.get(u.s.start) ?? 0) + 1;
    }
    return 1;
  };

  // TOC = ONE flat entry per included text (like the reference booklets): an EDITABLE
  // title + the text's start folio. The title is the per-language override authored in
  // the Documents tab (stored as furniture on the text item); absent that, it falls back
  // to the text's auto main-title, then its DB title.
  const orderedTexts = [...textItems].sort((a, b) => a.position - b.position);
  const tocRows: TocRow[] = orderedTexts.map((it) => {
    const custom = furniture && lang != null ? furnitureBodyOf(furniture, it, lang) : null;
    let title: string;
    if (custom && custom.trim()) {
      title = inlineHtml(custom);
    } else {
      const tl = titleByItem.get(it.id) ?? [];
      const main = tl.find((t) => t.paragraphs?.length)?.paragraphs?.[0] ?? tl[0]?.translation;
      title = main ? inlineHtml(main) : (it.text_title || '');
    }
    // The text's start folio: its internal title page (2nd+ texts) or its first body page.
    const titleUnit = bodyUnits.findIndex((u) => u.kind === 'title' && u.item.id === it.id);
    const startLine = itemStartLine.get(it.id);
    const page = titleUnit >= 0 ? titleUnit + 1 : (startLine != null ? folioOfLine(startLine) : 1);
    return { title, page, level: 0 };
  });
  const mainTitleLines = firstTextItemId != null ? (titleByItem.get(firstTextItemId) ?? []) : [];

  // ── PDF navigation outline (bookmarks) ──
  // Physical page index (0-based) of each body-unit's base page: front matter = F pages,
  // each spread = 2 (verso, recto), each title unit = 1. A section heading sits on the
  // spread's RECTO, so its bookmark points at unitBase+1.
  const F = frontMatter.length;
  const unitBase: number[] = [];
  { let p = F; for (const u of bodyUnits) { unitBase.push(p); p += u.kind === 'spread' ? 2 : 1; } }
  const rectoPageOfLine = (idx: number) => {
    for (let j = 0; j < bodyUnits.length; j++) {
      const u = bodyUnits[j];
      if (u.kind === 'spread' && u.s.start <= idx && idx < u.s.end) return unitBase[j] + 1;
    }
    return F;
  };
  const navOutline: NavNode[] = orderedTexts.map((it) => {
    const custom = furniture && lang != null ? furnitureBodyOf(furniture, it, lang) : null;
    let titleSrc: string;
    if (custom && custom.trim()) titleSrc = custom;
    else {
      const tl = titleByItem.get(it.id) ?? [];
      titleSrc = (tl.find((t) => t.paragraphs?.length)?.paragraphs?.[0] ?? tl[0]?.translation) || it.text_title || '';
    }
    const titleUnitIdx = bodyUnits.findIndex((u) => u.kind === 'title' && u.item.id === it.id);
    const startLine = itemStartLine.get(it.id);
    const pageIndex = titleUnitIdx >= 0 ? unitBase[titleUnitIdx]
      : (startLine != null ? rectoPageOfLine(startLine) : F);
    const folio = startLine != null ? folioOfLine(startLine) : 1;
    const sections: { title: string; pageIndex: number; folio: number; level: number }[] = [];
    lines.forEach((l, i) => {
      if (l.itemId !== it.id || l.role !== 'sapche' || !l.translation) return;
      sections.push({
        title: plainTextOf(l.translation), pageIndex: rectoPageOfLine(i),
        folio: folioOfLine(i), level: l.level ?? 0,
      });
    });
    return { title: plainTextOf(titleSrc), pageIndex, folio, children: nestByLevel(sections) };
  });

  return { breakSet, hairlineSet, spreads, bodyUnits, frontMatter, backMatter, tocRows,
           mainTitleLines, folioOfLine, navOutline };
}

/** The per-language authored body of a furniture item (copyright text etc.). */
export function furnitureBodyOf(
  furniture: DocumentFurnitureRow[], item: DocumentItem, lang: string,
): string | null {
  return furniture.find((f) => f.item_id === item.id && f.lang === lang)?.body ?? null;
}
