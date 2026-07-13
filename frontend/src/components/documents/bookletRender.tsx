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

export const Verso: React.FC<{
  l: DocLine; adj?: LineAdj;
  /** Split mode (bench): click a syllable to split the line before it (`k` = token index).
   *  On a line that is already a split half, any click clears the split (`k` = -1). */
  onSplit?: (k: number) => void;
}> = ({ l, adj = NO_ADJ, onSplit }) => {
  const split = l.splitAnchor != null;
  return (
    <div className={`bk-line bk-role-${l.role}${onSplit ? ' bk-splitmode' : ''}`}>
      <div className="bk-tibetan">
        {l.tokens.map((t, i) => (
          <span key={i}
                className={onSplit ? 'bk-syl' : undefined}
                onClick={onSplit ? () => onSplit(split ? -1 : i) : undefined}>
            {t.render}
          </span>
        ))}
      </div>
      {l.emptyAfter && <Gap adj={adj} />}
    </div>
  );
};

/* The recto unit, by role:
 *  - section (title/sapche): the translated heading only (Libertinus, large);
 *  - mantra: the romanised mantra only (the phonetics), standalone bold-italic;
 *  - verse/prose/small: an INTERLINEAR PAIR — phonetics then its indented translation,
 *    kept together (the whole `.bk-line` has break-inside: avoid). */
export const Recto: React.FC<{
  l: DocLine; adj?: LineAdj;
  /** Split mode (bench): render the single recto text as clickable words; clicking word
   *  `w` sets this edition's recto cut (the tail starts at word `w`). */
  onWordSplit?: (w: number) => void;
}> = ({ l, adj = NO_ADJ, onWordSplit }) => {
  const isSection = l.role === 'title' || l.role === 'sapche';
  const isMantra = l.role === 'mantra';

  // Split mode on a splittable line: show the single recto text as clickable words.
  if (onWordSplit && isSplittable(l) && (l.translation || l.phonetics)) {
    const isTrans = l.translation != null;
    const text = isTrans ? plainTextOf(l.translation!) : l.phonetics;
    const words = text.split(/\s+/).filter(Boolean);
    const cls = isTrans ? (isSection ? 'bk-section' : 'bk-translation') : 'bk-phonetics';
    return (
      <div className={`bk-line bk-pair bk-role-${l.role}`}>
        <div className={`${cls} bk-wordsplit`}>
          {words.map((w, i) => (
            <span key={i} className="bk-word" onClick={() => onWordSplit(i)}>{w} </span>
          ))}
        </div>
        {l.emptyAfter && <Gap adj={adj} />}
      </div>
    );
  }
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
 *  shared by the booklet cover and each text's internal title page. `seal` shows the ༀ
 *  ornament (cover only); `image` (a seal/logo) renders in its place when supplied. */
export const TitleContent: React.FC<{
  titleLines: DocLine[]; seal?: boolean; image?: React.ReactNode;
}> = ({ titleLines, seal, image }) => {
  // The translated title's parts: the first is the main title, the rest the subtitle.
  // Prefer the title chunk's `<p>` structure (carried on any title line); fall back to
  // one entry per title line.
  const trans = (titleLines.find((t) => t.paragraphs?.length)?.paragraphs)
    ?? titleLines.map((t) => t.translation).filter((x): x is string => !!x);
  return (
    <div className="bk-titlepage">
      {image}
      {seal && !image && <div className="bk-seal">ༀ</div>}
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
  // The imported image, sized from the stored width/height (mm); null = natural.
  const sized = item.image_width_mm != null || item.image_height_mm != null;
  const imgStyle: React.CSSProperties = {
    width: item.image_width_mm ? `${item.image_width_mm}mm` : undefined,
    height: item.image_height_mm ? `${item.image_height_mm}mm` : undefined,
  };
  const bkImage = <img className={`bk-image${sized ? '' : ' bk-image-nat'}`}
                       src={itemImageUrl(item.id)} style={imgStyle} alt="" />;

  if (item.kind === 'cover') {
    // The seal is a real imported image when present (else the ༀ glyph), above the title.
    return <TitleContent titleLines={titleLines} seal image={item.has_image ? bkImage : undefined} />;
  }
  if (item.kind === 'copyright') {
    // The copyright ("second cover") emblem above the copyright text.
    if (!item.has_image && !body) {
      return <div className="bk-copyright bk-placeholder">Copyright text — add it in the Documents tab.</div>;
    }
    return (
      <div className="bk-copyright">
        {item.has_image && bkImage}
        {body && <div dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />}
      </div>
    );
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
          {bkImage}
          {body && (
            <div className="bk-image-caption"
                 dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />
          )}
        </div>
      )
      : <div className="bk-placeholder">Image page — add an image in the Documents tab.</div>;
  }
  if (item.kind === 'backcover') {
    // Optional image and/or per-language text, centred; empty otherwise.
    if (!item.has_image && !body) return null;
    return (
      <div className="bk-backcover">
        {item.has_image && bkImage}
        {body && <div className="bk-copyright"
                      dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />}
      </div>
    );
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
  /** The render line stream — `srcLines` with any mid-line splits applied (head/tail).
   *  Spreads/breakSet index into THIS; consumers render from it. */
  lines: DocLine[];
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

/** A line is splittable (mid-line) only when its recto is a SINGLE element — a homage/
 *  `small` line (translation only) or a mantra (phonetics only). Interlinear phonetics+
 *  translation pairs are never split. */
export const isSplittable = (l: { phonetics: string; translation: string | null }): boolean =>
  !(l.phonetics && l.translation);

/** Split a space-separated plain string at word index `w`. */
function splitWordsPlain(s: string, w: number): [string, string] {
  const parts = s.split(/\s+/).filter(Boolean);
  const cut = Math.max(0, Math.min(parts.length, w));
  return [parts.slice(0, cut).join(' '), parts.slice(cut).join(' ')];
}

/** Split an inline-HTML translation at word index `w`, preserving inline tags via a DOM
 *  Range (cloneContents closes partially-selected ancestors). */
function splitHtmlAtWord(html: string, w: number): [string, string] {
  if (w <= 0) return ['', html];
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  const frag = tmpl.content;
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  let count = 0; let target: Node | null = null; let offset = 0; let node: Node | null;
  outer: while ((node = walker.nextNode())) {
    const re = /\S+/g; let m: RegExpExecArray | null;
    while ((m = re.exec(node.nodeValue || ''))) {
      if (count === w) { target = node; offset = m.index; break outer; }
      count++;
    }
  }
  if (!target || !frag.firstChild) return [html, ''];
  const ser = (f: DocumentFragment) => { const d = document.createElement('div'); d.appendChild(f); return d.innerHTML.trim(); };
  const head = document.createRange();
  head.setStart(frag, 0); head.setEnd(target, offset);
  const tail = document.createRange();
  tail.setStart(target, offset); tail.setEndAfter(frag.lastChild!);
  return [ser(head.cloneContents()), ser(tail.cloneContents())];
}

/** Split a line at token (syllable) index `k` (Tibetan, shared across editions — never
 *  cuts a syllable) into head + tail. The SINGLE recto text (translation for a homage
 *  line, phonetics for a mantra) is cut at the per-language word index `rectoCut`; with
 *  none set the whole recto text stays on the head. */
function splitDocLine(l: DocLine, k: number, rectoCut: number | null): [DocLine, DocLine] {
  const rc = rectoCut ?? Number.MAX_SAFE_INTEGER;   // undefined → whole recto on head
  let hPhon = l.phonetics, tPhon = '';
  let hTrans = l.translation, tTrans: string | null = null;
  if (l.translation) [hTrans, tTrans] = splitHtmlAtWord(l.translation, rc);
  else if (l.phonetics) [hPhon, tPhon] = splitWordsPlain(l.phonetics, rc);
  const head: DocLine = {
    ...l, key: `${l.key}#h`, tokens: l.tokens.slice(0, k), endSylId: l.tokens[k - 1].id,
    phonetics: hPhon, translation: hTrans, emptyAfter: false, splitAnchor: l.startSylId,
  };
  const tail: DocLine = {
    ...l, key: `${l.key}#t`, tokens: l.tokens.slice(k), startSylId: l.tokens[k].id,
    phonetics: tPhon, translation: tTrans, emptyAfter: l.emptyAfter, splitAnchor: l.startSylId,
  };
  return [head, tail];
}

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
  srcLines: DocLine[],
  titleByItem: Map<number, DocLine[]>,
  furniture?: DocumentFurnitureRow[],
  lang?: string,
  /** Split-edit mode (bench): ignore recto cuts so the whole recto text shows on the head
   *  for word-picking. The Tibetan still splits. */
  editRecto = false,
): DerivedBooklet {
  // Apply mid-line splits first: a page_break row carrying a `char_offset` splits its
  // (non-pair) line at that syllable (token) index into head + tail, reusing the hairline-
  // break machinery between them. The recto text is cut at the per-language `recto_cut`
  // word index. Everything downstream operates on the augmented `lines`.
  const splitAt = new Map<string, number>();
  const rectoCutAt = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === 'page_break' && r.char_offset != null && r.char_offset > 0) {
      splitAt.set(`${r.item_id}:${r.anchor_syl_id}`, r.char_offset);
    } else if (r.kind === 'recto_cut' && r.char_offset != null && (r.lang ?? '') === (lang ?? '')) {
      rectoCutAt.set(`${r.item_id}:${r.anchor_syl_id}`, r.char_offset);
    }
  }
  const lines: DocLine[] = [];
  const splitTails = new Set<number>();   // indices in `lines` that are split tails
  for (const l of srcLines) {
    const key = `${l.itemId}:${l.startSylId}`;
    const k = splitAt.get(key);
    if (k != null && k > 0 && k < l.tokens.length && isSplittable(l)) {
      const [head, tail] = splitDocLine(l, k, editRecto ? null : (rectoCutAt.get(key) ?? null));
      lines.push(head);
      splitTails.add(lines.length);
      lines.push(tail);
    } else {
      lines.push(l);
    }
  }

  const findIdx = (r: DocumentLayoutRow) =>
    lines.findIndex((l) => l.itemId === r.item_id && l.startSylId === r.anchor_syl_id);
  const breakSet = new Set<number>();
  const hairlineSet = new Set<number>();
  for (const r of rows) {
    if (r.kind === 'page_break') {
      if (r.char_offset != null && r.char_offset > 0) continue;   // applied as a split
      const i = findIdx(r); if (i > 0) breakSet.add(i);
    } else if (r.kind === 'hairline') { const i = findIdx(r); if (i > 0) hairlineSet.add(i); }
  }
  // A split forces a break + hairline between its head and tail.
  for (const i of splitTails) { breakSet.add(i); hairlineSet.add(i); }

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

  return { lines, breakSet, hairlineSet, spreads, bodyUnits, frontMatter, backMatter, tocRows,
           mainTitleLines, folioOfLine, navOutline };
}

/** The per-language authored body of a furniture item (copyright text etc.). */
export function furnitureBodyOf(
  furniture: DocumentFurnitureRow[], item: DocumentItem, lang: string,
): string | null {
  return furniture.find((f) => f.item_id === item.id && f.lang === lang)?.body ?? null;
}
