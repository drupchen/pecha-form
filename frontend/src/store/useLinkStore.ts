import { create } from 'zustand';

/**
 * Cross-pane linking state for the workspace.
 *
 * A "link key" is a segment's start offset (number). Both a tree node
 * (via its `segment_start`) and a tagger segment (via its `start`) carry
 * the same key, expressed as `data-link-key="<segmentStart>"` on their root
 * DOM element. The LinkOverlay component reads exactly two
 * `getBoundingClientRect()`s for the currently hovered/focused key and draws
 * a single SVG path between them.
 */
interface LinkState {
  hoveredKey: number | null;
  focusedKey: number | null;
  setHovered: (key: number | null) => void;
  setFocused: (key: number | null) => void;
}

export const useLinkStore = create<LinkState>((set) => ({
  hoveredKey: null,
  focusedKey: null,
  setHovered: (key) => set({ hoveredKey: key }),
  setFocused: (key) => set({ focusedKey: key }),
}));

/**
 * Find the partner DOM element for a link key (the one that isn't `sourceEl`)
 * and scroll it into view with a brief pulse highlight.
 */
export function scrollToLinkPartner(key: number, sourceEl: HTMLElement | null): void {
  const all = document.querySelectorAll<HTMLElement>(`[data-link-key="${key}"]`);
  const partner = Array.from(all).find(el => el !== sourceEl);
  if (!partner) return;
  partner.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
