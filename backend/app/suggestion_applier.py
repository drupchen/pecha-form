"""Apply edit suggestions to a raw *syllable sequence* (syllable-native, offset-free).

Part 6, Phase 3: a suggestion is anchored by syllable ids —
``(start_syl_id, end_syl_id, suggested_text)`` — and applied by splicing the inclusive
syllable run ``[start_syl_id .. end_syl_id]`` (resolved by position in the ordered
syllable list) out of the sequence and inserting ``suggested_text`` in its place. There
is no char-offset arithmetic and no offset map; the old ``offset_map``/``remap``/
``inv_remap``/``corr_offset_to_raw`` machinery is gone.

Semantics (mirror the retired offset core exactly):
- ``end_syl_id`` None                          → pure insertion *before* ``start_syl_id``
                                                 (zero-width).
- ``end_syl_id`` set, ``suggested_text == ""`` → pure deletion of the run.
- ``end_syl_id`` set, ``suggested_text != ""`` → replacement of the run.

Two positive-width runs may not intersect; a zero-width insertion may sit at a run's
*boundary* (immediately before the run's first syllable, or before the syllable just
past its last) but never strictly inside it. On read the applier is defensive: a
suggestion that intersects an already-placed run is *skipped* (dropped), so a single
overlapping suggestion can never break the whole corrected layer — the writer is what
keeps overlaps from being created in the first place.

``splice_suggestions`` returns a list of *segments*, each either a verbatim raw syllable
(``kind == "keep"``) or an edit (``kind == "edit"``: the inserted/replacing text plus the
raw span it stands in for). ``segments_text`` joins them into the corrected string —
byte-identical to the old char splice, since the raw syllables tile the raw text exactly
(``manifest.generate_syllables`` guarantees ``"".join(s["text"]) == raw_text``).
"""


def _resolve(raw_syllables, suggestions):
    """Resolve each suggestion's syllable anchors to positions in ``raw_syllables`` and
    sort into apply order. Returns ``[(start_pos, end_pos|None, sug), …]`` sorted by
    ``(start_pos, zero-width-insertion-first, created_at)``. A suggestion whose anchor no
    longer resolves (its syllable was rebuilt away) is skipped — it can't be placed."""
    pos_of = {s["id"]: i for i, s in enumerate(raw_syllables)}
    resolved = []
    for sug in suggestions:
        sp = pos_of.get(sug.get("start_syl_id"))
        if sp is None:
            continue
        end_id = sug.get("end_syl_id")
        if end_id is None:
            ep = None
        else:
            ep = pos_of.get(end_id)
            if ep is None:
                continue
        resolved.append((sp, ep, sug))
    # A zero-width insertion sharing a run's start syllable is ordered *before* the run
    # (it abuts the boundary, not an overlap); ties break by creation time.
    resolved.sort(key=lambda r: (
        r[0],
        0 if r[1] is None else 1,
        str(r[2].get("created_at") or ""),
    ))
    return resolved


def splice_suggestions(raw_syllables, suggestions):
    """Splice syllable-anchored ``suggestions`` into the ordered ``raw_syllables``.

    ``raw_syllables``: dicts ``{id, text, nature, start_offset, end_offset, …}`` in idx
    order (as from ``manifest.load_syllables``). ``suggestions``: dicts with
    ``start_syl_id``, ``end_syl_id`` (or None), ``suggested_text``, ``created_at``.

    Returns a list of segment dicts:
    - ``{"kind": "keep", "syl": <raw syllable dict>}`` — an untouched syllable, or
    - ``{"kind": "edit", "text": <str>, "raw_start": int, "raw_end": int}`` — the
      inserted/replacing text standing in for raw span ``[raw_start, raw_end)``
      (``raw_start == raw_end`` for a pure insertion).
    Raises ``ValueError`` on a genuine run intersection.
    """
    resolved = _resolve(raw_syllables, suggestions)

    # Overlap handling (by position): a positive-width run consumes syllables [sp..ep];
    # anything that starts at or before ep intersects it and cannot be placed. The writer
    # (`suggestions._check_overlap`) prevents creating such overlaps, but the extract
    # delete-suggestion path and legacy data can still produce them — so we *skip* the
    # unplaceable one (as we already skip a suggestion whose anchor no longer resolves)
    # rather than raise, which would blank the entire corrected layer for the whole text.
    placeable = []
    consumed_to = -1
    for sp, ep, sug in resolved:
        if sp <= consumed_to:
            continue  # intersects an already-consumed run — drop it
        placeable.append((sp, ep, sug))
        if ep is not None:
            consumed_to = ep

    segments = []
    cursor = 0
    for sp, ep, sug in placeable:
        for i in range(cursor, sp):
            segments.append({"kind": "keep", "syl": raw_syllables[i]})
        raw_start = raw_syllables[sp]["start_offset"]
        if ep is None:  # insertion before sp; sp itself is not consumed
            segments.append({"kind": "edit", "text": sug["suggested_text"],
                             "raw_start": raw_start, "raw_end": raw_start})
            cursor = sp
        else:
            segments.append({"kind": "edit", "text": sug["suggested_text"],
                             "raw_start": raw_start,
                             "raw_end": raw_syllables[ep]["end_offset"]})
            cursor = ep + 1
    for i in range(cursor, len(raw_syllables)):
        segments.append({"kind": "keep", "syl": raw_syllables[i]})
    return segments


def segments_text(segments):
    """The corrected string: raw syllable texts with edit runs spliced in. Byte-identical
    to the old ``apply_suggestions`` output because the raw syllables tile the raw text."""
    parts = [seg["syl"]["text"] if seg["kind"] == "keep" else seg["text"]
             for seg in segments]
    return "".join(parts)
