/**
 * Scroll the tagger pane to the segment containing the given raw_text offset
 * and flash it briefly so the user sees where it landed.
 *
 * Reads `[data-segment-start]` / `[data-segment-end]` markers placed on each
 * SegmentCard's body container.
 */
export function scrollTaggerToOffset(offset: number) {
  const containers = document.querySelectorAll<HTMLElement>('[data-segment-start]');
  for (const c of containers) {
    const start = Number(c.dataset.segmentStart);
    const end = Number(c.dataset.segmentEnd);
    if (offset >= start && offset <= end) {
      c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      c.classList.remove('link-pulse');
      void c.offsetWidth;
      c.classList.add('link-pulse');
      setTimeout(() => c.classList.remove('link-pulse'), 1200);
      return;
    }
  }
}
