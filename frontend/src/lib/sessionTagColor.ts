/**
 * Compute a session-tag color from its name.
 *
 * Names follow `^[A-Z]\d+$` (e.g. A1, B3, K12). Letter selects a hue (looping
 * past J), number selects a shade (1=light, 2=medium, 3=strong, 4=dark, then
 * looping). Tailwind 200/400/600/800 hex values are used for the 4 shades.
 *
 * If the name doesn't parse, returns slate.
 */

// 10 hues. Each entry is the 4 Tailwind shade hexes [200, 400, 600, 800].
const HUE_PALETTE: readonly (readonly [string, string, string, string])[] = [
  ['#fecaca', '#f87171', '#dc2626', '#991b1b'], // red
  ['#bfdbfe', '#60a5fa', '#2563eb', '#1e40af'], // blue
  ['#bbf7d0', '#4ade80', '#16a34a', '#166534'], // green
  ['#e9d5ff', '#c084fc', '#9333ea', '#6b21a8'], // purple
  ['#fed7aa', '#fb923c', '#ea580c', '#9a3412'], // orange
  ['#a5f3fc', '#22d3ee', '#0891b2', '#155e75'], // cyan
  ['#fbcfe8', '#f472b6', '#db2777', '#9d174d'], // pink
  ['#fef08a', '#facc15', '#ca8a04', '#854d0e'], // yellow
  ['#c7d2fe', '#818cf8', '#4f46e5', '#3730a3'], // indigo
  ['#d9f99d', '#a3e635', '#65a30d', '#3f6212'], // lime
];

const FALLBACK = '#94a3b8'; // slate

export const SESSION_TAG_NAME_RE = /^([A-Z])(\d+)$/;

export function colorForSessionTag(name: string): string {
  const m = SESSION_TAG_NAME_RE.exec(name.trim());
  if (!m) return FALLBACK;
  const letterIdx = (m[1].charCodeAt(0) - 'A'.charCodeAt(0)) % HUE_PALETTE.length;
  const shadeIdx = (Number.parseInt(m[2], 10) - 1) % 4;
  return HUE_PALETTE[letterIdx][shadeIdx];
}
