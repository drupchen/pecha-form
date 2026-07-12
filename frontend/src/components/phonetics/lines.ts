import type { EditorToken } from '../../api/client';
import type { Span } from '../../store/useTagStore';
import { deriveChunks, type DerivedChunk } from '../translate/chunks';

/**
 * A phonetics LINE — one printed recitation line of the booklet's stream. Same
 * shape as a translation chunk (it IS a DerivedChunk, derived in line mode: the
 * stream splits at EVERY automatic break, so verse/prose lines and mantra lines
 * each stand alone), carrying its own `kind`:
 *   `bo`  = Tibetan verse/prose  → phonetics (tibetan-ewts-converter)
 *   `skt` = Sanskrit mantra      → romanization (EWTS decode + our mapping)
 * Only recited lines are emitted; small/sapche/title/plain instructions are not.
 */
export interface PhoneticLine extends DerivedChunk {
  kind: 'bo' | 'skt';
}

/** tagType → phonetics kind, or null for lines that are not recited. */
function kindOf(tagType: string): 'bo' | 'skt' | null {
  if (tagType === 'mantra') return 'skt';
  if (tagType === 'verse' || tagType === 'prose') return 'bo';
  return null;  // small / sapche / title / plain — not recited
}

export function deriveLines(
  tokens: EditorToken[],
  markerOffsets: Set<number>,
  spans: Span[],
  breakOverrides: Map<string, number>,
): PhoneticLine[] {
  if (!tokens.length) return [];
  const units = deriveChunks(
    tokens, markerOffsets, spans, breakOverrides,
    { verse: true, sapche: true, mantra: true },
    undefined,
    /* lineLevel */ true,
  );
  const out: PhoneticLine[] = [];
  for (const u of units) {
    const kind = kindOf(u.tagType);
    if (kind && u.startSylId) out.push({ ...u, kind });
  }
  return out;
}
