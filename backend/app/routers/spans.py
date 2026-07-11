from fastapi import APIRouter, HTTPException
from typing import List

from ..db import get_db
from ..schemas import SpanOut, SpanCreate, SpanUpdate
from ..syllable_anchors import anchor_for_range, offsets_for_syls, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["spans"])


def _serialize_span(d: dict, id2start: dict, id2end: dict, inherited: bool = False):
    # Offsets are DERIVED from the syllable anchors (the stored offset columns were
    # dropped in Part 6, Phase 3) — a frontend render aid, not a stored anchor.
    # A span whose anchors no longer resolve (its content was baked away by
    # apply-corrections) is dangling: return None so list callers skip it instead of
    # rendering a bogus zero-offset span.
    start = id2start.get(d.get("start_syl_id"))
    end = id2end.get(d.get("end_syl_id"))
    if start is None or end is None:
        return None
    return {
        "id": d["id"],
        "text_id": d["text_id"],
        "tag_id": d["tag_id"],
        "start_offset": start,
        "end_offset": end,
        "start_syl_id": d.get("start_syl_id"),
        "end_syl_id": d.get("end_syl_id"),
        "inherited": inherited,
        "tag": {
            "id": d["tag_id"],
            "text_id": d["text_id"],
            "name": d["tag_name"],
            "color": d["tag_color"],
            "tag_kind": d["tag_kind"],
        },
    }


def _span_source_texts(cursor, text_id: int, _seen=None) -> list[int]:
    """Every text whose spans can resolve on this text's composed stream: the parent
    chain plus transclusion sources, recursively (a grandparent's transcluded source
    flows through too). Cycle-guarded; self excluded; stable order."""
    _seen = set() if _seen is None else _seen
    if text_id in _seen:
        return []
    _seen.add(text_id)
    out: list[int] = []
    row = cursor.execute(
        "SELECT parent_text_id FROM texts WHERE id = ?", (text_id,)).fetchone()
    if row and row["parent_text_id"] and row["parent_text_id"] not in _seen:
        out.append(row["parent_text_id"])
        out.extend(_span_source_texts(cursor, row["parent_text_id"], _seen))
    for r in cursor.execute(
            "SELECT DISTINCT src_text_id FROM derivation_ops "
            "WHERE text_id = ? AND op_kind = 'transclude' AND src_text_id IS NOT NULL "
            "ORDER BY src_text_id", (text_id,)).fetchall():
        src = r["src_text_id"]
        if src not in _seen:
            out.append(src)
            out.extend(_span_source_texts(cursor, src, _seen))
    return out


@router.get("/texts/{text_id}/spans", response_model=List[SpanOut])
def list_spans(text_id: int):
    conn = get_db()
    cursor = conn.cursor()

    # Offset "spaces": a primary has one (its own syllables). A secondary has the HOST
    # space (parent-link + hosted tokens) plus ONE SPACE PER TRANSCLUDE OP — the same
    # source transcluded twice repeats the same uuids at two stream positions, so a
    # span on that source must serialize once PER OCCURRENCE (a single last-wins map
    # would paint only the last run). A span row is emitted for every space in which
    # both its anchors resolve.
    row = cursor.execute(
        "SELECT text_type FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    is_secondary = bool(row and row["text_type"] == "secondary")
    if is_secondary:
        from ..derivation import compose_secondary
        host_maps = ({}, {})
        op_maps: dict = {}
        for t in compose_secondary(conn, text_id):
            maps = op_maps.setdefault(t["op_id"], ({}, {})) \
                if t["source"] == "transclusion" else host_maps
            maps[0][t["id"]] = t["start_offset"]
            maps[1][t["id"]] = t["end_offset"]
        spaces = [host_maps] + [op_maps[k] for k in sorted(op_maps)]
    else:
        spaces = [_syl_offset_maps(conn, text_id)]

    def emit(d: dict, inherited: bool) -> list:
        out = []
        for id2start, id2end in spaces:
            s = _serialize_span(d, id2start, id2end, inherited=inherited)
            if s is not None:
                out.append(s)
        return out

    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.text_id = ?
        """,
        (text_id,),
    )
    results = [s for r in cursor.fetchall() for s in emit(dict(r), False)]

    # Derived/transcluded content INHERITS its origins' tags LIVE: union in the spans
    # of every text in this text's compose graph — the parent chain (parent-link tokens
    # keep parent uuids) and all transclusion sources, recursively — keeping those
    # whose anchors resolve in THIS text's composed anchor space(s). Serialized with
    # host offsets per occurrence and marked read-only `inherited`; a tag edit at the
    # source is mirrored here on the next read, no copies.
    if is_secondary:
        src_ids = _span_source_texts(cursor, text_id)
        seen = {(s["tag_id"], s["start_syl_id"], s["end_syl_id"]) for s in results}
        for src in src_ids:
            cursor.execute(
                """
                SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
                FROM spans s JOIN tags t ON s.tag_id = t.id
                WHERE s.text_id = ?
                """,
                (src,),
            )
            for r in cursor.fetchall():
                d = dict(r)
                if (d["tag_id"], d["start_syl_id"], d["end_syl_id"]) in seen:
                    continue  # host already carries an identical span
                results.extend(emit(d, True))

    conn.close()
    # Order by derived start offset (was ORDER BY s.start_offset).
    results.sort(key=lambda s: s["start_offset"])
    return results


@router.post("/texts/{text_id}/spans", response_model=SpanOut)
def create_span(text_id: int, span: SpanCreate):
    """Create a span (an inline annotation). Spans may freely overlap any
    range — overlap and uniqueness are not enforced."""
    conn = get_db()
    cursor = conn.cursor()

    # Validate text exists.
    cursor.execute("SELECT id FROM texts WHERE id = ?", (text_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    # Part 6: annotations are anchored by syllable UUID. When the client sends syllable
    # ids (preferred), validate they exist in this text. The legacy offset path maps the
    # offset back to a syllable via the *syllables* table (no second tokenisation); an
    # off-grid offset that doesn't land on a syllable boundary is rejected.
    if span.start_syl_id is not None:
        try:
            offsets_for_syls(conn, text_id, span.start_syl_id, span.end_syl_id)
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))
        start_syl_id, end_syl_id = span.start_syl_id, span.end_syl_id
    else:
        if span.start_offset is None or span.end_offset is None:
            conn.close()
            raise HTTPException(400, "Span requires start_syl_id/end_syl_id (or legacy offsets)")
        start_syl_id, end_syl_id = anchor_for_range(
            conn, text_id, span.start_offset, span.end_offset
        )
        if start_syl_id is None or end_syl_id is None:
            conn.close()
            raise HTTPException(400, "Span offsets do not align with syllable boundaries")

    # Validate tag belongs to this text (or is a shared, NULL-owner tag — Part 8) and is
    # a regular tag. Session tags don't use spans — they use their own open/close positions.
    cursor.execute("SELECT text_id, tag_kind FROM tags WHERE id = ?", (span.tag_id,))
    tag_row = cursor.fetchone()
    if not tag_row:
        conn.close()
        raise HTTPException(404, "Tag not found")
    if tag_row["text_id"] is not None and tag_row["text_id"] != text_id:
        conn.close()
        raise HTTPException(400, "Tag belongs to a different text")
    if tag_row["tag_kind"] != 'regular':
        conn.close()
        raise HTTPException(400, "Spans can only be created for regular tags")

    # Part 6, Phase 3: store only the syllable-UUID anchors (offsets are derived on read).
    cursor.execute(
        "INSERT INTO spans (text_id, tag_id, start_syl_id, end_syl_id) VALUES (?, ?, ?, ?)",
        (text_id, span.tag_id, start_syl_id, end_syl_id),
    )
    span_id = cursor.lastrowid
    conn.commit()

    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    id2start, id2end = _syl_offset_maps(conn, text_id)
    span_dict = _serialize_span(dict(cursor.fetchone()), id2start, id2end)
    conn.close()
    if span_dict is None:  # unreachable: anchors were validated above
        raise HTTPException(409, "Span anchors do not resolve in this text")
    return span_dict


@router.patch("/spans/{span_id}", response_model=SpanOut)
def update_span(span_id: int, payload: SpanUpdate):
    """Update a span. Currently only `tag_id` may change."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Span not found")

    provided = payload.model_dump(exclude_unset=True)

    if "tag_id" in provided and payload.tag_id is not None and payload.tag_id != existing["tag_id"]:
        cursor.execute(
            "SELECT id, text_id, tag_kind FROM tags WHERE id = ?",
            (payload.tag_id,),
        )
        new_tag = cursor.fetchone()
        if not new_tag:
            conn.close()
            raise HTTPException(404, "Tag not found")
        if new_tag["text_id"] is not None and new_tag["text_id"] != existing["text_id"]:
            conn.close()
            raise HTTPException(400, "Tag belongs to a different text")
        if new_tag["tag_kind"] != 'regular':
            conn.close()
            raise HTTPException(400, "Spans can only point to regular tags")
        cursor.execute(
            "UPDATE spans SET tag_id = ? WHERE id = ?",
            (payload.tag_id, span_id),
        )
        conn.commit()

    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    row = dict(cursor.fetchone())
    id2start, id2end = _syl_offset_maps(conn, row["text_id"])
    span_dict = _serialize_span(row, id2start, id2end)
    conn.close()
    if span_dict is None:  # span's content was baked away — it no longer renders
        raise HTTPException(409, "Span anchors no longer resolve in this text")
    return span_dict


@router.delete("/spans/{span_id}")
def delete_span(span_id: int):
    """Delete a span. Spans no longer participate in tree-node linking, so
    deletion is unconditional — referencing tree nodes no longer exist."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM spans WHERE id = ?", (span_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Span not found")

    cursor.execute("DELETE FROM spans WHERE id = ?", (span_id,))
    conn.commit()
    conn.close()
    return {"status": "ok"}
