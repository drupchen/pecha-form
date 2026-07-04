import { createContext } from 'react';

export interface SearchMatch {
  start: number;
  end: number;
}

/**
 * All raw_text matches of the current search query, in document order.
 * Provided by WorkspaceView and consumed by SegmentCard for highlighting.
 */
export const TaggerSearchContext = createContext<SearchMatch[]>([]);

/**
 * Find every non-overlapping occurrence of `query` in `text`. Case-sensitive —
 * Tibetan has no case anyway, and this matches the browser's default Find.
 */
export function findMatches(text: string, query: string): SearchMatch[] {
  if (!query) return [];
  const out: SearchMatch[] = [];
  let pos = 0;
  while (true) {
    const idx = text.indexOf(query, pos);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + query.length });
    pos = idx + query.length;
  }
  return out;
}
