from fastapi import APIRouter, Body, HTTPException
from typing import List

from ..db import get_db
from ..schemas import (
    SuggestionOut, SuggestionCreate,
    SuggestUpstreamIn, SuggestUpstreamOut, SuggestionAcceptIn,
)
from ..syllable_anchors import anchor_for_range, offsets_for_syls, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["suggestions"])


def _marker_positions(conn, text_id, id2start, total_len):
    """Marker positions (segment boundaries) DERIVED from their syllable anchors."""
    out = []
    for r in conn.execute("SELECT syl_id FROM markers WHERE text_id = ?", (text_id,)):
        syl = r["syl_id"]
        out.append(total_len if syl is None else id2start.get(syl, total_len))
    return out


def _existing_suggestions(conn, text_id, id2start, id2end):
    """(id, start_offset, end_offset) for existing APPLIED suggestions, offsets DERIVED
    from their syllable anchors (a zero-width insertion has end == start). Pending rows
    (incoming upstream, awaiting review) don't block others — competing pending
    suggestions are allowed; conflicts are re-validated at accept time."""
    out = []
    for r in conn.execute(
        "SELECT id, start_syl_id, end_syl_id FROM suggestions "
        "WHERE text_id = ? AND status = 'applied'",
        (text_id,),
    ):
        s = id2start.get(r["start_syl_id"])
        if s is None:
            continue
        e = s if r["end_syl_id"] is None else id2end.get(r["end_syl_id"], s)
        out.append((r["id"], s, e))
    return out


def _validate_no_boundary_straddle(
    marker_positions, start: int, end: int, suggested_text: str = "x"
) -> None:
    """Reject suggestions that cross a segment boundary (marker position).

    Pure insertions exactly on a boundary are allowed. A pure deletion
    (``suggested_text == ""``) is also allowed to span markers: "delete a section"
    may cover several segments — only the text is removed, the markers themselves are
    untouched. Replacements still must lie within a single segment.
    """
    if start == end or suggested_text == "":
        return  # insertion or pure deletion — boundary OK
    for pos in marker_positions:
        if start < pos < end:
            raise HTTPException(400, "Suggestion must lie within a single segment")


def _check_overlap(existing, start: int, end: int, exclude_id: int | None = None) -> None:
    """Reject a new suggestion that genuinely conflicts with an existing one.

    Matches the applier's contract (``suggestion_applier.splice_suggestions``): a
    zero-width insertion *at the boundary* of a region is fine (it applies just before
    or just after the region), so only a strict conflict is rejected — an insertion
    whose point is strictly *inside* a positive-width edit ``(s, e)``, or coincident
    with another insertion. Symmetrically, a positive-width edit is rejected when it
    overlaps another region or closes strictly over an existing insertion point.
    Offsets are derived from syllable anchors.
    """
    for sid, s, e in existing:
        if exclude_id is not None and sid == exclude_id:
            continue
        if start == end:  # insertion
            coincident = (s == e == start)  # another insertion at the same point
            inside_region = (e > s and s < start < e)  # strictly inside a region
            if coincident or inside_region:
                raise HTTPException(409, "Overlaps with an existing suggestion")
        else:  # replacement / deletion
            region_overlap = (e > s and s < end and e > start)
            splits_insertion = (s == e and start < s < end)  # insertion strictly inside
            if region_overlap or splits_insertion:
                raise HTTPException(409, "Overlaps with an existing suggestion")


# ─── Endpoints ────────────────────────────────────────────────────────────────

def _serialize_suggestion(d: dict, id2start: dict, id2end: dict) -> dict:
    # Offsets derived from the syllable anchors (stored columns dropped in Phase 3).
    start = id2start.get(d.get("start_syl_id"), 0)
    end = start if d.get("end_syl_id") is None else id2end.get(d.get("end_syl_id"), start)
    d["start_offset"] = start
    d["end_offset"] = end
    return d


@router.get("/texts/{text_id}/suggestions", response_model=List[SuggestionOut])
def list_suggestions(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT s.*, o.title AS origin_title FROM suggestions s "
        "LEFT JOIN texts o ON o.id = s.origin_text_id WHERE s.text_id = ?",
        (text_id,),
    )
    rows = [dict(r) for r in cursor.fetchall()]
    id2start, id2end = _syl_offset_maps(conn, text_id)
    conn.close()
    rows = [_serialize_suggestion(r, id2start, id2end) for r in rows]
    rows.sort(key=lambda r: (r["start_offset"], r.get("created_at") or ""))
    return rows


@router.post("/texts/{text_id}/suggestions", response_model=SuggestionOut)
def create_suggestion(text_id: int, payload: SuggestionCreate):
    conn = get_db()
    cursor = conn.cursor()

    row = cursor.execute("SELECT id, text_type FROM texts WHERE id = ?", (text_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Text not found")
    if row["text_type"] == "secondary":
        conn.close()
        # A secondary's edits are derivation ops over its parent chain (edit-range),
        # not staged suggestions — suggestions only exist on primaries, where they can
        # be baked into the base and ripple to descendants.
        raise HTTPException(400, "Secondary texts are edited via derivation ops, not suggestions")

    id2start, id2end = _syl_offset_maps(conn, text_id)
    total_len = max(id2end.values(), default=0)

    # Part 6: annotations are anchored by syllable UUID. The syllable path (preferred)
    # validates existence; the legacy offset path maps the offset back to a syllable via
    # the syllables table (off-grid offsets are rejected). end_syl_id=None = insertion.
    if payload.start_syl_id is not None:
        try:
            start_offset, end_offset = offsets_for_syls(
                conn, text_id, payload.start_syl_id, payload.end_syl_id
            )
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))
        start_syl_id, end_syl_id = payload.start_syl_id, payload.end_syl_id
    else:
        if payload.start_offset is None or payload.end_offset is None:
            conn.close()
            raise HTTPException(400, "start_syl_id or start_offset/end_offset required")
        if payload.start_offset > payload.end_offset:
            conn.close()
            raise HTTPException(400, "start_offset must be <= end_offset")
        start_syl_id, end_syl_id = anchor_for_range(
            conn, text_id, payload.start_offset, payload.end_offset
        )
        if start_syl_id is None:
            conn.close()
            raise HTTPException(400, "Suggestion offset must align with a syllable boundary")
        start_offset, end_offset = offsets_for_syls(conn, text_id, start_syl_id, end_syl_id)

    try:
        _validate_no_boundary_straddle(
            _marker_positions(conn, text_id, id2start, total_len),
            start_offset, end_offset, payload.suggested_text,
        )
        _check_overlap(
            _existing_suggestions(conn, text_id, id2start, id2end),
            start_offset, end_offset,
        )
    except HTTPException:
        conn.close()
        raise

    # Part 6, Phase 3: store only the syllable anchors (offsets derived on read).
    cursor.execute(
        "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id) "
        "VALUES (?, ?, ?, ?)",
        (text_id, payload.suggested_text, start_syl_id, end_syl_id),
    )
    new_id = cursor.lastrowid
    conn.commit()
    cursor.execute("SELECT * FROM suggestions WHERE id = ?", (new_id,))
    row = _serialize_suggestion(dict(cursor.fetchone()), id2start, id2end)
    conn.close()
    return row


@router.post("/texts/{text_id}/suggest-upstream", response_model=SuggestUpstreamOut)
def suggest_upstream(text_id: int, payload: SuggestUpstreamIn):
    """Route a correction proposed on a DERIVED text to the text where the selected
    syllables first appear (their owner), as a PENDING suggestion awaiting review there.

    The composed token ids ARE the owner's syllable uuids, so the anchors transfer
    as-is — this is the backward-propagation hook (translations will reuse it later).
    Local edits stay the default; this endpoint is the explicit, sporadic upstream path."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text_type FROM texts WHERE id = ?", (text_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Text not found")
        if row["text_type"] != "secondary":
            raise HTTPException(400, "Upstream suggestions are made from a derived text")

        # Resolve the selected run over THIS text's composed sequence.
        from ..derivation import compose_secondary
        from ..manifest import syllable_ids_between
        toks = compose_secondary(conn, text_id)
        if payload.end_syl_id is not None:
            run = syllable_ids_between(toks, payload.start_syl_id, payload.end_syl_id)
        else:
            run = [payload.start_syl_id] if any(t["id"] == payload.start_syl_id for t in toks) else []
        if not run:
            raise HTTPException(400, "Selection endpoints must be tokens of this text, in order")

        # The level where these syllables first appear = the owning text of their rows.
        owners = set()
        for sid in run:
            for r in conn.execute("SELECT text_id FROM syllables WHERE id = ?", (sid,)):
                owners.add(r["text_id"])
        if len(owners) != 1:
            raise HTTPException(
                400, "Selection spans content from multiple sources — suggest smaller runs")
        owner = owners.pop()
        if owner == text_id:
            raise HTTPException(
                400, "This content originates in this text — edit it locally instead")

        # Validate against the OWNER: anchors must resolve there, and the proposal must
        # not conflict with the owner's applied corrections (competing pendings are OK).
        id2start, id2end = _syl_offset_maps(conn, owner)
        if payload.start_syl_id not in id2start or (
            payload.end_syl_id is not None and payload.end_syl_id not in id2end
        ):
            raise HTTPException(409, "The selected content no longer exists in the source text")
        start_off = id2start[payload.start_syl_id]
        end_off = start_off if payload.end_syl_id is None else id2end[payload.end_syl_id]
        _check_overlap(_existing_suggestions(conn, owner, id2start, id2end), start_off, end_off)

        cur = conn.execute(
            "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id, "
            "status, origin_text_id) VALUES (?, ?, ?, ?, 'pending', ?)",
            (owner, payload.suggested_text, payload.start_syl_id, payload.end_syl_id, text_id),
        )
        conn.commit()
        title = conn.execute("SELECT title FROM texts WHERE id = ?", (owner,)).fetchone()["title"]
        return {"suggestion_id": cur.lastrowid, "routed_to_text_id": owner,
                "routed_to_title": title}
    finally:
        conn.close()


@router.post("/suggestions/{suggestion_id}/accept", response_model=dict)
def accept_suggestion(suggestion_id: int,
                      payload: SuggestionAcceptIn = Body(default=SuggestionAcceptIn())):
    """Accept an incoming (pending) suggestion at the level where the syllable first
    appears. Primary owner: 'stage' joins the staged corrections (ripples at the next
    Apply-all); 'ripple' bakes just this suggestion into the base now (uuid-stable, so
    every derived text updates immediately and other staged corrections are untouched).
    Secondary owner: applied natively as an edit op (ops compose live → ripples now)."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM suggestions WHERE id = ?", (suggestion_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Suggestion not found")
        if row["status"] != "pending":
            raise HTTPException(400, "Only a pending suggestion can be accepted")
        owner = row["text_id"]
        owner_row = conn.execute(
            "SELECT text_type FROM texts WHERE id = ?", (owner,)
        ).fetchone()

        if owner_row["text_type"] == "secondary":
            # The syllables first appear at an intermediate level: apply in that level's
            # native mechanism (an edit op). A pure insertion prepends to the anchor token.
            from ..derivation import edit_range
            new_text = row["suggested_text"]
            end_syl = row["end_syl_id"]
            if end_syl is None:  # zero-width insertion before start_syl_id
                anchor = conn.execute(
                    "SELECT text FROM syllables WHERE text_id = ? AND id = ?",
                    (owner, row["start_syl_id"]),
                ).fetchone()
                new_text = new_text + (anchor["text"] if anchor else "")
                end_syl = row["start_syl_id"]
            edit_range(conn, owner, row["start_syl_id"], end_syl, new_text)
            conn.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
            conn.commit()
            return {"status": "applied-as-op", "text_id": owner}

        # Primary owner: re-validate anchors, segment boundaries and overlap now (the
        # base may have changed since the suggestion arrived).
        id2start, id2end = _syl_offset_maps(conn, owner)
        total_len = max(id2end.values(), default=0)
        if row["start_syl_id"] not in id2start or (
            row["end_syl_id"] is not None and row["end_syl_id"] not in id2end
        ):
            raise HTTPException(409, "The suggested range no longer exists in this text")
        start_off = id2start[row["start_syl_id"]]
        end_off = start_off if row["end_syl_id"] is None else id2end[row["end_syl_id"]]
        _validate_no_boundary_straddle(
            _marker_positions(conn, owner, id2start, total_len),
            start_off, end_off, row["suggested_text"],
        )
        _check_overlap(_existing_suggestions(conn, owner, id2start, id2end),
                       start_off, end_off, exclude_id=suggestion_id)

        if payload.mode == "ripple":
            from .texts import _apply_one_suggestion_core
            _apply_one_suggestion_core(conn, suggestion_id)
            conn.commit()
            return {"status": "baked", "text_id": owner}
        conn.execute(
            "UPDATE suggestions SET status = 'applied' WHERE id = ?", (suggestion_id,))
        conn.commit()
        return {"status": "staged", "text_id": owner}
    finally:
        conn.close()


@router.delete("/suggestions/{suggestion_id}")
def delete_suggestion(suggestion_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Suggestion not found")
    return {"status": "ok"}
