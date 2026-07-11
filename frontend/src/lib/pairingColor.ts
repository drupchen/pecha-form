/**
 * Soft, distinct background colors for alignment pairings (a text portion + its
 * contiguous SRT segments share one color). Cycled by pairing order so adjacent
 * pairings are easy to tell apart; used as a stable fallback when a portion has
 * no persisted color yet.
 */

// Light pastel hexes (Tailwind ~200 shades), tuned to read as gentle highlights
// behind Tibetan text and transcript rows.
const PALETTE: readonly string[] = [
  '#fde68a', // amber
  '#bfdbfe', // blue
  '#bbf7d0', // green
  '#e9d5ff', // purple
  '#fed7aa', // orange
  '#a5f3fc', // cyan
  '#fbcfe8', // pink
  '#d9f99d', // lime
  '#c7d2fe', // indigo
  '#fecaca', // red
];

export function colorAt(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** The next color to use given how many pairings already exist. */
export function nextColor(existingCount: number): string {
  return colorAt(existingCount);
}

/** A portion's display color: its persisted color, else a fallback by order. */
export function portionColor(color: string | null | undefined, orderIndex: number): string {
  return color || colorAt(orderIndex);
}

/** The neutral "active / pending" highlight used before a pairing is committed. */
export const ACTIVE_COLOR = 'rgba(236,179,32,0.35)';
