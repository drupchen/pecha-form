/**
 * Scroll the tagger pane to the segment containing the given raw_text offset
 * and flash it briefly so the user sees where it landed.
 *
 * Reads `[data-segment-start]` / `[data-segment-end]` markers placed on each
 * SegmentCard's body container.
 */
/**
 * Scroll the tagger pane to the segment that begins with the given syllable id
 * (the last-viewed-segment anchor). Falls back to the segment that contains the
 * syllable if it is no longer a segment start (e.g. a separator was removed).
 * Returns true if a target was found and scrolled to.
 */
export function scrollTaggerToSyllable(sylId: string): boolean {
  if (!sylId) return false;
  // Preferred: the segment whose first syllable is exactly this one.
  const exact = document.querySelector<HTMLElement>(
    `[data-segment-syl="${CSS.escape(sylId)}"]`,
  );
  if (exact) {
    exact.scrollIntoView({ behavior: 'auto', block: 'start' });
    return true;
  }
  // Fallback: the token carrying this syllable id — scroll its nearest segment box.
  const tok = document.querySelector<HTMLElement>(`[data-syl-id="${CSS.escape(sylId)}"]`);
  const seg = tok?.closest<HTMLElement>('[data-segment-start]');
  if (seg) {
    seg.scrollIntoView({ behavior: 'auto', block: 'start' });
    return true;
  }
  return false;
}

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
