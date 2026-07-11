"""Part 6: syllable UUIDs are the sole annotation anchor; char offsets are derived.

Phase 3 dropped every stored char-offset column (see ``db._drop_offset_columns``).
Annotations store only their ``*_syl_id`` anchors; any char offset a caller needs
(the frontend render/selection aid, the corrected-text apply core) is *derived on
read* from the current syllable sequence via cumulative text length ("E5"), so
there is never a second stored partition to drift from the syllables table.

Convention (see db.py):
  * Range row: ``start_syl_id`` = inclusive first syllable, ``end_syl_id`` =
    inclusive last syllable → offsets ``[start_of(start_syl), end_of(end_syl))``.
  * Zero-width insertion suggestion: ``start_syl_id`` set, ``end_syl_id`` NULL →
    ``start_offset == end_offset`` (insert *before* ``start_syl_id``).
  * Single boundary (markers, tree_nodes.segment_start): the syllable that STARTS
    at that boundary (NULL only at text end).
  * tags: ``open_syl_id`` = open syllable start, ``close_syl_id`` = close syllable end.

``anchor_for_*`` map a legacy offset (still accepted on a couple of write paths and
by ``notes``, whose payload is offset-based) back to a syllable id; ``offsets_for_*``
/ ``offset_for_syl_*`` derive offsets from syllable ids for read responses.
"""


def _token_seq(conn, text_id):
    """Ordered ``(id, text)`` pairs — the anchor space of a text.

    A primary anchors on its own syllable rows. A secondary anchors on its COMPOSED
    sequence (parent refs + derivation ops, recursive), whose token ids are real
    syllable uuids owned by the texts in its chain — this is what makes secondaries
    taggable/markable/annotatable with the exact same anchor machinery."""
    row = conn.execute("SELECT text_type FROM texts WHERE id = ?", (text_id,)).fetchone()
    if row and row["text_type"] == "secondary":
        from .derivation import compose_secondary  # late import (no module cycle)
        return [(t["id"], t["text"]) for t in compose_secondary(conn, text_id)]
    return [(r["id"], r["text"]) for r in conn.execute(
        "SELECT id, text FROM syllables WHERE text_id=? ORDER BY idx", (text_id,),
    )]


def _root_maps(conn, text_id):
    # Offsets are derived from the token sequence (cumulative text lengths, E5).
    start2id, end2id = {}, {}
    pos = 0
    for tid, text in _token_seq(conn, text_id):
        end = pos + len(text)
        start2id[pos] = tid
        end2id[end] = tid
        pos = end
    return start2id, end2id


# --- Per-row anchor helpers: map a legacy char offset back to the syllable id at
# that boundary (used by the offset-accepting write paths — notes, and the
# back-compat offset branch of spans/suggestions/markers/tags). A missing id (an
# off-grid offset, or before the syllable layer exists) yields None.

def anchor_for_range(conn, text_id, start_offset, end_offset):
    """(start_syl_id, end_syl_id) for a root range; end_syl_id None for a
    zero-width insertion (start == end)."""
    start2id, end2id = _root_maps(conn, text_id)
    if start_offset == end_offset:
        return start2id.get(start_offset), None
    return start2id.get(start_offset), end2id.get(end_offset)


# --- Part 6: forward maps (syl_id -> offset). These make syllable UUIDs the write
# anchor: the frontend sends the syllable(s) it selected and we derive the char
# offsets from the *same* syllable sequence the frontend rendered, so there is no
# second tokenisation to disagree (the units_json/syllables boundary bug). Offsets
# are still cumulative-text-derived (E5), consistent with ``_root_maps``.

def _syl_offset_maps(conn, text_id):
    """(id->start_offset, id->end_offset) for a text, offsets derived from cumulative
    text lengths (E5) over its anchor space (own syllables, or the composed sequence
    for a secondary — see ``_token_seq``)."""
    id2start, id2end = {}, {}
    pos = 0
    for tid, text in _token_seq(conn, text_id):
        end = pos + len(text)
        id2start[tid] = pos
        id2end[tid] = end
        pos = end
    return id2start, id2end


def offsets_for_syls(conn, text_id, start_syl_id, end_syl_id):
    """(start_offset, end_offset) for a syllable range in a root text.

    ``start_offset`` = start of ``start_syl_id``; ``end_offset`` = end of
    ``end_syl_id`` (inclusive last). For a zero-width insertion pass
    ``end_syl_id=None`` → ``end_offset == start_offset`` (insert *before*
    ``start_syl_id``). Raises ValueError if a syllable id is not in the text —
    the boundary-correct replacement for the old ``units_json`` membership check.
    """
    id2start, id2end = _syl_offset_maps(conn, text_id)
    if start_syl_id not in id2start:
        raise ValueError(f"start_syl_id {start_syl_id!r} not in text {text_id}")
    start = id2start[start_syl_id]
    if end_syl_id is None:
        return start, start
    if end_syl_id not in id2end:
        raise ValueError(f"end_syl_id {end_syl_id!r} not in text {text_id}")
    return start, id2end[end_syl_id]


def offset_for_syl_start(conn, text_id, syl_id):
    """start_offset of the syllable ``syl_id`` (markers / tree_nodes.segment_start
    / a tag's open boundary). ``None`` passes through as ``None`` (end-of-text
    sentinel). Raises ValueError if a non-null id is not in the text."""
    if syl_id is None:
        return None
    id2start, _ = _syl_offset_maps(conn, text_id)
    if syl_id not in id2start:
        raise ValueError(f"syl_id {syl_id!r} not in text {text_id}")
    return id2start[syl_id]


def offset_for_syl_close(conn, text_id, syl_id):
    """end_offset of the syllable ``syl_id`` (a session tag's close boundary).
    ``None`` passes through. Raises ValueError if a non-null id is not in the text."""
    if syl_id is None:
        return None
    _, id2end = _syl_offset_maps(conn, text_id)
    if syl_id not in id2end:
        raise ValueError(f"syl_id {syl_id!r} not in text {text_id}")
    return id2end[syl_id]


def anchor_for_point(conn, text_id, offset):
    """Syllable that STARTS at `offset` (markers / tree_nodes.segment_start)."""
    start2id, _ = _root_maps(conn, text_id)
    return start2id.get(offset)


def anchor_for_close(conn, text_id, offset):
    """Syllable that ENDS at `offset` (a session tag's close_position)."""
    _, end2id = _root_maps(conn, text_id)
    return end2id.get(offset)


def suggestions_for_apply(conn, text_id):
    """The text's suggestions as raw syllable-anchored rows for the corrected-text
    applier (``suggestion_applier.splice_suggestions``). Each dict:
    ``{start_syl_id, end_syl_id, suggested_text, created_at}``.

    Post-Phase-3, the applier splices *syllable runs* (no char offsets), so this is a
    plain row fetch — anchor resolution against the current syllable sequence and the
    apply ordering (insertion-before-run, then ``created_at``) are handled inside
    ``splice_suggestions``. A suggestion whose anchor no longer resolves is skipped
    there (it can't be placed anyway). Only APPLIED suggestions splice — a 'pending'
    row (incoming from a derived text, awaiting review) has no effect until accepted."""
    return [dict(r) for r in conn.execute(
        "SELECT start_syl_id, end_syl_id, suggested_text, created_at "
        "FROM suggestions WHERE text_id=? AND status='applied'",
        (text_id,),
    )]

