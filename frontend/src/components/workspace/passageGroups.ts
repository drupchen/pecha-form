import type { Passage } from '../../api/client';

/**
 * Partition the passages at ONE anchor into inline passages and standalone segment
 * groups, mirroring marker semantics: `own_segment` (or a node link) means "a segment
 * boundary starts right BEFORE this passage". Passages before the first such starter
 * render inline in the host segment; each starter begins a group — itself plus every
 * following non-starter — rendered as ONE standalone card.
 */
export function partitionAnchorPassages(
  anchorPassages: Passage[],
  nodeLinkedPassageIds: Set<number>,
): { inline: Passage[]; groups: Passage[][] } {
  const sorted = [...anchorPassages].sort((a, b) => a.position - b.position || a.id - b.id);
  const isStarter = (p: Passage) => p.own_segment || nodeLinkedPassageIds.has(p.id);
  const inline: Passage[] = [];
  const groups: Passage[][] = [];
  for (const p of sorted) {
    if (isStarter(p)) groups.push([p]);
    else if (groups.length) groups[groups.length - 1].push(p);
    else inline.push(p);
  }
  return { inline, groups };
}
