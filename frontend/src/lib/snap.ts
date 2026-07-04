/**
 * Snap [start, end] to unit (syllable) boundaries from a tokenizer's output.
 * `units` is a list of `[start, end, text]` tuples (assumed sorted, non-overlapping).
 * Returns null if the snapped range is degenerate. Shared by the Workspace,
 * Transcriptions, and Search views so text selection always lands on whole syllables.
 */
export function snapToUnits(
  start: number,
  end: number,
  units: [number, number, string][],
): { start: number; end: number } | null {
  let snappedStart = start;
  let snappedEnd = end;
  for (const [us, ue] of units) {
    if (start >= us && start < ue) snappedStart = us;
    if (end > us && end <= ue) snappedEnd = ue;
  }
  if (snappedEnd <= snappedStart) return null;
  return { start: snappedStart, end: snappedEnd };
}
