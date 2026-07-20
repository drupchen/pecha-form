import React from 'react';
import {
  itemImageUrl, orgSealUrl, withUrlAuth,
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

/**
 * The factor between a page's ON-SCREEN pixels and its LAYOUT pixels.
 *
 * The overview scales the pages with a `transform`, so every `getBoundingClientRect()` inside
 * one is in SCALED pixels while the layout (and every mm we store) is not. Recovered from the
 * page's own rect against its exact layout height — right in both views and stable across the
 * toggle, which a captured `ovScale` is not.
 *
 * The denominator is `--page-h` as configured, NOT `clientHeight`: that one rounds to whole
 * pixels, and the flow packs pages to sub-pixel slack (see `extentOf` in PaginationBench).
 *
 * ANY pointer drag that moves ink must divide its travel by this. A slider did not have to —
 * its thumb rode a track that scaled with the page — which is exactly why dropping the slider
 * for a 1:1 handle newly exposes this on pages that never needed it.
 */
export function pageScaleOf(pageEl: HTMLElement, pageHeightMm?: number): number {
  const h = pageEl.getBoundingClientRect().height;
  if (pageHeightMm) return h / (pageHeightMm * MM_PX);
  return pageEl.clientHeight ? h / pageEl.clientHeight : 1;
}

/**
 * The element inside `.booklet-content` whose rect MOVES with `--page-shift`.
 *
 * The two page classes carry the shift differently, and every measurement that wants to be
 * shift-invariant has to ask the same question of both — so it is asked in exactly one place.
 *
 *  - a BODY page has the `.bk-shift` wrapper, which is what the var offsets.
 *  - a FURNITURE page cannot have one: its role element is `height:100%` inside a flex box
 *    that centres it, and a block in between makes that percentage indefinite and un-centres
 *    every special page. So the var offsets the ROLE ELEMENT itself, and that is the element
 *    whose rect moves.
 *
 * Falling back to `.booklet-content` for furniture — which is what the measurement used to do
 * before there was a furniture shift — reports the UNSHIFTED top, so the ink appears to grow
 * downward out of a fixed box: the page reads as overfull the moment you nudge it, with the
 * message "taller than the text block however it is placed", which is false.
 */
export function shiftHostOf(content: HTMLElement): HTMLElement {
  const wrapper = content.querySelector<HTMLElement>(':scope > .bk-shift');
  if (wrapper) return wrapper;
  if (content.parentElement?.classList.contains('furniture')) {
    const role = content.firstElementChild as HTMLElement | null;
    if (role) return role;
  }
  return content;
}

/**
 * How far one page's ink could travel before it leaves the SHEET, in mm, either way.
 *
 * Measured off the INK, not the container: a furniture page centres its block inside a
 * `height:100%` flex box, so the container's own head room is `--m-top` while the ink starts
 * far below it — clamping an upward drag to that would stop the block dead at ~15mm when it
 * could honestly travel most of the page.
 *
 * Measured ONCE, at the moment the handle is grabbed, and true for the whole gesture: a shift
 * moves ink without changing its extent, so the room is shift-invariant. That is also why
 * this does not belong in the bench's `roomByPage` effect — a drag needs it, a render does
 * not, and that effect runs on every render behind a field-by-field equality guard.
 */
export function groundRoom(pageEl: HTMLElement, pageHeightMm?: number): { up: number; down: number } {
  const content = pageEl.querySelector<HTMLElement>(':scope > .booklet-content');
  if (!content) return { up: 0, down: 0 };
  const kids = Array.from(shiftHostOf(content).children) as HTMLElement[];
  if (!kids.length) return { up: 0, down: 0 };
  let top = Infinity, bottom = -Infinity;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  const pr = pageEl.getBoundingClientRect();
  const s = pageScaleOf(pageEl, pageHeightMm);
  return {
    up: Math.max(0, (top - pr.top) / s / MM_PX),
    down: Math.max(0, (pr.bottom - bottom) / s / MM_PX),
  };
}

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
  /** The pointer left the gap-stepper cluster: the click burst is over, so a pending
   *  re-flow may settle at the short delay instead of waiting out the burst window. */
  onBurstEnd?: () => void;
  /** Persist a block's new width (null clears it). Absent = non-interactive (print). */
  onWidth?: (target: WidthTarget, mm: number | null) => void;
}
export const NO_ADJ: LineAdj = { gapDeltaMm: 0, noSpace: false };

const DEFAULT_RANGE: WidthRange = { min: -60, maxVerso: 10, maxRecto: 10 };
/** Below this (mm) a width is indistinguishable from natural — store nothing. */
const WIDTH_EPS = 0.3;

/**
 * One width-adjustable text block. The stored `valueMm` is a SIGNED delta on the block's
 * MEASURE — positive widens it toward the page's physical border (which
 * `.booklet-page { overflow: hidden }` clips), negative narrows it so the text wraps.
 *
 * WHERE the measure gives is what `centred` decides, and the two answers are not
 * interchangeable:
 *
 *  - LEFT-ALIGNED text (the body pages) takes it all off the right edge, leaving the left
 *    pinned to the measure. Pulling that edge out to the binding or outer border is the
 *    whole point there, and the two borders are different distances away.
 *  - CENTRED text (a title page, a copyright, a back cover) has to give from BOTH sides, or
 *    the block stops being centred. `align-items: center` centres a flex item by its MARGIN
 *    box, so a right-only inset slides the block half the inset to the left — the type drifts
 *    off the sheet's centre line as you narrow it, which is not what a width control means.
 *
 * `valueMm` is the TOTAL either way, so the same stored number means the same measure in both
 * modes and nothing had to be migrated when centred blocks stopped taking it all on one side.
 *
 * With `onCommit` it grows a hover-revealed grip on the right edge: dragging slides the
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
  /** Where this block SITS, when the page places its blocks one by one (see `BlockGround`).
   *  The mm ride `top` — this box is already `position: relative` for the width grip — so
   *  the offset is purely visual and the surrounding layout is untouched. Carried on the
   *  print page too, with no handle: it is ink, not chrome. */
  ground?: { valueMm: number; onCommit?: (mm: number) => void };
  /** How wide this line's SPACES set (see `BlockSpace`). Same shape as `ground`, and the same
   *  split: the mm are ink and print, the handle is chrome and does not. */
  space?: { valueMm: number; onCommit?: (mm: number) => void };
  pageHeightMm?: number;
  /** This block's text is CENTRED, so its measure closes in from both sides (see above).
   *  Also stretches the box to the measure: a shrink-to-fit item gives a width control
   *  nothing to bite on — the first millimetres would rewrap nothing and only shove the
   *  block sideways. Same reasoning as `.bk-fbody`'s `align-self: stretch`. */
  centred?: boolean;
}> = ({ valueMm, min, max, onCommit, className, style, children, ground, space, pageHeightMm,
        centred }) => {
  const [preview, setPreview] = React.useState<number | null>(null);
  // The drag's live value lives on the ref, NOT in `preview`. The state is for painting; if
  // the release were to read it, it would read whatever React had last committed — and when
  // the move and the release land in one batch (a very fast drag, coalesced input, a
  // synthetic one) that is still the value from before the drag, so the release looks like a
  // click and the whole drag is silently dropped.
  const drag = React.useRef<{ x: number; from: number; cur: number; s: number } | null>(null);
  const cur = preview ?? valueMm;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!onCommit) return;
    e.preventDefault();
    e.stopPropagation();
    // The page's on-screen scale, recovered at grab time: in the overview the pages are
    // scaled by a transform, so the pointer's travel is in scaled px while the mm we store
    // are not. Without this the edge ran ~1/ovScale too fast there.
    const page = (e.currentTarget as HTMLElement).closest<HTMLElement>('.booklet-page');
    drag.current = { x: e.clientX, from: valueMm, cur: valueMm, s: page ? pageScaleOf(page) : 1 };
    setPreview(valueMm);
    // Capture keeps the drag alive when the pointer outruns the 6px grip.
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Dragging right widens: the pointer's travel IS the edge's travel. On a centred block
    // each side carries half the delta, so the value has to move twice as far for the edge
    // under the pointer to keep up — the promise is about the EDGE, not the number.
    const travel = (e.clientX - d.x) / d.s / MM_PX * (centred ? 2 : 1);
    const next = Math.max(min, Math.min(max, d.from + travel));
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
         style={{ ...style, position: 'relative',
                  // Centred: half off each side, and stretched so the measure is the text
                  // block rather than whatever the longest word happens to need.
                  ...(centred
                    ? { marginInline: `${-cur / 2}mm`, alignSelf: 'stretch' }
                    : { marginRight: `${-cur}mm` }),
                  ...(ground?.valueMm ? { top: `${ground.valueMm}mm` } : {}),
                  ...(space?.valueMm ? { wordSpacing: `${space.valueMm}mm` } : {}) }}>
      {children}
      {ground?.onCommit && (
        <BlockGround valueMm={ground.valueMm} pageHeightMm={pageHeightMm}
                     onCommit={ground.onCommit} />
      )}
      {space?.onCommit && (
        <BlockSpace valueMm={space.valueMm} onCommit={space.onCommit} />
      )}
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
 * A furniture image with two live handles, so every image the booklet carries can be placed
 * and sized on the page itself instead of only in the Documents tab: a vertical `BlockGround`
 * rail (placement, hangs off the left edge, like a title block) and a horizontal grip on the
 * right edge that resizes the image — the drag sets its stored WIDTH in mm and clears the
 * height, so the aspect ratio is kept. The cover, copyright, back cover and image page all
 * render through this, so both handles are present in the detailed view and in every overview
 * column. `onResize` absent (the org seal) = placement only, no resize grip.
 */
export const BkImage: React.FC<{
  src: string;
  widthMm?: number | null;
  heightMm?: number | null;
  className?: string;
  ground?: { valueMm: number; onCommit?: (mm: number) => void };
  onResize?: (widthMm: number) => void;
  pageHeightMm?: number;
}> = ({ src, widthMm, heightMm, className, ground, onResize, pageHeightMm }) => {
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [previewW, setPreviewW] = React.useState<number | null>(null);
  const drag = React.useRef<{ x: number; from: number; cur: number; s: number } | null>(null);
  const w = previewW ?? widthMm;
  const sized = w != null || heightMm != null;
  const imgStyle: React.CSSProperties = {
    width: w != null ? `${w}mm` : undefined,
    // While dragging, height is auto so the aspect follows the width; at rest, the stored mm.
    height: previewW != null ? 'auto' : (heightMm != null ? `${heightMm}mm` : undefined),
  };

  const onDown = (e: React.PointerEvent) => {
    if (!onResize || !imgRef.current) return;
    e.preventDefault(); e.stopPropagation();
    const page = (e.currentTarget as HTMLElement).closest<HTMLElement>('.booklet-page');
    const s = page ? pageScaleOf(page) : 1;
    // Start from the stored width, or measure the natural render (unscaled px → mm).
    const fromMm = widthMm ?? imgRef.current.getBoundingClientRect().width / s / MM_PX;
    drag.current = { x: e.clientX, from: fromMm, cur: fromMm, s };
    setPreviewW(fromMm);
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(5, d.from + (e.clientX - d.x) / d.s / MM_PX);   // never below 5mm
    d.cur = next;
    setPreviewW(next);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const final = d.cur;
    setPreviewW(null);
    try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    if (Math.abs(final - d.from) < 0.2) return;   // a click, not a drag
    onResize?.(Number(final.toFixed(1)));
  };

  return (
    // `bk-widthline` so the hover-reveal CSS that shows the block ground + grip applies; the
    // slot wraps the image (fit-content) so both handles sit on the image's own edges, not the
    // full text block's.
    <div className={`bk-image-slot bk-widthline bk-imgslot${className ? ` ${className}` : ''}`}
         style={{ position: 'relative', ...(ground?.valueMm ? { top: `${ground.valueMm}mm` } : {}) }}>
      <img ref={imgRef} className={`bk-image${sized ? '' : ' bk-image-nat'}`} src={src} style={imgStyle} alt="" />
      {ground?.onCommit && (
        <BlockGround valueMm={ground.valueMm} pageHeightMm={pageHeightMm} onCommit={ground.onCommit} />
      )}
      {onResize && (
        <span className="bk-imggrip" title="Drag to resize the image — its height follows the width."
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      )}
    </div>
  );
};

/**
 * The page's GROUND: grab the rail beside the text block and slide the whole block up or down.
 *
 * Replaces the vertical `<input type="range">` this page used to carry. A slider asks you to
 * aim a 16px thumb at a 0.1mm step, and its track shrinks with the page in the overview —
 * which is precisely the mode built for comparing placements. A rail you can grab ANYWHERE
 * has no aiming cost at any scale, and it moves the block 1:1 with the pointer, which is what
 * the gesture actually is: not "set a parameter", but "put it here".
 *
 * The rail spans exactly the TEXT BLOCK — the same rectangle the geometry guide draws — so it
 * reads as the ground the block stands on rather than as a control with a range.
 *
 * The clamps are measured when you GRAB it (`groundRoom`), not held in render state: the room
 * is shift-invariant, so what was true at pointerdown stays true for the whole drag.
 *
 * Both page classes mount this — a body column and a furniture page differ only in which row
 * the value comes from, which is the caller's business, not the handle's.
 */
/**
 * What a ground rail is dragging, and how far it may go.
 *
 * The two rails differ ONLY in this: the page rail moves a whole page's block against the
 * sheet, the block rail moves one block against the same sheet. The gesture — pointer
 * capture, the ref-held live value, the overview's scale divided back out, the 0.1mm step,
 * click-not-drag, the keyboard road — is one implementation, because two copies of it would
 * drift and only one of them would get the next fix.
 */
interface GroundTarget {
  /** Which way the pointer moves the thing. Placement is vertical; the space width between
   *  words is horizontal, and dragging it up and down would say nothing about it. */
  axis?: 'x' | 'y';
  /** The element whose placement is being changed, from the rail's own node. */
  host: (rail: HTMLElement) => HTMLElement | null;
  /** How far it may travel each way from where it stands, in mm. `up` is the negative
   *  direction (up the page, or tighter), `down` the positive one. */
  room: (host: HTMLElement, pageHeightMm?: number) => { up: number; down: number };
  /** Paint the live value, bypassing React — a page of set Tibetan is far too heavy to
   *  re-render on every pointermove. Returns what to restore if nothing is committed. */
  apply: (host: HTMLElement, mm: number) => void;
  restore: (host: HTMLElement, was: string) => void;
  /** The inline value to put back when the gesture commits nothing. */
  read: (host: HTMLElement) => string;
}

const PAGE_TARGET: GroundTarget = {
  host: (rail) => rail.closest<HTMLElement>('.booklet-page'),
  room: (page, mm) => groundRoom(page, mm),
  apply: (page, mm) => page.style.setProperty('--page-shift', `${mm}mm`),
  restore: (page, was) => was ? page.style.setProperty('--page-shift', was)
                              : page.style.removeProperty('--page-shift'),
  read: (page) => page.style.getPropertyValue('--page-shift'),
};

/** One block on a special page. Its own box is the ink, so its room is measured off that
 *  box rather than off the page's children, and the offset rides `top` — the block is a
 *  `WidthLine`, which is already `position: relative`. */
const BLOCK_TARGET: GroundTarget = {
  host: (rail) => rail.parentElement,
  room: (block, mm) => elementRoom(block, mm),
  apply: (block, mm) => { block.style.top = `${mm}mm`; },
  restore: (block, was) => { block.style.top = was; },
  read: (block) => block.style.top,
};

/**
 * One block's WORD SPACING — how wide the spaces inside it set.
 *
 * A Tibetan title's gaps are U+0020 spaces after each shad; the tsheg between syllables is
 * U+0F0B, a different character entirely. `word-spacing` therefore reaches exactly the gaps
 * and cannot touch a tsheg — which is what makes it the honest instrument here, against the
 * Word habit of selecting each space and giving it a smaller font. The text is not edited at
 * all; the spacing is a property of how this line is set.
 */
const SPACE_TARGET: GroundTarget = {
  axis: 'x',
  host: (h) => h.parentElement,
  room: (block) => spaceRoom(block),
  apply: (block, mm) => { block.style.wordSpacing = `${mm}mm`; },
  restore: (block, was) => { block.style.wordSpacing = was; },
  read: (block) => block.style.wordSpacing,
};

/**
 * How much further a block's spaces may be tightened before they close, in mm.
 *
 * Measured off the SPACE ITSELF: a throwaway span in the block's own computed font, so the
 * floor is this face at this size rather than a guessed constant — Chogyal's space is an
 * order of magnitude wider than the tsheg beside it, and nothing like Gentium's.
 *
 * The probe INHERITS the spacing already applied, deliberately. Every `room` in this file
 * answers "how far from where it stands", and the clamp is `from - up`; a probe that reset to
 * the natural width would answer "how wide is a space" instead, and the two get added
 * together — a line already tightened by 4.6mm would then be allowed to go to -13.9mm and
 * pull the glyphs either side through each other. Inheriting makes `up` the room that is
 * actually left, so the floor lands exactly where the spaces close, wherever the drag starts.
 *
 * Loosening is left generously open: a title page may well want more air, not less.
 */
export function spaceRoom(block: HTMLElement): { up: number; down: number } {
  const probe = document.createElement('span');
  // `white-space: pre` so the single space cannot be collapsed away before it is measured.
  // Everything else — face, size, and the current word-spacing — is inherited.
  probe.style.cssText = 'white-space:pre;position:absolute;visibility:hidden';
  probe.textContent = ' ';
  block.appendChild(probe);
  const left = probe.getBoundingClientRect().width;
  probe.remove();
  const page = block.closest<HTMLElement>('.booklet-page');
  const s = page ? pageScaleOf(page) : 1;
  return { up: Math.max(0, left / s / MM_PX), down: 8 };
}

/** How far one ELEMENT can travel before it leaves the sheet, in mm either way. Unlike
 *  `groundRoom` the element itself is the ink — a block knows its own extent. */
export function elementRoom(el: HTMLElement, pageHeightMm?: number): { up: number; down: number } {
  const page = el.closest<HTMLElement>('.booklet-page');
  if (!page) return { up: 0, down: 0 };
  const r = el.getBoundingClientRect(), pr = page.getBoundingClientRect();
  const s = pageScaleOf(page, pageHeightMm);
  return {
    up: Math.max(0, (r.top - pr.top) / s / MM_PX),
    down: Math.max(0, (pr.bottom - r.bottom) / s / MM_PX),
  };
}

const Ground: React.FC<{
  valueMm: number;
  /** Which seam this value sits on, for the colour convention the sheet already uses:
   *  `shared` (lapis) = the Tibetan verso, one setting for every edition; `edition` (jade) =
   *  this booklet's own. */
  tone: 'shared' | 'edition';
  title: string;
  ariaLabel: string;
  pageHeightMm?: number;
  onCommit: (mm: number) => void;
  target: GroundTarget;
  /** Extra class on the rail — the block rail hangs off its block, the page rail off the
   *  page's margin, and only their placement differs. */
  variant?: string;
  /** The dashed datum rule. The page rail draws it across the text block; a block rail is
   *  small enough that its own travel reads plainly, so it does without. */
  datum?: boolean;
}> = ({ valueMm, tone, title, ariaLabel, pageHeightMm, onCommit, target, variant, datum }) => {
  const [preview, setPreview] = React.useState<number | null>(null);
  const [mark, setMark] = React.useState<number | null>(null);   // px from the page top: the datum
  // As in `WidthLine`: the live value rides the REF, not the state. A fast or coalesced drag
  // can land its move and its release in one batch, and a release that read the state would
  // read the pre-drag value and silently drop the whole gesture.
  const drag = React.useRef<
    { y: number; from: number; cur: number; s: number; up: number; down: number;
      host: HTMLElement; was: string } | null
  >(null);
  const cur = preview ?? valueMm;
  // The clamps the gesture is working against, in STATE — the render reads them (to grey the
  // rail at whichever end is biting), and a ref read during render is not safe to do: it is
  // invisible to React's scheduling and lies under a StrictMode double-render. The ref above
  // is written and read only inside event handlers, which is exactly where it is sound.
  const [bounds, setBounds] = React.useState<{ min: number; max: number } | null>(null);

  const begin = (el: HTMLElement, from: number, pointerId?: number) => {
    const host = target.host(el);
    const page = el.closest<HTMLElement>('.booklet-page');
    if (!host || !page) return;
    const room = target.room(host, pageHeightMm);
    setBounds({ min: valueMm - room.up, max: valueMm + room.down });
    const s = pageScaleOf(page, pageHeightMm);
    // The datum: where the ink's top sits right now, in page-local px, so the dashed rule
    // stays put while the block moves out from under it.
    if (datum) {
      const content = page.querySelector<HTMLElement>(':scope > .booklet-content');
      const kids = content ? (Array.from(shiftHostOf(content).children) as HTMLElement[]) : [];
      if (kids.length) {
        const pr = page.getBoundingClientRect();
        setMark((Math.min(...kids.map((k) => k.getBoundingClientRect().top)) - pr.top) / s);
      }
    }
    drag.current = {
      y: from, from: valueMm, cur: valueMm, s, up: room.up, down: room.down,
      host, was: target.read(host),
    };
    setPreview(valueMm);
    if (pointerId != null) {
      try { el.setPointerCapture(pointerId); } catch { /* not fatal */ }
    }
  };

  // The pointer coordinate this handle reads. Placement is dragged up and down; a space's
  // width is dragged left and right, because that is the direction it grows in.
  const at = (e: { clientX: number; clientY: number }) => target.axis === 'x' ? e.clientX : e.clientY;
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    begin(e.currentTarget as HTMLElement, at(e), e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // 1:1 — the pointer's travel IS the block's travel, once the overview's scale is divided
    // back out. Free at the stored step; nothing snaps.
    const raw = d.from + (at(e) - d.y) / d.s / MM_PX;
    const next = Math.max(d.from - d.up, Math.min(d.from + d.down, raw));
    d.cur = Math.round(next * 10) / 10;
    // Move the INK, not just the readout — written straight onto the element, see
    // `GroundTarget`. On release React repaints from the stored row and the two agree again.
    target.apply(d.host, d.cur);
    setPreview(d.cur);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const final = d.cur;
    setPreview(null);
    setMark(null);
    setBounds(null);
    try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    // Hand the value back to React. On a commit its re-render sets the same one, so nothing
    // moves; on a click — or a drag the caller declines to store — this is what puts the
    // block back where it was, since no re-render is coming to do it.
    target.restore(d.host, d.was);
    // A click, not a drag — and leaving it uncommitted is what lets `onDoubleClick` through.
    if (Math.abs(final - d.from) < 0.05) return;
    onCommit(final);
  };

  /** The keyboard road, which the native range used to give for free. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'PageUp' || e.key === 'PageDown' ? 5 : e.shiftKey ? 1 : 0.1;
    let next: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') next = cur + step;
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') next = cur - step;
    else if (e.key === 'Home') next = 0;
    if (next == null) return;
    e.preventDefault();
    const host = target.host(e.currentTarget as HTMLElement);
    const room = host ? target.room(host, pageHeightMm) : { up: 0, down: 0 };
    onCommit(Math.round(Math.max(cur - room.up, Math.min(cur + room.down, next)) * 10) / 10);
  };

  const shifted = Math.abs(cur) > 0.05;
  // `preview` is non-null for exactly the life of a gesture, so it is the render-safe answer
  // to "is this being dragged" — no ref read, no extra state to keep in step.
  const dragging = preview != null;
  // Which end is being pushed against, so the rail can say "this page is full" by resisting
  // rather than by vanishing. A control that disappears and comes back as you tune the page
  // next door is worse than one that holds still and greys.
  const atEnd = dragging && bounds
    ? (cur <= bounds.min + 0.05 ? 'up' : cur >= bounds.max - 0.05 ? 'down' : null)
    : null;

  return (
    <>
      {mark != null && (
        <div className="bk-groundmark" style={{ top: `${mark}px` }}>
          <span>{cur > 0 ? `↓${cur.toFixed(1)}` : cur < 0 ? `↑${(-cur).toFixed(1)}` : '0.0'}mm</span>
        </div>
      )}
      <div className={`bk-ground bk-ground-${tone}${variant ? ` ${variant}` : ''}`}
           data-shifted={shifted ? '' : undefined}
           data-dragging={dragging ? '' : undefined}
           data-atend={atEnd ?? undefined}
           role="slider" tabIndex={0}
           aria-orientation="vertical"
           aria-label={ariaLabel}
           aria-valuenow={Number(cur.toFixed(1))}
           aria-valuetext={`${cur.toFixed(1)} mm`}
           title={title}
           onPointerDown={onPointerDown}
           onPointerMove={onPointerMove}
           onPointerUp={endDrag}
           onPointerCancel={endDrag}
           onKeyDown={onKeyDown}
           onDoubleClick={() => onCommit(0)}>
        <span className="bk-ground-hint">↕</span>
        {shifted && !dragging && (
          <span className="bk-ground-chip">
            {cur > 0 ? `↓${cur.toFixed(1)}` : `↑${(-cur).toFixed(1)}`}
          </span>
        )}
      </div>
    </>
  );
};

/** The whole page's ground: a rail in the margin spanning the text block. BODY pages, where
 *  the page is the unit that moves. */
export const PageGround: React.FC<{
  valueMm: number; tone: 'shared' | 'edition'; title: string; ariaLabel: string;
  pageHeightMm?: number; onCommit: (mm: number) => void;
}> = (p) => <Ground {...p} target={PAGE_TARGET} datum />;

/**
 * ONE block's ground, on a special page.
 *
 * A title page is not one block that moves together — it is a seal, a Tibetan title, a main
 * title, a sub-title, an origin and an author, each with its own size and its own air around
 * it. So the handle is per block, and it hangs off the block's left edge: the vertical twin
 * of the width grip on its right, which is why it lives inside `WidthLine` rather than out on
 * the page. Grab the bar next to the thing you are placing.
 */
export const BlockGround: React.FC<{
  valueMm: number; pageHeightMm?: number; onCommit: (mm: number) => void;
}> = ({ valueMm, pageHeightMm, onCommit }) => (
  <Ground valueMm={valueMm} tone="edition" pageHeightMm={pageHeightMm} onCommit={onCommit}
          target={BLOCK_TARGET} variant="bk-ground-block"
          title={'Drag to move this block up or down on the page. Double-click to put it '
            + 'back where the page would place it.'}
          ariaLabel="Move this block up or down" />
);

/**
 * ONE line's SPACES, tightened or opened.
 *
 * A Tibetan title breaks at its shad, and the space after it is set by the face — Chogyal's
 * is far wider than a title page usually wants. This is the honest way to say so: the type is
 * SET more tightly, and the text is not touched. (The habit it replaces is selecting each
 * space in a word processor and giving it a smaller font, which hides a typographic decision
 * inside the string and does not survive the text being reused.)
 *
 * Only U+0020 moves. The tsheg between syllables is U+0F0B, so `word-spacing` cannot reach it
 * however far this is dragged — the syllables keep their own rhythm.
 */
export const BlockSpace: React.FC<{
  valueMm: number; onCommit: (mm: number) => void;
}> = ({ valueMm, onCommit }) => (
  <Ground valueMm={valueMm} tone="shared" onCommit={onCommit}
          target={SPACE_TARGET} variant="bk-space"
          title={'Drag left to close this line’s spaces, right to open them. Only the spaces '
            + 'move — the tsheg between syllables is a different character and keeps its own '
            + 'width. Double-click for the face’s own spacing. Every edition prints the same '
            + 'Tibetan, so this is set once.'}
          ariaLabel="Space width in this line" />
);

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
 * The same address, asking where the block SITS rather than how wide it is.
 *
 * The vertical twin of `BlockWidthOf`, keyed identically — a block's placement and its
 * measure are two adjustments to one thing, so they share an address and differ only in
 * axis. `onCommit` absent means "carry this value, offer no handle": exactly what the print
 * page wants, and what makes the offset ink rather than chrome.
 */
export type BlockGroundOf = (key: string) => { valueMm: number; onCommit?: (mm: number) => void };

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
  l.startSylId
    ? (l.opId != null ? `${l.startSylId}#${l.opId}` : l.startSylId)
    // Syllable-less lines — translation-only titles (`startSylId: ''`, `tokens: []`) — anchor by
    // their unique, stable `key` (`${item}:title-${layoutId}`). Without this every title in an item
    // collapses to the same empty `${item}:` anchor, so a break placed on one resolves to the first
    // title (or nowhere) and the flow's uniqueness backstop marks the rest unbreakable — the reason
    // the scissors before a title looked live but did nothing.
    : l.key;

/** The anchor a line's SPLIT rows hang off — the original line's, so head and tail agree. */
export const splitAnchorOf = (l: DocLine): string => l.splitAnchor ?? anchorOf(l);

/** The small family's variant as a class (` bk-smallkind-verses` …), so a style rule can
 *  target ONE variant — the studio's "small – verses" card styles verses lines apart from
 *  the family card. Only `small` carries a kind; every other role contributes nothing. */
const smallKindCls = (l: DocLine): string =>
  l.role === 'small' && l.smallKind ? ` bk-smallkind-${l.smallKind}` : '';

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
      <div className="bk-gap-removed" onPointerLeave={adj.onBurstEnd}>
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
        <span className="bk-gapctl-group" onPointerLeave={adj.onBurstEnd}>
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
  // A line whose Tibetan flows straight into a following MERGED instruction (whose tokens
  // were moved here, leaving it token-empty) keeps no blank line before that instruction on
  // the VERSO — the two Tibetans are one continuous line. The recto still shows the blank
  // (the instruction is its own translation line). A text-first instruction keeps its tokens
  // and so does not suppress the previous line's gap.
  const next = lines[i + 1];
  if (next && next.role === 'small' && next.smallKind === 'instructions'
      && next.tokens.length === 0) return true;
  // sapche (ས་བཅད) and title are the same thing in two languages — a section heading. Both
  // combine on the verso, so a translation-only title standing between two topics keeps the
  // chain intact instead of severing it with a blank line.
  const isHeading = (r?: string) => r === 'sapche' || r === 'title';
  if (!isHeading(lines[i]?.role)) return false;
  return isHeading(next?.role) || next?.role === 'verse' || next?.role === 'prose';
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
    <div className={`bk-line bk-role-${l.role}${smallKindCls(l)}${onSplit ? ' bk-splitmode' : ''}`
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
  const lineCls = `bk-line bk-pair bk-role-${l.role}${smallKindCls(l)}`
                + (atPageTop ? ' bk-atpagetop' : '');

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
  // A merged instruction (continuation rule, TIBETAN-side only) keeps its own recto line:
  // its Tibetan was moved to the host line (this line's `tokens` are empty), so the verso
  // renders nothing here, while the translation below renders as an ordinary standalone
  // small line — never appended to the host's translation.
  return (
    <div className={lineCls}>
      {isSection ? (
        l.translation != null ? (
          <WidthLine className={`bk-section bk-section-l${LEVEL_SECTION_STYLE(l.level)}`}
                     {...widthProps(adj, 'section', false)}>
            <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
          </WidthLine>
        ) : l.missingTitle ? (
          // A translation-only title not yet translated in this edition: a muted placeholder
          // marks the slot so the missing heading is visible on the page (never another
          // language's text). It clears itself the moment the title is translated.
          <WidthLine className={`bk-section bk-section-missing bk-section-l${LEVEL_SECTION_STYLE(l.level)}`}
                     {...widthProps(adj, 'section', false)}>
            <span>[ untranslated title ]</span>
          </WidthLine>
        ) : null
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
  /** Where each block sits (bench only; the print page passes values with no handlers). */
  groundOf?: BlockGroundOf;
  /** How wide each Tibetan title line's spaces set (see `BlockSpace`). */
  spaceOf?: BlockGroundOf;
  pageHeightMm?: number;
  /**
   * This booklet's own Tibetan for the title, if it has been given one — one line per line,
   * newline-separated. Empty or absent falls back to the text's, which is where the string
   * comes from in the first place: the field is seeded from it, so an override starts life as
   * a copy and diverges only where the editor says so. Clearing it returns to following the
   * text.
   */
  tibetan?: string | null;
  /**
   * This page's authored slot overrides, by block name (`TITLE_BLOCKS`). Each is seeded in
   * the editor from the paragraph of the text's title translation it replaces, and stored
   * only once it differs — so an absent entry means "follow the text", exactly as the
   * Tibetan above does.
   */
  slots?: Partial<Record<TitleBlock, string | null>>;
}> = ({ titleLines, seal, image, widthOf = NO_WIDTH, groundOf, spaceOf, pageHeightMm,
        tibetan, slots }) => {
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
      {/* The cover image / org seal is a `BkImage`, self-contained: it carries its own placement
          rail (and, for the booklet's own image, a resize grip). The ༀ fallback glyph has no
          size of its own, so it keeps the plain `WidthLine` placement rail. */}
      {image}
      {seal && !image && (
        <WidthLine valueMm={0} min={0} max={0} className="bk-seal"
                   ground={groundOf?.('#image')} pageHeightMm={pageHeightMm}>ༀ</WidthLine>
      )}
      {ownLines.length
        ? ownLines.map((line, i) => (
          <WidthLine key={`o${i}`} className="bk-tibetan bk-title-tib"
                     {...widthOf(`#title_tib${i}`)} centred
                     ground={groundOf?.(`#title_tib${i}`)} space={spaceOf?.(`#title_tib${i}`)}
                     pageHeightMm={pageHeightMm}>
            {line}
          </WidthLine>
        ))
        : titleLines.map((t, i) => (
          // A real line out of the text: anchored on its own syllable, like any body line,
          // and so shared by every edition.
          <WidthLine key={i} className="bk-tibetan bk-title-tib" {...widthOf(anchorOf(t))} centred
                     ground={groundOf?.(anchorOf(t))} space={spaceOf?.(anchorOf(t))}
                     pageHeightMm={pageHeightMm}>
            {/* No `bk-tibetan-small` here, deliberately. The role speaks in absolute points,
                so the class would pin a title's small run to 12pt inside 24pt type, where it
                wants roughly 18. The vocabulary cannot say "proportionally smaller", so the
                title abstains rather than be confidently wrong. */}
            {t.tokens.map((tk, k) => <span key={k}>{tk.render}</span>)}
          </WidthLine>
        ))}
      {/* The four named slots, each the override or the paragraph it was seeded from.
          The width KEY is deliberately the one this block already had — paragraph n has
          always been `#title_sub{n-1}` — because naming the slots must not move anyone's
          stored adjustments onto a different block. The names are new; the addresses are
          not. */}
      {TITLE_BLOCKS.map((block) => {
        const meta = TITLE_BLOCK_META[block];
        const own = slots?.[block];
        const html = own && own.trim() ? own : trans[meta.seed];
        if (!html) return null;
        return (
          <WidthLine key={block} className={meta.cls} {...widthOf(titleBlockKey(block))} centred
                     ground={groundOf?.(titleBlockKey(block))} pageHeightMm={pageHeightMm}>
            <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(html) }} />
          </WidthLine>
        );
      })}
      {/* Anything the text's title carries beyond the four slots. Keeping them as sub-titles
          is what makes naming the slots a no-op for an existing booklet: a fifth paragraph
          renders where it always did, under the key it always had, rather than vanishing. */}
      {trans.slice(TITLE_BLOCKS.length).map((p, i) => (
        <WidthLine key={`sub${i + TITLE_BLOCKS.length - 1}`} className="bk-title-sub"
                   {...widthOf(`#title_sub${i + TITLE_BLOCKS.length - 1}`)} centred
                   ground={groundOf?.(`#title_sub${i + TITLE_BLOCKS.length - 1}`)}
                   pageHeightMm={pageHeightMm}>
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
/** Resolve the booklet's template variables in a body of text. Today just `{{version}}` →
 *  the declared version (empty until one is bumped); the raw token stays in the editor and only
 *  resolves on the page, so the copyright "version {{version}}" follows the versioning system. */
export function applyDocVars(text: string, version?: string): string {
  return text.replaceAll('{{version}}', version ?? '');
}

const FurnitureLines: React.FC<{
  body: string; block: string; widthOf: BlockWidthOf; className?: string;
  groundOf?: BlockGroundOf; pageHeightMm?: number; version?: string;
}> = ({ body, block, widthOf, className, groundOf, pageHeightMm, version }) => {
  const paras = splitParagraphs(body);
  if (!paras.length) return null;
  return (
    <div className="bk-fbody">
      {paras.map((para, i) => (
        <WidthLine key={i} className={className} {...widthOf(`#${block}${i}`)} centred
                   ground={groundOf?.(`#${block}${i}`)} pageHeightMm={pageHeightMm}>
          <p dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(applyDocVars(para, version)) }} />
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
  /** This page's authored title slots (see `TitleContent`). */
  slots?: Partial<Record<TitleBlock, string | null>>;
  /** Where each block sits (see `BlockGround`). */
  groundOf?: BlockGroundOf;
  /** How wide the Tibetan title lines' spaces set (see `BlockSpace`). */
  spaceOf?: BlockGroundOf;
  /** Commit a new width (mm) for THIS item's image (bench only) — the resize grip's target. */
  onResizeImage?: (widthMm: number) => void;
  /** The declared version, for `{{version}}` in a furniture body (see `applyDocVars`). */
  version?: string;
  pageHeightMm?: number;
}> = ({ item, titleLines, body, toc, orgSeal, widthOf = NO_WIDTH, tibetan, slots,
        groundOf, spaceOf, onResizeImage, version, pageHeightMm }) => {
  // The booklet's own image, with its placement rail and resize grip (see `BkImage`).
  const bkImage = (
    <BkImage src={withUrlAuth(itemImageUrl(item.id))}
             widthMm={item.image_width_mm} heightMm={item.image_height_mm}
             ground={groundOf?.('#image')} onResize={onResizeImage} pageHeightMm={pageHeightMm} />
  );

  if (item.kind === 'cover') {
    // At the ༀ ornament's place: this booklet's own cover image if it has one, else the org's
    // seal from the template, else (neither) the ༀ glyph — see TitleContent. The org seal is
    // sized in the Style Studio (org-level), so it takes a placement rail but no resize grip.
    const sealImage = orgSeal?.has_image
      ? <BkImage src={withUrlAuth(orgSealUrl())} widthMm={orgSeal.width_mm} heightMm={orgSeal.height_mm}
                 ground={groundOf?.('#image')} pageHeightMm={pageHeightMm} />
      : undefined;
    return <TitleContent titleLines={titleLines} seal widthOf={widthOf} tibetan={tibetan}
                        slots={slots} groundOf={groundOf} spaceOf={spaceOf}
                        pageHeightMm={pageHeightMm}
                        image={item.has_image ? bkImage : sealImage} />;
  }
  if (item.kind === 'toc') {
    return (
      <div className="bk-toc">
        {toc.length === 0 && <div className="bk-placeholder">No sections yet.</div>}
        {toc.map((e, i) => (
          <WidthLine key={i} className={`bk-toc-entry${e.isTextHeader ? ' bk-toc-head' : ''}`}
                     style={{ paddingLeft: `${e.level * 5}mm` }}
                     {...widthOf(`#toc:${e.itemId ?? i}`)}
                     ground={groundOf?.(`#toc:${e.itemId ?? i}`)} pageHeightMm={pageHeightMm}>
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
            <FurnitureLines groundOf={groundOf} pageHeightMm={pageHeightMm} body={body} block="caption" widthOf={widthOf}
                            className="bk-image-caption" version={version} />
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
        {body && <FurnitureLines groundOf={groundOf} pageHeightMm={pageHeightMm} body={body} block="backcover" widthOf={widthOf}
                                 className="bk-copyright" version={version} />}
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
  /** This page's authored title slots (see `TitleContent`). */
  slots?: Partial<Record<TitleBlock, string | null>>;
  /** Where each block sits. A special page has no single block to move — it is a seal, a
   *  title, a sub-title and so on, each placed on its own — so the handle is per block and
   *  lives on the block (see `BlockGround`), not out on the page. */
  groundOf?: BlockGroundOf;
  spaceOf?: BlockGroundOf;
  onResizeImage?: (widthMm: number) => void;
  version?: string;
  pageHeightMm?: number;
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
  slots?: Partial<Record<TitleBlock, string | null>>;
  groundOf?: BlockGroundOf;
  spaceOf?: BlockGroundOf;
  pageHeightMm?: number;
}> = ({ titleLines, widthOf, tibetan, slots, groundOf, spaceOf, pageHeightMm }) => (
  <div className="booklet-spread">
    <div className="booklet-page furniture">
      <div className="booklet-content">
        <TitleContent titleLines={titleLines} widthOf={widthOf} tibetan={tibetan}
                      slots={slots} groundOf={groundOf} spaceOf={spaceOf}
                      pageHeightMm={pageHeightMm} />
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

/**
 * The same signed mm, for ONE BLOCK of a special page.
 *
 * The vertical twin of `width_furniture`, and keyed identically: the block's address, per
 * edition, except the booklet's own Tibetan which is shared like the text's. A special page
 * is not one block that moves together — a title page is a seal, a Tibetan title, a main
 * title, a sub-title, an origin and an author, each with its own size and its own air — so
 * the unit that moves is the block, not the page.
 *
 * (It began as a page-level `page_shift_furniture` anchored '#page'. That kind never
 * shipped and no stored row used it, so it was renamed rather than migrated.)
 */
export const FURNITURE_SHIFT_KIND = 'shift_furniture';

/** The lang seam, identical to `width_furniture`'s: '#title_tib*' is the booklet's own
 *  Tibetan, the same string in every edition, so its placement is set once. */
export const furnitureShiftLang = (key: string, lang: string): string =>
  key.startsWith('#title_tib') ? '' : lang;

export const furnitureShiftMm = (
  rows: DocumentLayoutRow[], itemId: number, key: string, lang: string,
): number => {
  const rowLang = key.startsWith('#') ? furnitureShiftLang(key, lang) : '';
  return rows.find((r) => r.kind === FURNITURE_SHIFT_KIND && r.item_id === itemId
                       && r.anchor_syl_id === key
                       && (r.lang ?? '') === rowLang)?.value ?? 0;
};

/**
 * How wide a Tibetan title line's spaces set. Signed mm on `word-spacing`.
 *
 * SHARED across editions in every case — the Tibetan title is one string printed in all four
 * booklets, so its setting is decided once. That is true of both anchor vintages: the
 * booklet's own lines (`#title_tib{i}`) and a title lifted from the text (a syllable id),
 * which is why this reads `lang = ''` unconditionally rather than mirroring
 * `furnitureShiftLang`'s per-edition seam.
 */
export const FURNITURE_SPACE_KIND = 'space_furniture';

export const furnitureSpaceMm = (
  rows: DocumentLayoutRow[], itemId: number, key: string,
): number => rows.find((r) => r.kind === FURNITURE_SPACE_KIND && r.item_id === itemId
                           && r.anchor_syl_id === key && (r.lang ?? '') === '')?.value ?? 0;

/** Read back with NO handlers — what the print page carries. */
export const furnitureSpaceOf = (
  rows: DocumentLayoutRow[], itemId: number,
): BlockGroundOf => (key) => ({ valueMm: furnitureSpaceMm(rows, itemId, key) });

/** A special page's block placements, read back with NO handlers — what the print page
 *  carries. The bench passes the same shape plus `onCommit`, so the two cannot drift. */
export const furnitureGroundOf = (
  rows: DocumentLayoutRow[], itemId: number, lang: string,
): BlockGroundOf => (key) => ({ valueMm: furnitureShiftMm(rows, itemId, key, lang) });
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
    // Syllable-less title lines have no bare-syllable vintage: an old row with an empty
    // anchor (written before titles anchored by `key`) must resolve NOWHERE, not to the
    // first title in the item — matched there it pins a page nobody can un-pin, because
    // the lift deletes by the line's CURRENT anchor and never finds the '' row.
    if (l.startSylId) {
      const bare = `${l.itemId}:${l.startSylId}`;
      if (!legacyIdx.has(bare)) legacyIdx.set(bare, i);
    }
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
  furniture: DocumentFurnitureRow[], item: DocumentItem, lang: string, block = '',
): string | null {
  // `block ?? ''` tolerates a row that predates the column (an older API, a cached
  // response): it meant the free-form body, which is exactly what '' means now.
  return furniture.find((f) => f.item_id === item.id && f.lang === lang
                            && (f.block ?? '') === block)?.body ?? null;
}

/** This page's authored title slots for one edition, ready for `TitleContent`. A slot with
 *  no row is simply absent, which is what "follows the text" means. */
export function furnitureSlotsOf(
  furniture: DocumentFurnitureRow[], item: DocumentItem, lang: string,
): Partial<Record<TitleBlock, string | null>> {
  const out: Partial<Record<TitleBlock, string | null>> = {};
  for (const block of TITLE_BLOCKS) out[block] = furnitureBodyOf(furniture, item, lang, block);
  return out;
}

/** The title page's authored slots, in the order they print. The Tibetan is not here: it is
 *  shared across editions and lives at `lang ''` under the free-form block, as it always
 *  has. */
export const TITLE_BLOCKS = ['title_main', 'title_sub', 'title_origin', 'title_author'] as const;
export type TitleBlock = (typeof TITLE_BLOCKS)[number];

/** What each slot is called, and which paragraph of the text's title translation seeds it
 *  when the user has not overridden it. The seed index IS the historical layout: paragraph 0
 *  was the main title and the rest were repeated sub-titles, so an untouched booklet renders
 *  exactly as it did before these slots existed. */
export const TITLE_BLOCK_META: Record<TitleBlock, { label: string; seed: number; cls: string }> = {
  title_main:   { label: 'Main title', seed: 0, cls: 'bk-title-main' },
  title_sub:    { label: 'Sub-title',  seed: 1, cls: 'bk-title-sub' },
  title_origin: { label: 'Origin',     seed: 2, cls: 'bk-title-origin' },
  title_author: { label: 'Author',     seed: 3, cls: 'bk-title-author' },
};

/**
 * The per-block adjustment key for a title slot — the address its width (and, later, its
 * placement) is stored under.
 *
 * It is derived from the SEED index, not the block name, because these blocks are not new:
 * paragraph 0 was `#title_main` and paragraph n was `#title_sub{n-1}` long before the slots
 * had names. Keying by name would silently re-point every stored adjustment at a different
 * block — the origin line inheriting what was set for the sub-title, and so on.
 */
export const titleBlockKey = (block: TitleBlock): string => {
  const seed = TITLE_BLOCK_META[block].seed;
  return seed === 0 ? '#title_main' : `#title_sub${seed - 1}`;
};
