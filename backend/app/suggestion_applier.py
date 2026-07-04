"""Apply edit suggestions to raw_text and produce an offset remap.

A suggestion is a dict with at minimum:
    start_offset (int), end_offset (int), suggested_text (str), created_at (str/datetime)

Semantics:
    - start == end → pure insertion
    - end > start, suggested_text == "" → pure deletion
    - end > start, suggested_text != "" → replacement

The applier requires that no two selected suggestions overlap — but a zero-width
insertion may sit at a region's *boundary* (it is applied immediately before/after the
region, not inside it). Only a genuine intersection (two positive-width edits, or an
insertion strictly inside a region) is rejected.
"""

from bisect import bisect_right


def apply_suggestions(raw_text: str, suggestions: list[dict]) -> tuple[str, list[tuple[int, int]]]:
    """Return (modified_text, offset_map).

    offset_map is a list of (original_offset, modified_offset) pairs, sorted by
    original_offset, defining piecewise-linear mapping from original to modified.
    Between consecutive map points the mapping is identity-with-constant-delta.
    Includes (0, 0) and (len(raw_text), len(modified_text)) bookends.
    """
    if not suggestions:
        return raw_text, [(0, 0), (len(raw_text), len(raw_text))]

    # At a shared start offset, order a zero-width insertion *before* a positive-width
    # replacement/deletion: the insertion belongs just before the region it abuts, so an
    # insertion at a replacement's start boundary is adjacent (a.end == b.start), not
    # overlapping. An insertion strictly inside a region still sorts after the region's
    # start and trips the `a.end > b.start` check below.
    sugs = sorted(suggestions, key=lambda s: (
        s["start_offset"],
        0 if s["end_offset"] == s["start_offset"] else 1,
        str(s.get("created_at", "")),
    ))

    for a, b in zip(sugs, sugs[1:]):
        if a["end_offset"] > b["start_offset"]:
            raise ValueError(
                f"overlapping suggestions: [{a['start_offset']},{a['end_offset']}] and "
                f"[{b['start_offset']},{b['end_offset']}]"
            )

    out_chunks: list[str] = []
    offset_map: list[tuple[int, int]] = [(0, 0)]
    src_cursor = 0
    delta = 0

    for s in sugs:
        # Verbatim region before this suggestion
        out_chunks.append(raw_text[src_cursor:s["start_offset"]])
        # Map point at start of suggestion (before replacement)
        offset_map.append((s["start_offset"], s["start_offset"] + delta))
        # Apply suggestion
        out_chunks.append(s["suggested_text"])
        # Update delta: how many chars the modified text gained/lost
        delta += len(s["suggested_text"]) - (s["end_offset"] - s["start_offset"])
        # Map point at end of suggestion (after replacement)
        offset_map.append((s["end_offset"], s["end_offset"] + delta))
        src_cursor = s["end_offset"]

    # Trailing verbatim region
    out_chunks.append(raw_text[src_cursor:])
    modified_text = "".join(out_chunks)
    offset_map.append((len(raw_text), len(modified_text)))

    return modified_text, offset_map


def inv_remap(mod_offset: int, offset_map: list[tuple[int, int]]) -> int | None:
    """Map an offset in the modified (corrected) text back to raw_text.

    The inverse of the verbatim regions in ``offset_map``. Returns ``None`` when
    ``mod_offset`` falls strictly inside a replaced/inserted region — there is no
    exact raw counterpart there (the chars came from a suggestion, not raw_text).
    Region boundaries always resolve (they coincide with raw offsets), so a
    corrected token lying wholly in untouched text maps cleanly on both ends.

    ``apply_suggestions`` builds the map as strictly alternating segments starting
    with a verbatim chunk: even-index segments are verbatim (length-preserving),
    odd-index segments are the replaced/inserted spans.
    """
    for i in range(len(offset_map) - 1):
        o0, m0 = offset_map[i]
        o1, m1 = offset_map[i + 1]
        if m0 <= mod_offset <= m1:
            if mod_offset == m0:
                return o0
            if mod_offset == m1:
                return o1
            if i % 2 == 0:
                return o0 + (mod_offset - m0)  # verbatim region
            return None  # strictly inside an inserted/replaced chunk
    return None


def corr_offset_to_raw(offset_map: list[tuple[int, int]], mod_offset: int, *, is_end: bool) -> int:
    """Map a corrected-text offset back to raw, *snapping* offsets that fall inside a
    replaced/inserted region to that region's raw boundary (where ``inv_remap``
    returns ``None``). Verbatim offsets map exactly; a region boundary is exact; for
    a position strictly inside a replacement, ``is_end`` picks the raw end vs. raw
    start so a whole corrected sub-token collapses onto the one raw region it came
    from. Used to give corrected syllables/units raw offsets for the editor display
    and the main-text matcher."""
    for i in range(len(offset_map) - 1):
        o0, m0 = offset_map[i]
        o1, m1 = offset_map[i + 1]
        if m0 <= mod_offset <= m1:
            if mod_offset == m0:
                return o0
            if mod_offset == m1:
                return o1
            if i % 2 == 0:  # verbatim region (length-preserving)
                return o0 + (mod_offset - m0)
            return o1 if is_end else o0  # inside a replaced/inserted span → snap
    return offset_map[-1][0] if offset_map else mod_offset


def remap(orig_offset: int, offset_map: list[tuple[int, int]]) -> int:
    """Map an offset in raw_text to its position in the modified text.

    Offsets that fall inside a replaced range collapse to the start of the replacement.
    Use this for span boundaries when computing exporter "text" slices.
    """
    keys = [m[0] for m in offset_map]
    idx = bisect_right(keys, orig_offset) - 1
    if idx < 0:
        return 0
    base_orig, base_mod = offset_map[idx]
    if idx + 1 < len(offset_map):
        next_orig, next_mod = offset_map[idx + 1]
        if base_orig == next_orig:
            # We landed inside a replacement region; collapse to start.
            return base_mod
        if orig_offset <= next_orig:
            # Verbatim region (identity shifted by constant delta).
            return base_mod + (orig_offset - base_orig)
    return base_mod + (orig_offset - base_orig)
