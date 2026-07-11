/**
 * Reusable Tibetan text-width estimation.
 *
 * Why: counting codepoints is wrong for Tibetan. A single column-and-tsek of
 * text spans 3–7 codepoints (base consonant + subjoined letters + vowel
 * signs + tsek). Doing `text.substring(0, 80)` cuts long before the visual
 * edge of any reasonable container.
 *
 * How: a per-codepoint width table extracted from the font file (TrueType
 * `hmtx` advance widths) is shipped as a static JSON alongside this file.
 * Subjoined consonants and vowel marks have zero advance and are listed
 * under `combiningRanges`. Spacing characters' widths are normalized so
 * width(བ U+0F56) == 1.0 ("ba-units"). The JSON also records the font's
 * Latin 'a' width in ba-units, so a contextually-measured 'a' pixel width
 * is enough to convert any text width to pixels — no assumption that
 * width(a) ≈ width(བ).
 *
 * Default font data: Jomolhari (Google Fonts), extracted by
 * `scripts/extract_tibetan_widths.py`. To support another font, run that
 * script against the font file and call `loadFontWidthData(...)` with the
 * resulting JSON.
 *
 * Reuse across projects: this file + the JSON are self-contained — no
 * imports from anywhere else in the codebase.
 */

import jomolhariData from './tibetan-widths.jomolhari.json';

export interface FontWidthData {
  font: string;
  version: number;
  source?: string;
  unitsPerEm?: number;
  calibration: {
    anchorCodepoint: string; // hex, e.g. "0F56"
    anchorChar: string;
    anchorAdvance?: number;
    unit: string;
    latinAInBaUnits: number | null;
    latinAInBaUnitsNote?: string;
  };
  /** Inclusive ranges of zero-advance (combining) codepoints, as hex pairs. */
  combiningRanges: Array<[string, string]>;
  /** Per-codepoint width in ba-units (1.0 == width of the anchor char). */
  widths: Record<string, number>;
}

const TIBETAN_START = 0x0F00;
const TIBETAN_END = 0x0FFF;
const TSEK = 0x0F0B;

interface CompiledData {
  font: string;
  combining: Set<number>;
  widths: Map<number, number>;
  /** Width of Latin 'a' in ba-units. Defaults to 1.0 if not provided. */
  latinAInBaUnits: number;
}

function compile(data: FontWidthData): CompiledData {
  const combining = new Set<number>();
  for (const [a, b] of data.combiningRanges) {
    const lo = parseInt(a, 16);
    const hi = parseInt(b, 16);
    for (let cp = lo; cp <= hi; cp++) combining.add(cp);
  }
  const widths = new Map<number, number>();
  for (const [hex, w] of Object.entries(data.widths)) {
    widths.set(parseInt(hex, 16), w);
  }
  return {
    font: data.font,
    combining,
    widths,
    latinAInBaUnits: data.calibration.latinAInBaUnits ?? 1.0,
  };
}

let active: CompiledData = compile(jomolhariData as unknown as FontWidthData);

/**
 * Swap in width data for a different font. Generate the JSON via
 * `scripts/extract_tibetan_widths.py --font /path/to/Foo.ttf --name Foo
 * --out src/lib/tibetan-widths.foo.json`, import it, and call this.
 */
export function loadFontWidthData(data: FontWidthData): void {
  active = compile(data);
}

/** Returns the name of the font currently providing width data. */
export function activeFontName(): string {
  return active.font;
}

/**
 * Optional one-time setup: awaits the configured Tibetan font's load so
 * that subsequent `measureLatinAWidthPx` calls on elements styled with
 * that font return accurate values. Safe to skip — all width estimation
 * is driven by the static table.
 */
export function initTibetanWidth(fontFamily: string = 'Jomolhari'): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return Promise.resolve();
  }
  return (async () => {
    try {
      await (document as any).fonts.load(`16px "${fontFamily}"`);
      await (document as any).fonts.ready;
    } catch {
      /* non-fatal — measurements proceed with whatever the canvas resolves */
    }
  })();
}

function widthInBaUnits(cp: number): number {
  if (cp >= TIBETAN_START && cp <= TIBETAN_END) {
    if (active.combining.has(cp)) return 0;
    const w = active.widths.get(cp);
    if (w != null) return w;
    // Tibetan codepoint not in the font's cmap (unassigned or unsupported):
    // treat as a standard consonant. Better to slightly over-budget than to
    // under-truncate.
    return 1.0;
  }
  // Non-Tibetan: assume one glyph ≈ width of one Latin 'a' in the same font.
  // 'a' is recorded as `latinAInBaUnits` ba-units, so contribute that.
  return active.latinAInBaUnits;
}

/**
 * Estimate the rendered width of `text` in ba-units (1 unit = width of བ
 * in the active font).
 */
export function estimateTibetanWidthInBaUnits(text: string): number {
  let total = 0;
  for (const ch of text) total += widthInBaUnits(ch.codePointAt(0)!);
  return total;
}

/**
 * Measure the rendered width of a Latin 'a' in `el`'s computed font using
 * an offscreen canvas. Used as the per-Latin-glyph pixel size for px
 * conversion.
 */
export function measureLatinAWidthPx(el: HTMLElement): number {
  const cs = window.getComputedStyle(el);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSizeFallback = parseFloat(cs.fontSize) || 16;
  if (!ctx) return fontSizeFallback * 0.5;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return ctx.measureText('a').width || fontSizeFallback * 0.5;
}

/**
 * Estimate the rendered width of `text` in px, using `contextEl`'s
 * computed font as the rendering context. The calculation:
 *
 *     pxPerBaUnit = aWidthPx / latinAInBaUnits
 *     widthPx     = estimateTibetanWidthInBaUnits(text) * pxPerBaUnit
 *
 * This works even when `width('a') ≠ width(བ)` in the rendering font, as
 * long as the JSON's `latinAInBaUnits` was extracted from the same font.
 */
export function estimateTibetanWidthPx(text: string, contextEl: HTMLElement): number {
  const aWidthPx = measureLatinAWidthPx(contextEl);
  const pxPerBaUnit = aWidthPx / active.latinAInBaUnits;
  return estimateTibetanWidthInBaUnits(text) * pxPerBaUnit;
}

/**
 * Truncate `text` to the longest prefix whose estimated rendered width
 * fits within `maxPx * lines` (under `contextEl`'s font), appending '…'
 * if truncated. Snaps the cut to the nearest tsek (U+0F0B) inside the
 * budget when possible — preserves syllable integrity, never breaks
 * mid-stack.
 */
export function truncateTibetanToWidth(
  text: string,
  maxPx: number,
  contextEl: HTMLElement,
  lines: number = 1,
): string {
  const aWidthPx = measureLatinAWidthPx(contextEl);
  if (aWidthPx <= 0 || maxPx <= 0) return text;
  const pxPerBaUnit = aWidthPx / active.latinAInBaUnits;
  const maxBaUnits = (maxPx * lines) / pxPerBaUnit;

  if (estimateTibetanWidthInBaUnits(text) <= maxBaUnits) return text;

  const ellipsisUnits = active.latinAInBaUnits; // '…' is non-Tibetan; charge one 'a'
  const budget = Math.max(0, maxBaUnits - ellipsisUnits);

  let acc = 0;
  let lastTsekIdx = -1;
  let lastFitIdx = 0;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = widthInBaUnits(cp);
    if (acc + w > budget) break;
    acc += w;
    i += ch.length;
    lastFitIdx = i;
    if (cp === TSEK) lastTsekIdx = i;
  }
  const cutIdx = lastTsekIdx > 0 ? lastTsekIdx : lastFitIdx;
  return text.substring(0, cutIdx) + '…';
}

/**
 * Truncate `text` so it visually fits in `el` within `maxLines` lines.
 *
 * Foolproof: binary-searches against `el.scrollHeight`, so it works
 * regardless of font fallback, CSS cascade quirks, or sibling layout. Snaps
 * the cut to the nearest tsek (U+0F0B) within a small lookback window so
 * the visible end never breaks mid-syllable.
 *
 * Mutates `el.textContent` during measurement and restores the original
 * before returning — call from a `useLayoutEffect` (or any pre-paint slot)
 * to avoid flicker. The returned string is what the caller should commit
 * to React state for the next render.
 *
 * Returns `text` unchanged when the full text already fits.
 */
export function fitTibetanToLines(
  el: HTMLElement,
  text: string,
  maxLines: number,
): string {
  if (maxLines <= 0 || !text) return text;

  const originalText = el.textContent;
  const originalWhiteSpace = el.style.whiteSpace;

  try {
    // Probe the actual rendered per-line height for THIS text in THIS
    // element. CSS `line-height` is a MINIMUM — Tibetan stacks (subjoined
    // letters + vowels + marks) often make line boxes taller. Forcing
    // `white-space: nowrap` puts everything on one line so scrollHeight
    // directly reports the maximum line-box height the text demands.
    el.style.whiteSpace = 'nowrap';
    el.textContent = text;
    const cs = window.getComputedStyle(el);
    const oneLineHeight = el.scrollHeight
      || parseFloat(cs.lineHeight)
      || (parseFloat(cs.fontSize) || 16) * 1.6;
    el.style.whiteSpace = originalWhiteSpace;

    const threshold = oneLineHeight * maxLines + 1; // 1px tolerance

    // Try the full text first; nothing to do if it already fits.
    el.textContent = text;
    if (el.scrollHeight <= threshold) return text;

    // Binary-search the largest prefix length that fits.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      el.textContent = text.substring(0, mid) + '…';
      if (el.scrollHeight <= threshold) lo = mid;
      else hi = mid - 1;
    }

    // Snap to the most recent tsek within ~20 codepoints, if any.
    let cut = lo;
    const lookback = Math.max(0, lo - 20);
    for (let i = lo; i > lookback; i--) {
      if (text.charCodeAt(i - 1) === TSEK) { cut = i; break; }
    }
    return text.substring(0, cut) + '…';
  } finally {
    // Restore so React's reconciler stays the source of truth.
    el.style.whiteSpace = originalWhiteSpace;
    el.textContent = originalText;
  }
}
