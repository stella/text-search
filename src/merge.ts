import type { Match } from "./types";

/**
 * Merge matches from multiple engines, sort by
 * position, and select non-overlapping (longest
 * first at ties). Same algorithm as regex-set's
 * internal select_non_overlapping.
 */
export function mergeAndSelect(
  matches: Match[],
): Match[] {
  if (matches.length <= 1) return matches;

  // Sort: start ascending, longest first at ties
  matches.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - b.start - (a.end - a.start);
  });

  // Greedily select non-overlapping
  const selected: Match[] = [];
  let lastEnd = 0;

  for (const m of matches) {
    if (m.start >= lastEnd) {
      selected.push(m);
      lastEnd = m.end;
    }
  }

  return selected;
}
