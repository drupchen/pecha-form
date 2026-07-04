from fastapi import APIRouter, HTTPException
from typing import List

from ..db import get_db
from ..manifest import load_syllables, syllable_ids_between
from ..schemas import PassageCreate, PassageUpdate, PassageOut

router = APIRouter(prefix="/api", tags=["passages"])


def _resolve_members(conn, text_id: int, passage_id: int) -> list[dict]:
    """Resolve a passage's member runs into ordered syllable link dicts. Each member
    is a contiguous run of existing syllables in the same text (links, by uuid)."""
    syls = load_syllables(conn, text_id)
    by_id = {s["id"]: s for s in syls}
    members = conn.execute(
        "SELECT position, src_start_syl_id, src_end_syl_id FROM passage_members "
        "WHERE passage_id = ? ORDER BY position",
        (passage_id,),
    ).fetchall()
    out = []
    for m in members:
        ids = syllable_ids_between(syls, m["src_start_syl_id"], m["src_end_syl_id"])
        out.append({
            "position": m["position"],
            "src_start_syl_id": m["src_start_syl_id"],
            "src_end_syl_id": m["src_end_syl_id"],
            "syllables": [
                {"syl_id": sid, "idx": by_id[sid]["idx"],
                 "text": by_id[sid]["text"], "nature": by_id[sid]["nature"]}
                for sid in ids if sid in by_id
            ],
        })
    return out


def _passage_out(conn, row) -> dict:
    return {**dict(row), "members": _resolve_members(conn, row["text_id"], row["id"])}


def _validate_members(conn, text_id: int, members) -> None:
    """Each member's endpoints must be real syllables of this text and non-reversed."""
    syls = load_syllables(conn, text_id)
    for m in members:
        if not syllable_ids_between(syls, m.src_start_syl_id, m.src_end_syl_id):
            raise HTTPException(
                400, "Passage member endpoints must be syllables of this text, in order")


def _validate_downstream_anchor(conn, text_id: int, anchor_syl_id, members) -> None:
    """A passage is always placed *downstream* of its source: the anchor syllable (where
    the passage renders) must come after the last syllable of every member run. A NULL
    anchor means "at the end of the text", which is trivially downstream."""
    if anchor_syl_id is None:
        return
    syls = load_syllables(conn, text_id)
    pos = {s["id"]: i for i, s in enumerate(syls)}
    anchor_i = pos.get(anchor_syl_id)
    if anchor_i is None:
        raise HTTPException(400, "Passage anchor must be a syllable of this text")
    for m in members:
        end_i = pos.get(m.src_end_syl_id)
        if end_i is not None and anchor_i <= end_i:
            raise HTTPException(
                400, "Passage must be placed downstream of the selected source range")


@router.get("/texts/{text_id}/passages", response_model=List[PassageOut])
def list_passages(text_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM passages WHERE text_id = ? ORDER BY position, id", (text_id,)
    ).fetchall()
    out = [_passage_out(conn, r) for r in rows]
    conn.close()
    return out


@router.post("/texts/{text_id}/passages", response_model=PassageOut)
def create_passage(text_id: int, payload: PassageCreate):
    conn = get_db()
    if not conn.execute("SELECT 1 FROM texts WHERE id = ?", (text_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")
    _validate_members(conn, text_id, payload.members)
    _validate_downstream_anchor(conn, text_id, payload.anchor_syl_id, payload.members)
    cur = conn.execute(
        "INSERT INTO passages (text_id, anchor_syl_id, position, color) VALUES (?, ?, ?, ?)",
        (text_id, payload.anchor_syl_id, payload.position, payload.color),
    )
    pid = cur.lastrowid
    for i, m in enumerate(payload.members):
        conn.execute(
            "INSERT INTO passage_members (passage_id, position, src_start_syl_id, "
            "src_end_syl_id) VALUES (?, ?, ?, ?)",
            (pid, i, m.src_start_syl_id, m.src_end_syl_id),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM passages WHERE id = ?", (pid,)).fetchone()
    out = _passage_out(conn, row)
    conn.close()
    return out


@router.patch("/passages/{passage_id}", response_model=PassageOut)
def update_passage(passage_id: int, payload: PassageUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM passages WHERE id = ?", (passage_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Passage not found")
    text_id = row["text_id"]
    sets, args = [], []
    if payload.anchor_syl_id is not None or "anchor_syl_id" in payload.model_fields_set:
        sets.append("anchor_syl_id = ?"); args.append(payload.anchor_syl_id)
    if payload.position is not None:
        sets.append("position = ?"); args.append(payload.position)
    if payload.color is not None or "color" in payload.model_fields_set:
        sets.append("color = ?"); args.append(payload.color)
    if sets:
        conn.execute(f"UPDATE passages SET {', '.join(sets)} WHERE id = ?", (*args, passage_id))
    if payload.members is not None:
        _validate_members(conn, text_id, payload.members)
        conn.execute("DELETE FROM passage_members WHERE passage_id = ?", (passage_id,))
        for i, m in enumerate(payload.members):
            conn.execute(
                "INSERT INTO passage_members (passage_id, position, src_start_syl_id, "
                "src_end_syl_id) VALUES (?, ?, ?, ?)",
                (passage_id, i, m.src_start_syl_id, m.src_end_syl_id),
            )
    conn.commit()
    row = conn.execute("SELECT * FROM passages WHERE id = ?", (passage_id,)).fetchone()
    out = _passage_out(conn, row)
    conn.close()
    return out


@router.delete("/passages/{passage_id}")
def delete_passage(passage_id: int):
    conn = get_db()
    cur = conn.execute("DELETE FROM passages WHERE id = ?", (passage_id,))
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Passage not found")
    return {"status": "ok"}
