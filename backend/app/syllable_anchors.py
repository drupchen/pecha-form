"""Phase 3: populate syllable-UUID anchor columns from char offsets.

Every offset-anchored annotation boundary lands exactly on a syllable edge once
``scripts/phase3_snap_offgrid.py`` has run (step 1). This module derives the
parallel ``*_syl_id`` columns (added by ``db._COLUMN_MIGRATIONS``) from those
offsets, deterministically and idempotently — re-running recomputes from the
offsets and overwrites.

Anchor convention (see db.py):
  * Range row [start_offset, end_offset): ``start_syl_id`` = syllable whose
    ``start_offset`` == row.start_offset (inclusive first), ``end_syl_id`` =
    syllable whose ``end_offset`` == row.end_offset (inclusive last).
  * Zero-width insertion suggestion (start==end): ``start_syl_id`` = the
    syllable starting at that offset (insert *before* it), ``end_syl_id`` NULL.
  * Single boundary (markers.position, tree_nodes.segment_start): the syllable
    that STARTS at that offset (NULL only at text end).
  * tags: ``open_syl_id`` = syllable@open_position start,
    ``close_syl_id`` = syllable@close_position end.
  * Transcript tables anchor to ``transcript_syllables`` of their srt_segment.

``backfill_anchors`` raises if a non-insertion boundary fails to map (which
would mean an off-grid offset slipped through step 1).
"""


def _root_maps(conn, text_id):
    # Phase 3 E5: offsets are derived from the syllable sequence (cumulative text
    # lengths), not read from stored columns.
    start2id, end2id = {}, {}
    pos = 0
    for r in conn.execute(
        "SELECT id, text FROM syllables WHERE text_id=? ORDER BY idx",
        (text_id,),
    ):
        end = pos + len(r["text"])
        start2id[pos] = r["id"]
        end2id[end] = r["id"]
        pos = end
    return start2id, end2id


def _transcript_maps(conn, text_id):
    """{srt_segment_id: (start_offset->id, end_offset->id)}. Offsets derived per
    segment from cumulative text lengths (E5)."""
    segs = {}
    pos = {}
    for r in conn.execute(
        "SELECT srt_segment_id, id, text "
        "FROM transcript_syllables WHERE text_id=? ORDER BY srt_segment_id, idx",
        (text_id,),
    ):
        sid = r["srt_segment_id"]
        s2, e2 = segs.setdefault(sid, ({}, {}))
        p = pos.get(sid, 0)
        end = p + len(r["text"])
        s2[p] = r["id"]
        e2[end] = r["id"]
        pos[sid] = end
    return segs


# --- Per-row anchor helpers (Phase 3 E4): populate a single annotation's anchors
# from its offsets at create/update time, so live rows are syllable-anchored
# immediately (not only at publish). Offsets are syllable-aligned, so the lookup
# is exact; a missing id (e.g. before the syllable layer exists) yields None.

def anchor_for_range(conn, text_id, start_offset, end_offset):
    """(start_syl_id, end_syl_id) for a root range; end_syl_id None for a
    zero-width insertion (start == end)."""
    start2id, end2id = _root_maps(conn, text_id)
    if start_offset == end_offset:
        return start2id.get(start_offset), None
    return start2id.get(start_offset), end2id.get(end_offset)


def anchor_for_point(conn, text_id, offset):
    """Syllable that STARTS at `offset` (markers / tree_nodes.segment_start)."""
    start2id, _ = _root_maps(conn, text_id)
    return start2id.get(offset)


def anchor_for_close(conn, text_id, offset):
    """Syllable that ENDS at `offset` (a session tag's close_position)."""
    _, end2id = _root_maps(conn, text_id)
    return end2id.get(offset)


def anchor_for_transcript_range(conn, srt_segment_id, start_offset, end_offset):
    """(start_syl_id, end_syl_id) within one transcript segment; end None for
    a zero-width insertion."""
    s2, e2 = {}, {}
    pos = 0
    for r in conn.execute(
        "SELECT id, text FROM transcript_syllables WHERE srt_segment_id=? ORDER BY idx",
        (srt_segment_id,),
    ):
        end = pos + len(r["text"])
        s2[pos] = r["id"]
        e2[end] = r["id"]
        pos = end
    if start_offset == end_offset:
        return s2.get(start_offset), None
    return s2.get(start_offset), e2.get(end_offset)


def backfill_anchors(conn, text_id) -> dict:
    """Populate every ``*_syl_id`` column for one text from its offsets.

    Returns a counts dict per table. Raises ValueError on any unmappable
    (off-grid) boundary."""
    start2id, end2id = _root_maps(conn, text_id)
    counts = {}
    errors = []

    def s(off):
        v = start2id.get(off)
        if v is None:
            errors.append(("start", off))
        return v

    def e(off):
        v = end2id.get(off)
        if v is None:
            errors.append(("end", off))
        return v

    # ---- root range tables ----
    for table in ("spans", "notes"):
        n = 0
        for r in conn.execute(
            f"SELECT id, start_offset, end_offset FROM {table} WHERE text_id=?",
            (text_id,),
        ).fetchall():
            conn.execute(
                f"UPDATE {table} SET start_syl_id=?, end_syl_id=? WHERE id=?",
                (s(r["start_offset"]), e(r["end_offset"]), r["id"]),
            )
            n += 1
        counts[table] = n

    # text_portions: same shape, scoped by text
    n = 0
    for r in conn.execute(
        "SELECT id, start_offset, end_offset FROM text_portions WHERE text_id=?",
        (text_id,),
    ).fetchall():
        conn.execute(
            "UPDATE text_portions SET start_syl_id=?, end_syl_id=? WHERE id=?",
            (s(r["start_offset"]), e(r["end_offset"]), r["id"]),
        )
        n += 1
    counts["text_portions"] = n

    # suggestions: replacements are ranges; insertions (start==end) anchor before
    # the syllable starting at the offset, end_syl_id NULL.
    n = 0
    for r in conn.execute(
        "SELECT id, start_offset, end_offset FROM suggestions WHERE text_id=?",
        (text_id,),
    ).fetchall():
        if r["start_offset"] == r["end_offset"]:
            conn.execute(
                "UPDATE suggestions SET start_syl_id=?, end_syl_id=NULL WHERE id=?",
                (start2id.get(r["start_offset"]), r["id"]),
            )
        else:
            conn.execute(
                "UPDATE suggestions SET start_syl_id=?, end_syl_id=? WHERE id=?",
                (s(r["start_offset"]), e(r["end_offset"]), r["id"]),
            )
        n += 1
    counts["suggestions"] = n

    # ---- single-boundary anchors ----
    n = 0
    for r in conn.execute(
        "SELECT id, position FROM markers WHERE text_id=?", (text_id,)
    ).fetchall():
        conn.execute(
            "UPDATE markers SET syl_id=? WHERE id=?",
            (start2id.get(r["position"]), r["id"]),
        )
        n += 1
    counts["markers"] = n

    n = 0
    for r in conn.execute(
        "SELECT id, segment_start FROM tree_nodes "
        "WHERE text_id=? AND segment_start IS NOT NULL",
        (text_id,),
    ).fetchall():
        conn.execute(
            "UPDATE tree_nodes SET segment_start_syl_id=? WHERE id=?",
            (start2id.get(r["segment_start"]), r["id"]),
        )
        n += 1
    counts["tree_nodes"] = n

    # ---- tags (session open/close) ----
    n = 0
    for r in conn.execute(
        "SELECT id, open_position, close_position FROM tags "
        "WHERE text_id=? AND open_position IS NOT NULL",
        (text_id,),
    ).fetchall():
        conn.execute(
            "UPDATE tags SET open_syl_id=?, close_syl_id=? WHERE id=?",
            (start2id.get(r["open_position"]), end2id.get(r["close_position"]), r["id"]),
        )
        n += 1
    counts["tags"] = n

    # ---- transcript tables (per-segment grid) ----
    segs = _transcript_maps(conn, text_id)
    for table in ("transcript_spans", "transcript_suggestions", "transcript_notes"):
        n = 0
        for r in conn.execute(
            f"SELECT id, srt_segment_id, start_offset, end_offset FROM {table} "
            "WHERE text_id=?",
            (text_id,),
        ).fetchall():
            s2, e2 = segs.get(r["srt_segment_id"], ({}, {}))
            sid = s2.get(r["start_offset"])
            eid = (None if r["start_offset"] == r["end_offset"]
                   else e2.get(r["end_offset"]))
            if sid is None:
                errors.append((table + ".start", r["srt_segment_id"], r["start_offset"]))
            if eid is None and r["start_offset"] != r["end_offset"]:
                errors.append((table + ".end", r["srt_segment_id"], r["end_offset"]))
            conn.execute(
                f"UPDATE {table} SET start_syl_id=?, end_syl_id=? WHERE id=?",
                (sid, eid, r["id"]),
            )
            n += 1
        counts[table] = n

    if errors:
        raise ValueError(f"unmappable (off-grid) boundaries: {errors[:10]} "
                         f"(+{max(0, len(errors)-10)} more)")
    return counts
