import React from 'react';
import {
  itemImageUrl, orgSealUrl,
  type DocumentItem, type LayoutConfig, type DocumentLayoutRow, type DocumentFurnitureRow,
  type OrgSeal,
} from '../../api/client';
import { splitParagraphs, type DocLine, type OutlineHeading } from './compile';
import { sanitizeTranslationHtml } from '../translate/sanitize';
import { forEachWord } from './bookletMeasure';

/**
 * Shared booklet rendering (Phase D2/D3).
 *
 * THE RULE, in the user's words: "I aim at printing exactly what I see in the layout, except
 * for the guides that will be removed."
 *
 * So the pagination bench (interactive) and the print page (static, for the Chromium PDF) use
 * the SAME components here and the SAME `deriveBooklet` composition, and no layout rule is
 * ever scoped to one of them. Anything that moves ink belongs in this file, or in a
 * `booklet.css` rule that both pages match.
 *
 * The only things that may differ are the design aids, which the print root never carries and
 * `@media print` blocks besides: the geometry guides, the width grips, the break and gap
 * controls, the sliders, the overfull badge, the shift mark. Interactivity is layered on top
 * by the bench through the optional `LineAdj` handlers.
 *
 * This is not a nicety. The auto-pagination MEASURES these very components: a rule that
 * applied only to the printed page would flow every page against type the PDF does not set,
 * and the guarantee that no page overflows would stop meaning anything.
 */

export const MM_PX = 96 / 25.4;

/** Map a section heading's outline depth (`DocLine.level`, 0-based from the sapche tree;
 *  null → top) to one of the three section-title style tiers (`.bk-section-l1/-l2/-l3`).
 *  Depth 0 → tier 1, depth 1 → tier 2, depth ≥2 → tier 3. Bump the `3` to add more tiers. */
export const LEVEL_SECTION_STYLE = (level: number | null): number =>
  Math.min(3, Math.max(1, (level ?? 0) + 1));

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

/** The text blocks a line can render, each independently widenable. A line shows some
 *  subset: `tibetan` on the verso; on the recto either `section`, or a mantra's
 *  `phonetics`, or a `phonetics` + `translation` pair. */
export type WidthTarget = 'tibetan' | 'phonetics' | 'translation' | 'section';

/** How far a block may be dragged, in mm. `max` differs by page: reaching the right
 *  physical border means eating that page's whole right padding — the outer margin on a
 *  recto, the binding margin on a verso. `min` is negative (how far it can be narrowed). */
export interface WidthRange { min: number; maxVerso: number; maxRecto: number }

/** Balancing state applied to one line, plus (interactive only) the handlers. */
export interface LineAdj {
  gapDeltaMm: number;   // empty-line spacing delta
  noSpace: boolean;     // blank line removed
  /** Signed width delta per block, in mm (see WidthLine). Absent = natural width. */
  widths?: Partial<Record<WidthTarget, number>>;
  widthRange?: WidthRange;
  onGap?: (delta: number) => void;
  onToggleNoSpace?: () => void;
  /** Persist a block's new width (null clears it). Absent = non-interactive (print). */
  onWidth?: (target: WidthTarget, mm: number | null) => void;
}
export const NO_ADJ: LineAdj = { gapDeltaMm: 0, noSpace: false };

const DEFAULT_RANGE: WidthRange = { min: -60, maxVerso: 10, maxRecto: 10 };
/** Below this (mm) a width is indistinguishable from natural — store nothing. */
const WIDTH_EPS = 0.3;

/**
 * One width-adjustable text block. The stored `valueMm` is a SIGNED delta applied as
 * `margin-right: -valueMm` — positive pulls the right edge outward (the text overflows
 * toward the page's physical border, which `.booklet-page { overflow: hidden }` clips),
 * negative pushes it inward (the block narrows and its text wraps).
 *
 * With `onCommit` it grows a hover-revealed grip on that right edge: dragging slides the
 * edge, previewing locally (so the text reflows live under the pointer) and persisting
 * once on release. Without it — the print page and the measurement pass — it is a plain
 * wrapper that just applies the stored width, which is what keeps the PDF and the
 * auto-pagination measurements identical to the bench.
 */
export const WidthLine: React.FC<{
  valueMm: number; min: number; max: number;
  onCommit?: (mm: number | null) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ valueMm, min, max, onCommit, className, style, children }) => {
  const [preview, setPreview] = React.useState<number | null>(null);
  // The drag's live value lives on the ref, NOT in `preview`. The state is for painting; if
  // the release were to read it, it would read whatever React had last committed — and when
  // the move and the release land in one batch (a very fast drag, coalesced input, a
  // synthetic one) that is still the value from before the drag, so the release looks like a
  // click and the whole drag is silently dropped.
  const drag = React.useRef<{ x: number; from: number; cur: number } | null>(null);
  const cur = preview ?? valueMm;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!onCommit) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { x: e.clientX, from: valueMm, cur: valueMm };
    setPreview(valueMm);
    // Capture keeps the drag alive when the pointer outruns the 6px grip.
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Dragging right widens: the pointer's travel IS the edge's travel.
    const next = Math.max(min, Math.min(max, d.from + (e.clientX - d.x) / MM_PX));
    d.cur = next;
    setPreview(next);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const final = d.cur;
    setPreview(null);
    try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    if (Math.abs(final - d.from) < 0.05) return;          // a click, not a drag
    onCommit?.(Math.abs(final) < WIDTH_EPS ? null : Number(final.toFixed(2)));
  };

  return (
    // `bk-widthline` marks EVERY width-adjustable block, and is what reveals the grip on
    // hover. The reveal used to name the four body classes it knew about, so every block
    // added afterwards — the titles, the copyright, the TOC entries — rendered a grip that
    // was never shown: present in the DOM, invisible on the page. A block is adjustable
    // because it is a WidthLine, so that is what the CSS should ask about.
    <div className={`bk-widthline${className ? ` ${className}` : ''}`}
         style={{ ...style, marginRight: `${-cur}mm`, position: 'relative' }}>
      {children}
      {onCommit && (
        <span className="bk-widthgrip"
              title="Drag to overflow the line to the page border, or back to wrap it"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag} />
      )}
    </div>
  );
};

/**
 * One special page's block, asking for its width.
 *
 * The special pages take their text from two places, and the anchoring follows that seam
 * exactly rather than inventing a scheme:
 *  - the Tibetan title is a REAL line lifted out of the text, with real syllables, so it
 *    anchors like any body line — the key is its `startSylId`, shared across editions;
 *  - everything else (main title, subtitle, copyright, back cover, caption, the TOC) is
 *    `document_furniture`, keyed by (item, lang) with no syllable anywhere near it — so the
 *    key is a block name like `#title_main`, and it is per edition.
 * No syllable uuid begins with '#', so the caller can tell them apart by shape alone.
 */
export type BlockWidthOf = (key: string) => {
  valueMm: number; min: number; max: number; onCommit?: (mm: number | null) => void;
};

/** No width control at all — the print page, and any caller that has not wired it. */
const NO_WIDTH: BlockWidthOf = () => ({ valueMm: 0, min: 0, max: 0 });

/**
 * A line's anchor — what the booklet stores its breaks, widths and fills against.
 *
 * A syllable id is position-unique WITHIN a text, so for years it was identity enough. It is
 * not, once a text transcludes: a transclusion reuses its source's syllables by design (that
 * is what makes annotations ripple into every site), so a text that pulls the same source in
 * twice repeats those uuids, and `(item, syllable)` names two different lines at once. This
 * booklet has 168 such syllables, sitting under four separate transclusion ops.
 *
 * The occurrence is already named upstream: `op_id`, the derivation op that emitted the
 * token. `(id, op_id)` is unique — verified on the real text: 168 repeated ids, zero repeated
 * pairs. So the anchor is the syllable, plus the op where the op is what makes it ambiguous.
 *
 * A text's OWN syllables have no op and keep the bare uuid, which is what every row written
 * before this used — so old rows go on resolving, and the vast majority of new ones are
 * byte-for-byte what they always were. `#` cannot occur in a uuid, and a furniture block key
 * already starts with one, so the three forms never collide.
 */
export const anchorOf = (l: DocLine): string =>
  l.opId != null ? `${l.startSylId}#${l.opId}` : l.startSylId;

/** The anchor a line's SPLIT rows hang off — the original line's, so head and tail agree. */
export const splitAnchorOf = (l: DocLine): string => l.splitAnchor ?? anchorOf(l);

/** The width props for one block of a line, from its `LineAdj`. */
function widthProps(adj: LineAdj, target: WidthTarget, verso: boolean) {
  const r = adj.widthRange ?? DEFAULT_RANGE;
  return {
    valueMm: adj.widths?.[target] ?? 0,
    min: r.min,
    max: verso ? r.maxVerso : r.maxRecto,
    onCommit: adj.onWidth ? (mm: number | null) => adj.onWidth!(target, mm) : undefined,
  };
}

/** The empty-line gap between chunks — the primary balancing lever. Tuned per SIDE and per
 *  EDITION (the rows ride `gapFillLang`'s seam, like the page fill): the verso's gaps are
 *  the Tibetan's, set once for every booklet; a recto's are that edition's own. `side` only
 *  feeds the buttons' tooltips — the values arrive already resolved in `adj`. */
export const Gap: React.FC<{ adj: LineAdj; side?: PageSide }> = ({ adj, side }) => {
  const scope = side === 'verso'
    ? ' The Tibetan page only — every edition prints the same one, so this is set once.'
    : side === 'recto'
    ? ' This edition’s translation page only.'
    : '';
  if (adj.noSpace) {
    return adj.onToggleNoSpace ? (
      <div className="bk-gap-removed">
        <button type="button" className="bk-gapctl" title={`Restore blank line.${scope}`}
                onClick={adj.onToggleNoSpace}>+ line</button>
      </div>
    ) : null;
  }
  return (
    // The height is authored here, inline, so it beats the stylesheet — which means the
    // page's `--gap-fill` has to be part of THIS sum, not a rule it would silently outrank.
    // Three terms: the natural blank line, this line's own tuning, and the page's fill.
    <div className="bk-gap"
         style={{ height: 'calc(var(--translation-pt) * var(--leading)'
                        + ` + ${adj.gapDeltaMm}mm + var(--gap-fill, 0mm))` }}>
      {adj.onGap && (
        <span className="bk-gapctl-group">
          <button type="button" className="bk-gapctl" title={`Less space.${scope}`} onClick={() => adj.onGap!(-1)}>−</button>
          <button type="button" className="bk-gapctl" title={`More space.${scope}`} onClick={() => adj.onGap!(1)}>+</button>
          <button type="button" className="bk-gapctl" title={`Remove blank line.${scope}`} onClick={adj.onToggleNoSpace}>×</button>
        </span>
      )}
    </div>
  );
};

/**
 * Does the Tibetan line at `i` swallow its trailing blank line?
 *
 * A ས་བཅད topic runs straight into the text it heads, so no blank line stands between a topic
 * group and the verse or prose under it. And inside a group a blank line means nothing at all:
 * consecutive topics share one printed line, so "a blank line after this one" is a statement
 * about a line that is not there — left in, it inflates the row they share.
 *
 * The Tibetan side only. On the recto a section heading carries its own space, above and
 * below, from its role — that is what a heading's margins are for.
 *
 * Shared, because the bench and the print page must decide this identically or the PDF stops
 * being what the bench showed.
 */
export function versoGapSuppressed(lines: DocLine[], i: number): boolean {
  if (lines[i]?.role !== 'sapche') return false;
  const next = lines[i + 1]?.role;
  return next === 'sapche' || next === 'verse' || next === 'prose';
}

export const Verso: React.FC<{
  l: DocLine; adj?: LineAdj;
  /** This line opens a page: suppress its space-above (see `.bk-atpagetop`). */
  atPageTop?: boolean;
  /** Drop this line's trailing blank line — see `versoGapSuppressed`. */
  noGap?: boolean;
  /** Split mode (bench): click a syllable to cut the line before it (`k` = token index
   *  within THIS line — the bench translates a tail's index back to the original). The
   *  same gesture places a new split or MOVES an existing one; clearing lives on the
   *  split's × chip, never on a syllable click (a click that destroys what the same click
   *  creates elsewhere is a slip machine). */
  onSplit?: (k: number) => void;
}> = ({ l, adj = NO_ADJ, atPageTop, noGap, onSplit }) => {
  return (
    <div className={`bk-line bk-role-${l.role}${onSplit ? ' bk-splitmode' : ''}`
                    + (atPageTop ? ' bk-atpagetop' : '')}>
      {/* Split mode owns the syllable clicks — no width grip competing for the pointer. */}
      <WidthLine className="bk-tibetan" {...widthProps(adj, 'tibetan', true)}
                 onCommit={onSplit ? undefined : widthProps(adj, 'tibetan', true).onCommit}>
        {/* `bk-tibetan-small` goes on the SYLLABLE, not the line. Small letters (ཡིག་ཆུང) and
            inline sapche topics are runs INSIDE a line: the line keeps one role, because it is
            one translation unit, while its type sizes differ mid-way. That is a character
            style — which is what it is in the source docx. `deriveChunks` has always flagged
            the tokens; the booklet was the one Tibetan renderer throwing that away, so a line
            holding both printed wholly at body size. Both editors already class the span this
            way. One span per token, never grouped: `onSplit` indexes `l.tokens` by position,
            and grouping would split lines at the wrong syllable. */}
        {l.tokens.map((t, i) => (
          <span key={i}
                className={[onSplit ? 'bk-syl' : '', t.small ? 'bk-tibetan-small' : '']
                            .filter(Boolean).join(' ') || undefined}
                onClick={onSplit ? () => onSplit(i) : undefined}>
            {t.render}
          </span>
        ))}
      </WidthLine>
      {l.emptyAfter && !noGap && <Gap adj={adj} side="verso" />}
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
  /** This line opens a page: suppress its space-above (see `.bk-atpagetop`). */
  atPageTop?: boolean;
  /** Split mode (bench): render the recto text(s) as clickable words; clicking word `w`
   *  sets this edition's cut in that ELEMENT (the tail starts at word `w`). A pair offers
   *  both its blocks — the phonetics cut and the translation cut are adjusted apart. */
  onWordSplit?: (element: 'phonetics' | 'translation', w: number) => void;
}> = ({ l, adj = NO_ADJ, atPageTop, onWordSplit }) => {
  const isSection = l.role === 'title' || l.role === 'sapche';
  const isMantra = l.role === 'mantra';
  const lineCls = `bk-line bk-pair bk-role-${l.role}` + (atPageTop ? ' bk-atpagetop' : '');

  // Split mode: every recto text becomes clickable words. On a pair BOTH blocks do — one
  // click sets that element's cut and leaves the other's where it stands. The words shown
  // are the words the cut counts: `htmlWords` walks the translation exactly as
  // `splitHtmlAtWord` will, so clicking word `w` cuts at word `w`, inline tags or not.
  if (onWordSplit && (l.translation || l.phonetics)) {
    const wordSpans = (words: string[], element: 'phonetics' | 'translation') =>
      words.map((w, i) => (
        <span key={i} className="bk-word" onClick={() => onWordSplit(element, i)}>{w} </span>
      ));
    const phonWords = l.phonetics.split(/\s+/).filter(Boolean);
    if (l.phonetics && l.translation != null && !isSection && !isMantra) {
      return (
        <div className={lineCls}>
          <div className="bk-phonetics bk-wordsplit">{wordSpans(phonWords, 'phonetics')}</div>
          <div className="bk-translation bk-wordsplit">
            {wordSpans(htmlWords(l.translation), 'translation')}
          </div>
          {l.emptyAfter && <Gap adj={adj} side="recto" />}
        </div>
      );
    }
    const isTrans = l.translation != null;
    const cls = isTrans
      ? (isSection ? `bk-section bk-section-l${LEVEL_SECTION_STYLE(l.level)}` : 'bk-translation')
      : 'bk-phonetics';
    return (
      <div className={lineCls}>
        <div className={`${cls} bk-wordsplit`}>
          {isTrans ? wordSpans(htmlWords(l.translation!), 'translation')
                   : wordSpans(phonWords, 'phonetics')}
        </div>
        {l.emptyAfter && <Gap adj={adj} side="recto" />}
      </div>
    );
  }
  // Instruction line(s) merged onto this line: the continuation rule is a TIBETAN-side
  // rule — the verso concatenates, while the translation side keeps looking exactly as it
  // did before the merge existed. Each merged instruction renders as its OWN small block,
  // with the blank line that stood before it (`gapBefore`) reproduced — the pre-rule
  // standalone small line, minus the line-stream line. Never spliced into the paragraph.
  const trailBlocks = l.smallTrails?.map((t, i) => (
    <React.Fragment key={i}>
      {t.gapBefore && <Gap adj={adj} side="recto" />}
      <WidthLine className="bk-smalltrail" {...widthProps(adj, 'translation', false)}>
        <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(t.html) }} />
      </WidthLine>
    </React.Fragment>
  ));
  return (
    <div className={lineCls}>
      {isSection ? (
        l.translation != null && (
          <WidthLine className={`bk-section bk-section-l${LEVEL_SECTION_STYLE(l.level)}`}
                     {...widthProps(adj, 'section', false)}>
            <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
          </WidthLine>
        )
      ) : (
        <>
          {l.phonetics && (
            <WidthLine className="bk-phonetics" {...widthProps(adj, 'phonetics', false)}>
              {l.phonetics}
            </WidthLine>
          )}
          {!isMantra && l.translation != null && (
            <WidthLine className="bk-translation" {...widthProps(adj, 'translation', false)}>
              <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
            </WidthLine>
          )}
        </>
      )}
      {trailBlocks}
      {l.emptyAfter && <Gap adj={adj} side="recto" />}
    </div>
  );
};

export interface TocRow {
  title: string;
  page: number;
  /** The text item this entry points at — the entry's stable identity, so its width survives
   *  another text being added above it. */
  itemId?: number;
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
  /** Width control for this page's blocks (bench only; the print page passes nothing). */
  widthOf?: BlockWidthOf;
  /**
   * This booklet's own Tibetan for the title, if it has been given one — one line per line,
   * newline-separated. Empty or absent falls back to the text's, which is where the string
   * comes from in the first place: the field is seeded from it, so an override starts life as
   * a copy and diverges only where the editor says so. Clearing it returns to following the
   * text.
   */
  tibetan?: string | null;
}> = ({ titleLines, seal, image, widthOf = NO_WIDTH, tibetan }) => {
  // The booklet's own lines, or the text's. An override is plain text — it has no syllables,
  // so its lines anchor their widths on a block key instead (see `anchorOf`).
  const ownLines = (tibetan ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  // The translated title's parts: the first is the main title, the rest the subtitle.
  // Prefer the title chunk's `<p>` structure (carried on any title line); fall back to
  // one entry per title line.
  const trans = (titleLines.find((t) => t.paragraphs?.length)?.paragraphs)
    ?? titleLines.map((t) => t.translation).filter((x): x is string => !!x);
  return (
    <div className="bk-titlepage">
      {image}
      {seal && !image && <div className="bk-seal">ༀ</div>}
      {ownLines.length
        ? ownLines.map((line, i) => (
          <WidthLine key={`o${i}`} className="bk-tibetan bk-title-tib"
                     {...widthOf(`#title_tib${i}`)}>
            {line}
          </WidthLine>
        ))
        : titleLines.map((t, i) => (
          // A real line out of the text: anchored on its own syllable, like any body line,
          // and so shared by every edition.
          <WidthLine key={i} className="bk-tibetan bk-title-tib" {...widthOf(anchorOf(t))}>
            {/* No `bk-tibetan-small` here, deliberately. The role speaks in absolute points,
                so the class would pin a title's small run to 12pt inside 24pt type, where it
                wants roughly 18. The vocabulary cannot say "proportionally smaller", so the
                title abstains rather than be confidently wrong. */}
            {t.tokens.map((tk, k) => <span key={k}>{tk.render}</span>)}
          </WidthLine>
        ))}
      {trans[0] && (
        <WidthLine className="bk-title-main" {...widthOf('#title_main')}>
          <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(trans[0]) }} />
        </WidthLine>
      )}
      {trans.slice(1).map((p, i) => (
        <WidthLine key={`sub${i}`} className="bk-title-sub" {...widthOf(`#title_sub${i}`)}>
          <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(p) }} />
        </WidthLine>
      ))}
    </div>
  );
};

/**
 * A furniture body's authored LINES, each independently resizable.
 *
 * "Every line in the PDF" means every line the author wrote: a `<p>` of the copyright, of a
 * caption, of the back cover. Visually wrapped lines are not elements and cannot carry a
 * control; the paragraph is the finest thing that can.
 *
 * They sit inside ONE wrapper rather than becoming children of the page directly, and that
 * is load-bearing twice over. `.bk-copyright` and `.bk-backcover` are flex columns: flex
 * items do NOT margin-collapse, so paragraphs made into items would space themselves twice
 * as far apart; inside the wrapper they are ordinary blocks and collapse as they always did.
 * And a flex item shrinks to fit, which leaves a width control nothing to say — the wrapper
 * stretches instead, so each line spans the text block and narrowing one actually rewraps it.
 * Centred text stays centred: `text-align` does that, not the box's width.
 */
const FurnitureLines: React.FC<{
  body: string; block: string; widthOf: BlockWidthOf; className?: string;
}> = ({ body, block, widthOf, className }) => {
  const paras = splitParagraphs(body);
  if (!paras.length) return null;
  return (
    <div className="bk-fbody">
      {paras.map((para, i) => (
        <WidthLine key={i} className={className} {...widthOf(`#${block}${i}`)}>
          <p dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(para) }} />
        </WidthLine>
      ))}
    </div>
  );
};

/** The inner content of a furniture page (cover/copyright/toc/image), WITHOUT the page
 *  frame — so the bench (facing-page mock) and the print page (physical sheet) can each
 *  wrap it in their own page element. */
export const FurnitureContent: React.FC<{
  item: DocumentItem; titleLines: DocLine[]; body: string | null; toc: TocRow[];
  /** The ORG's seal (Style Studio) — the cover ornament of every booklet in the template. */
  orgSeal?: OrgSeal | null;
  /** Width control for this page's blocks (bench only; the print page passes nothing). */
  widthOf?: BlockWidthOf;
  /** This booklet's own Tibetan for the cover title (see `TitleContent`). */
  tibetan?: string | null;
}> = ({ item, titleLines, body, toc, orgSeal, widthOf = NO_WIDTH, tibetan }) => {
  // The imported image, sized from the stored width/height (mm); null = natural.
  const sized = item.image_width_mm != null || item.image_height_mm != null;
  const imgStyle: React.CSSProperties = {
    width: item.image_width_mm ? `${item.image_width_mm}mm` : undefined,
    height: item.image_height_mm ? `${item.image_height_mm}mm` : undefined,
  };
  const bkImage = <img className={`bk-image${sized ? '' : ' bk-image-nat'}`}
                       src={itemImageUrl(item.id)} style={imgStyle} alt="" />;

  if (item.kind === 'cover') {
    // At the ༀ ornament's place: this booklet's own cover image if it has one, else the org's
    // seal from the template, else (neither) the ༀ glyph — see TitleContent.
    const sealSized = orgSeal?.width_mm != null || orgSeal?.height_mm != null;
    const sealImage = orgSeal?.has_image
      ? <img className={`bk-image${sealSized ? '' : ' bk-image-nat'}`} src={orgSealUrl()} alt=""
             style={{ width: orgSeal.width_mm ? `${orgSeal.width_mm}mm` : undefined,
                      height: orgSeal.height_mm ? `${orgSeal.height_mm}mm` : undefined }} />
      : undefined;
    return <TitleContent titleLines={titleLines} seal widthOf={widthOf} tibetan={tibetan}
                        image={item.has_image ? bkImage : sealImage} />;
  }
  if (item.kind === 'copyright') {
    // The copyright ("second cover") emblem above the copyright text.
    if (!item.has_image && !body) {
      return <div className="bk-copyright bk-placeholder">Copyright text — add it in the Documents tab.</div>;
    }
    return (
      <div className="bk-copyright">
        {item.has_image && bkImage}
        {body && <FurnitureLines body={body} block="copyright" widthOf={widthOf} />}
      </div>
    );
  }
  if (item.kind === 'toc') {
    return (
      <div className="bk-toc">
        {toc.length === 0 && <div className="bk-placeholder">No sections yet.</div>}
        {toc.map((e, i) => (
          <WidthLine key={i} className={`bk-toc-entry${e.isTextHeader ? ' bk-toc-head' : ''}`}
                     style={{ paddingLeft: `${e.level * 5}mm` }}
                     {...widthOf(`#toc:${e.itemId ?? i}`)}>
            {/* Inner HTML (block tags already flattened) so entities/emphasis render as
                on the body headings, not as raw &#x27; text. */}
            <span className="bk-toc-title" dangerouslySetInnerHTML={{ __html: e.title }} />
            <span className="bk-toc-dots" />
            <span className="bk-toc-page">{e.page}</span>
          </WidthLine>
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
            <FurnitureLines body={body} block="caption" widthOf={widthOf}
                            className="bk-image-caption" />
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
        {body && <FurnitureLines body={body} block="backcover" widthOf={widthOf}
                                 className="bk-copyright" />}
      </div>
    );
  }
  return null;
};

/** A furniture page as a facing-page mock (bench use). */
export const FurniturePage: React.FC<{
  item: DocumentItem; titleLines: DocLine[]; body: string | null; toc: TocRow[];
  orgSeal?: OrgSeal | null;
  widthOf?: BlockWidthOf;
  tibetan?: string | null;
}> = (props) => (
  <div className="booklet-spread">
    <div className="booklet-page furniture">
      <div className="booklet-content"><FurnitureContent {...props} /></div>
    </div>
  </div>
);

/** A text's internal title page as a facing-page mock (bench use). */
export const InternalTitlePage: React.FC<{
  titleLines: DocLine[]; widthOf?: BlockWidthOf; tibetan?: string | null;
}> = ({ titleLines, widthOf, tibetan }) => (
  <div className="booklet-spread">
    <div className="booklet-page furniture">
      <div className="booklet-content">
        <TitleContent titleLines={titleLines} widthOf={widthOf} tibetan={tibetan} />
      </div>
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

/**
 * A `page_break` row's `value` records WHO put it there: 0/absent = the auto-flow seeded it
 * and a re-flow may move it; 1 = the user placed it by hand, and a re-flow must keep it and
 * flow around it. Without this the two are indistinguishable in the table and every re-flow
 * silently eats the user's decisions.
 *
 * `value` is this table's per-kind field, not a hack on it — `hairline` already stores a
 * bare `1` marker, `line_space` stores mm, `width_*` stores mm. A separate `page_break_auto`
 * KIND would be the hack: the unique key carries the kind, so one line could hold an auto
 * row and a manual row at once, and every consumer would have to reconcile them.
 *
 * Legacy rows predate the flag and read as auto — the same as today's behaviour, where a
 * re-flow replaced everything.
 */
export const BREAK_AUTO = 0;
export const BREAK_MANUAL = 1;
/** A break the user placed by hand. Splits (`char_offset > 0`) are a different animal and
 *  are never manual breaks in this sense — they are forced starts in their own right. */
export const isManualBreak = (r: DocumentLayoutRow) =>
  r.kind === 'page_break' && !(r.char_offset ?? 0) && (r.value ?? 0) === BREAK_MANUAL;

/** The two facing pages fill their slack INDEPENDENTLY — they are not two views of one
 *  thing. The Tibetan verso is far denser than the translation across from it and wants far
 *  more air; a single control would force one of them to be wrong. */
export type PageSide = 'verso' | 'recto';
export const GAP_FILL_KIND = { verso: 'gap_fill_verso', recto: 'gap_fill_recto' } as const;

/**
 * Which edition a side's fill belongs to.
 *
 * The same seam as everything else here: the VERSO is the same Tibetan in all four booklets,
 * so its fill is shared ('') and set once; the RECTO's text is the edition's own, so its
 * fill is the edition's own too. (This is exactly why `width_tibetan` is shared while
 * `width_translation` is not.)
 */
export const gapFillLang = (side: PageSide, lang: string) => (side === 'verso' ? '' : lang);

/**
 * How much every empty line on ONE page grows, in mm — that page's fill, anchored on its
 * first line.
 *
 * The breaks are shared, so the tallest edition drives them and every other page is left with
 * slack at the foot through no fault of its own. This is what spends it.
 *
 * Returned as a style object so the bench and the print page apply it the one same way — it
 * inherits from the page down to every `.bk-gap` inside (see `booklet.css`).
 */
export function gapFillVars(
  rows: DocumentLayoutRow[], line: DocLine | undefined, lang: string, side: PageSide,
): React.CSSProperties {
  const mm = pageRowMm(rows, line, GAP_FILL_KIND[side], gapFillLang(side, lang));
  return mm ? ({ ['--gap-fill' as string]: `${mm}mm` } as React.CSSProperties) : {};
}

/** One page-level row's mm, resolved on the page's first line. The line's anchor, or the
 *  bare syllable a row written before the op was part of it used (see `anchorOf`). */
function pageRowMm(
  rows: DocumentLayoutRow[], line: DocLine | undefined, kind: string, rowLang: string,
): number {
  if (!line) return 0;
  const a = anchorOf(line);
  return rows.find((x) => x.kind === kind && x.item_id === line.itemId
                       && (x.anchor_syl_id === a || x.anchor_syl_id === line.startSylId)
                       && (x.lang ?? '') === rowLang)?.value ?? 0;
}

/**
 * How far one page's whole content is moved, in SIGNED mm — down positive, up negative.
 *
 * The move of last resort. Opening the empty lines (`gap_fill_*`) spends a page's slack
 * first, but only to the limit of decent spacing; past that the block itself has to travel.
 * Unlike the gap fill it may put ink BETWEEN the text block's foot and the sheet's edge —
 * that is what it is for — and the page's own clip is what still bounds it.
 *
 * Split by side and by edition on the same seam as everything else here: the verso is the
 * same Tibetan in all four booklets, so its shift is shared; the recto's is its edition's.
 */
export const PAGE_SHIFT_KIND = { verso: 'page_shift_verso', recto: 'page_shift_recto' } as const;
export const pageShiftMm = (
  rows: DocumentLayoutRow[], line: DocLine | undefined, lang: string, side: PageSide,
): number => pageRowMm(rows, line, PAGE_SHIFT_KIND[side], gapFillLang(side, lang));

/** Everything one page's balancing puts on it. Both vars ride on `.booklet-page` and inherit
 *  down — the bench and the print page read the same rows through this one helper, so they
 *  cannot drift apart. */
export function pageVars(
  rows: DocumentLayoutRow[], line: DocLine | undefined, lang: string, side: PageSide,
): React.CSSProperties {
  const shift = pageShiftMm(rows, line, lang, side);
  return {
    ...gapFillVars(rows, line, lang, side),
    ...(shift ? { ['--page-shift' as string]: `${shift}mm` } : {}),
  } as React.CSSProperties;
}

export interface DerivedBooklet {
  /** The render line stream — `srcLines` with any mid-line splits applied (head/tail).
   *  Spreads/breakSet index into THIS; consumers render from it. */
  lines: DocLine[];
  breakSet: Set<number>;
  hairlineSet: Set<number>;
  /** Page starts the auto-flow may not negotiate: text-item boundaries and split tails.
   *  The seeder fills the runs between them. */
  forcedStarts: Set<number>;
  /** Breaks the user placed by hand — also hard starts for the seeder, and the rows a
   *  re-flow must not delete. */
  manualBreaks: Set<number>;
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

/** Split a space-separated plain string at word index `w`. */
function splitWordsPlain(s: string, w: number): [string, string] {
  const parts = s.split(/\s+/).filter(Boolean);
  const cut = Math.max(0, Math.min(parts.length, w));
  return [parts.slice(0, cut).join(' '), parts.slice(cut).join(' ')];
}

/** How many words a plain string holds — `splitWordsPlain`'s own tokenization. */
export const countWordsPlain = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** The words of an inline-HTML body, as display strings — `forEachWord`'s tokenization,
 *  which is also `splitHtmlAtWord`'s. NOT `textContent.split`: adjacent text nodes would
 *  merge two words across an inline tag boundary into one, and the indices shown would
 *  disagree with the cut they set. */
export function htmlWords(html: string): string[] {
  if (!html) return [];
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  const out: string[] = [];
  forEachWord(tmpl.content, (node, start, end) => {
    out.push((node.nodeValue || '').slice(start, end));
  });
  return out;
}

/** How many words an inline-HTML body holds — see `htmlWords`. */
export const countWordsHtml = (html: string): number => htmlWords(html).length;

/** Split an inline-HTML translation at word index `w`, preserving inline tags via a DOM
 *  Range (cloneContents closes partially-selected ancestors). Words are walked by
 *  `forEachWord` — the same walk the measurer reads rects with, so a measured index cuts
 *  exactly the word it measured. */
function splitHtmlAtWord(html: string, w: number): [string, string] {
  if (w <= 0) return ['', html];
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  const frag = tmpl.content;
  let target: Node | null = null; let offset = 0;
  forEachWord(frag, (node, start, _end, word) => {
    if (word === w) { target = node; offset = start; return false; }
  });
  if (!target || !frag.firstChild) return [html, ''];
  const ser = (f: DocumentFragment) => { const d = document.createElement('div'); d.appendChild(f); return d.innerHTML.trim(); };
  const head = document.createRange();
  head.setStart(frag, 0); head.setEnd(target, offset);
  const tail = document.createRange();
  tail.setStart(target, offset); tail.setEndAfter(frag.lastChild!);
  return [ser(head.cloneContents()), ser(tail.cloneContents())];
}

/** An edition's recto cut for a split PAIR line: `a` words of the phonetics and `b` of the
 *  translation stay on the head. Phonetics and translation are unbreakable pairs, so the
 *  two are one decision — never one without the other (see `defaultPairCut`). */
export interface PairCut { a: number; b: number }

/**
 * The pair cut an edition renders when none is stored: both elements cut at the Tibetan's
 * own fraction, so the head pair reads roughly with the head Tibetan. Pure arithmetic on
 * counts — no measurement — so `deriveBooklet` computes it identically on the bench, the
 * print page and the seed's virgin streams. Clamped INTERIOR (each half keeps ≥1 word of
 * each element); an element too short to cut sends the whole pair to the tail — the safe
 * side: an underfull head is a nuisance, an overfull one is a defect.
 */
export function defaultPairCut(
  k: number, totalTokens: number, phonWords: number, transWords: number,
): PairCut {
  if (phonWords < 2 || transWords < 2 || totalTokens <= 0) return { a: 0, b: 0 };
  const frac = k / totalTokens;
  const clamp = (v: number, max: number) => Math.max(1, Math.min(max - 1, Math.round(v)));
  return { a: clamp(frac * phonWords, phonWords), b: clamp(frac * transWords, transWords) };
}

/**
 * Split a line at token (syllable) index `k` (Tibetan, shared across editions — never cuts
 * a syllable) into head + tail. The recto follows per the edition's cut:
 *  - a PAIR (`{a, b}`): the head keeps `a` phonetics words and `b` translation words, the
 *    tail the rest — both halves stay interlinear pairs;
 *  - a single text (`{w}`): the translation of a homage line, or the phonetics of a mantra,
 *    cut at word `w`;
 *  - null: the whole recto text stays on the head (the legacy default, and split-edit mode).
 */
function splitDocLine(
  l: DocLine, k: number, cut: PairCut | { w: number } | null,
): [DocLine, DocLine] {
  let hPhon = l.phonetics, tPhon = '';
  let hTrans = l.translation, tTrans: string | null = null;
  if (cut && 'a' in cut && l.phonetics && l.translation != null) {
    [hPhon, tPhon] = splitWordsPlain(l.phonetics, cut.a);
    [hTrans, tTrans] = splitHtmlAtWord(l.translation, cut.b);
  } else {
    const w = cut == null ? Number.MAX_SAFE_INTEGER : ('w' in cut ? cut.w : cut.b);
    if (l.translation) [hTrans, tTrans] = splitHtmlAtWord(l.translation, w);
    else if (l.phonetics) [hPhon, tPhon] = splitWordsPlain(l.phonetics, w);
  }
  // Both halves remember the ORIGINAL line's anchor, so the split can be cleared from
  // either — and the tail keeps the original's `opId`: it is still that same occurrence.
  const anchor = anchorOf(l);
  const head: DocLine = {
    ...l, key: `${l.key}#h`, tokens: l.tokens.slice(0, k), endSylId: l.tokens[k - 1].id,
    phonetics: hPhon, translation: hTrans, emptyAfter: false, splitAnchor: anchor,
    // The merged-instruction trails sit at the END of the line, so they follow the tail.
    smallTrails: undefined,
  };
  const tail: DocLine = {
    ...l, key: `${l.key}#t`, tokens: l.tokens.slice(k), startSylId: l.tokens[k].id,
    phonetics: tPhon, translation: tTrans, emptyAfter: l.emptyAfter, splitAnchor: anchor,
  };
  return [head, tail];
}

/** Build a text's navigation from its TRANSLATION-PANE headings: a flat, stream-ordered
 *  list already labelled in the booklet's language (heading lines + translation-only title
 *  chunks). Nest by each heading's 0-based `level` (a monotone stack, like an outline).
 *  Each heading's page comes from its anchor syllable resolved into the line stream; an
 *  anchor that resolves to nothing inherits the nearest preceding resolved page, so every
 *  bookmark stays clickable. `base` seeds the page before the first resolved heading. */
function navFromHeadings(
  headings: OutlineHeading[],
  resolve: (sylId: string | null) => { pageIndex: number; folio: number } | null,
  base: { pageIndex: number; folio: number },
): NavNode[] {
  const roots: NavNode[] = [];
  const stack: { node: NavNode; level: number }[] = [];
  let last = base;
  for (const h of headings) {
    const hit = resolve(h.anchorSylId);
    if (hit) last = hit;
    const title = plainTextOf(h.label);
    if (!title) continue;
    const node: NavNode = { title, pageIndex: last.pageIndex, folio: last.folio, children: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ node, level: h.level });
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
  /** Per text item: its translation-pane headings — the source of the nav outline (bookmarks). */
  headingsByItem?: Map<number, OutlineHeading[]>,
): DerivedBooklet {
  // Apply mid-line splits first: a page_break row carrying a `char_offset` splits its line
  // at that syllable (token) index into head + tail, reusing the hairline-break machinery
  // between them. The recto follows per this edition's `recto_cut` row — `char_offset` = the
  // translation word cut, `value` = the phonetics word cut (pairs only). A pair with no row
  // renders the proportional default; a single text with no row keeps the legacy
  // whole-on-head. Everything downstream operates on the augmented `lines`.
  const splitAt = new Map<string, number>();
  const rectoCutAt = new Map<string, { b: number; a: number | null }>();
  for (const r of rows) {
    if (r.kind === 'page_break' && r.char_offset != null && r.char_offset > 0) {
      splitAt.set(`${r.item_id}:${r.anchor_syl_id}`, r.char_offset);
    } else if (r.kind === 'recto_cut' && r.char_offset != null && (r.lang ?? '') === (lang ?? '')) {
      rectoCutAt.set(`${r.item_id}:${r.anchor_syl_id}`, { b: r.char_offset, a: r.value ?? null });
    }
  }
  const lines: DocLine[] = [];
  const splitTails = new Set<number>();   // indices in `lines` that are split tails
  for (const l of srcLines) {
    // The line's anchor, falling back to the bare syllable for rows written before the op
    // was part of it (see `anchorOf`).
    const key = `${l.itemId}:${anchorOf(l)}`;
    const bare = `${l.itemId}:${l.startSylId}`;
    const k = splitAt.get(key) ?? splitAt.get(bare);
    if (k != null && k > 0 && k < l.tokens.length) {
      const rc = rectoCutAt.get(key) ?? rectoCutAt.get(bare) ?? null;
      const isPair = !!(l.phonetics && l.translation != null);
      let cut: PairCut | { w: number } | null;
      if (editRecto) {
        cut = null;                       // whole recto on the head, for word-picking
      } else if (isPair) {
        // A stored row missing either index falls back to the default's — the pair stays a
        // pair whatever half-written state the rows are in.
        const def = defaultPairCut(k, l.tokens.length,
                                   countWordsPlain(l.phonetics), countWordsHtml(l.translation!));
        cut = { a: rc?.a ?? def.a, b: rc?.b ?? def.b };
      } else {
        cut = rc ? { w: rc.b } : null;
      }
      const [head, tail] = splitDocLine(l, k, cut);
      lines.push(head);
      splitTails.add(lines.length);
      lines.push(tail);
    } else {
      lines.push(l);
    }
  }

  // One pass to index the stream — a row's anchor resolves by lookup, not by scanning every
  // line for every row (this runs on each `rows` change, and both are in the thousands).
  // Two maps, because there are two vintages of anchor. `idxOf` is keyed by the real one
  // (`anchorOf`, syllable + op) and is unique. `legacyIdx` is keyed by the bare syllable, for
  // rows written before the op was part of it; on a transcluded syllable that is genuinely
  // ambiguous, so it resolves to the first occurrence — which is exactly what those rows have
  // always done. They are not migrated: nothing records which occurrence was meant, and
  // guessing would move a page the user placed by hand.
  const idxOf = new Map<string, number>();
  const legacyIdx = new Map<string, number>();
  lines.forEach((l, i) => {
    const k = `${l.itemId}:${anchorOf(l)}`;
    if (!idxOf.has(k)) idxOf.set(k, i);
    const bare = `${l.itemId}:${l.startSylId}`;
    if (!legacyIdx.has(bare)) legacyIdx.set(bare, i);
  });
  const findIdx = (r: DocumentLayoutRow) => {
    const k = `${r.item_id}:${r.anchor_syl_id}`;
    return idxOf.get(k) ?? legacyIdx.get(k) ?? -1;
  };
  const breakSet = new Set<number>();
  const hairlineSet = new Set<number>();
  const manualBreaks = new Set<number>();
  for (const r of rows) {
    if (r.kind === 'page_break') {
      if (r.char_offset != null && r.char_offset > 0) continue;   // applied as a split
      const i = findIdx(r);
      if (i > 0) { breakSet.add(i); if (isManualBreak(r)) manualBreaks.add(i); }
    } else if (r.kind === 'hairline') { const i = findIdx(r); if (i > 0) hairlineSet.add(i); }
  }
  // A split forces a break + hairline between its head and tail.
  for (const i of splitTails) { breakSet.add(i); hairlineSet.add(i); }

  // Page starts nothing may negotiate: a text always begins a fresh spread (so its internal
  // title page sits cleanly before its first body page — no two texts share a spread), and a
  // split's tail begins the page it continues onto. The auto-flow fills the runs BETWEEN
  // these; it never invents or overrides one, which is why it has to be told about them.
  const forcedStarts = new Set<number>(splitTails);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].itemId !== lines[i - 1].itemId) forcedStarts.add(i);
  }

  const spreads: { start: number; end: number }[] = [];
  if (lines.length) {
    const forced = new Set<number>([...breakSet, ...forcedStarts]);
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
    return { title, page, level: 0, itemId: it.id };
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
  // Where each syllable landed, so a tree node's anchor finds its line (and so its page).
  const lineOfSyl = new Map<string, number>();
  lines.forEach((l, i) => {
    for (const t of l.tokens) {
      const k = `${l.itemId}:${t.id}`;
      if (!lineOfSyl.has(k)) lineOfSyl.set(k, i);
    }
  });
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
    const resolve = (syl: string | null) => {
      if (!syl) return null;
      const i = lineOfSyl.get(`${it.id}:${syl}`);
      if (i == null) return null;
      return { pageIndex: rectoPageOfLine(i), folio: folioOfLine(i) };
    };
    const children = navFromHeadings(headingsByItem?.get(it.id) ?? [], resolve, { pageIndex, folio });
    return { title: plainTextOf(titleSrc), pageIndex, folio, children };
  });

  return { lines, breakSet, hairlineSet, forcedStarts, manualBreaks,
           spreads, bodyUnits, frontMatter, backMatter, tocRows,
           mainTitleLines, folioOfLine, navOutline };
}

/** The per-language authored body of a furniture item (copyright text etc.). */
/**
 * The furniture slot the TIBETAN lives in.
 *
 * `document_furniture` is keyed by (item, lang), and every other body in it belongs to an
 * edition. The Tibetan belongs to none of them — it is the same string in all four booklets —
 * so it takes the one key that is not an edition. The document's own languages can never
 * collide with it: a language code is never empty.
 */
export const TIBETAN_LANG = '';

export function furnitureBodyOf(
  furniture: DocumentFurnitureRow[], item: DocumentItem, lang: string,
): string | null {
  return furniture.find((f) => f.item_id === item.id && f.lang === lang)?.body ?? null;
}
