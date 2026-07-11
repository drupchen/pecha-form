from fastapi import APIRouter, HTTPException
from typing import List

from ..db import get_db
from ..manifest import syllable_ids_between
from ..derivation import base_tokens
from ..schemas import PassageCreate, PassageUpdate, PassageOut, PassageSplitIn, PassageSplitOut

router = APIRouter(prefix="/api", tags=["passages"])

# Passages resolve over the text's TOKEN SEQUENCE (base_tokens): a primary's own
# syllables — identical to before — or a secondary's composed sequence, so passages
# work on derived texts whose tokens are parent-links.


def _resolve_members(conn, text_id: int, passage_id: int) -> list[dict]:
    """Resolve a passage's member runs into ordered syllable link dicts. Each member
    is a contiguous run of existing tokens in the same text (links, by uuid)."""
    syls = base_tokens(conn, text_id)
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
    d = dict(row)
    d["attach_prev"] = bool(d.get("attach_prev", 0))
    d["own_segment"] = bool(d.get("own_segment", 0))
    return {**d, "members": _resolve_members(conn, row["text_id"], row["id"])}


def _validate_members(conn, text_id: int, members) -> None:
    """Each member's endpoints must be real tokens of this text and non-reversed."""
    syls = base_tokens(conn, text_id)
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
    syls = base_tokens(conn, text_id)
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
        "INSERT INTO passages (text_id, anchor_syl_id, position, color, attach_prev) "
        "VALUES (?, ?, ?, ?, ?)",
        (text_id, payload.anchor_syl_id, payload.position, payload.color,
         int(payload.attach_prev)),
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
    if payload.own_segment is not None:
        sets.append("own_segment = ?"); args.append(int(payload.own_segment))
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


@router.post("/passages/{passage_id}/split", response_model=PassageSplitOut)
def split_passage(passage_id: int, payload: PassageSplitIn):
    """Divide a passage in two after a syllable strictly interior to its flattened run —
    passages split exactly like ordinary text. The second half becomes a new passage
    ordered right after the original (same anchor); per-occurrence notes whose anchors
    fall in the second half move with it."""
    conn = get_db()
    row = conn.execute("SELECT * FROM passages WHERE id = ?", (passage_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Passage not found")
    text_id = row["text_id"]
    syls = base_tokens(conn, text_id)
    members = conn.execute(
        "SELECT position, src_start_syl_id, src_end_syl_id FROM passage_members "
        "WHERE passage_id = ? ORDER BY position",
        (passage_id,),
    ).fetchall()
    runs = [syllable_ids_between(syls, m["src_start_syl_id"], m["src_end_syl_id"])
            for m in members]
    flat = [sid for run in runs for sid in run]
    if payload.after_syl_id not in flat:
        conn.close()
        raise HTTPException(400, "Split point is not a syllable of this passage")
    i = flat.index(payload.after_syl_id)
    if i >= len(flat) - 1:
        conn.close()
        raise HTTPException(400, "Split point must be strictly inside the passage")

    # Partition the member runs at the split point; the run containing it is divided.
    first_members: list[tuple[str, str]] = []
    second_members: list[tuple[str, str]] = []
    consumed = 0
    for run in runs:
        run_end = consumed + len(run) - 1
        if run_end <= i:
            first_members.append((run[0], run[-1]))
        elif consumed > i:
            second_members.append((run[0], run[-1]))
        else:
            k = i - consumed
            first_members.append((run[0], run[k]))
            second_members.append((run[k + 1], run[-1]))
        consumed += len(run)

    first_ap = bool(row["attach_prev"]) if payload.first_attach_prev is None \
        else payload.first_attach_prev
    second_ap = bool(row["attach_prev"]) if payload.second_attach_prev is None \
        else payload.second_attach_prev

    conn.execute("DELETE FROM passage_members WHERE passage_id = ?", (passage_id,))
    for j, (s, e) in enumerate(first_members):
        conn.execute(
            "INSERT INTO passage_members (passage_id, position, src_start_syl_id, "
            "src_end_syl_id) VALUES (?, ?, ?, ?)", (passage_id, j, s, e))
    conn.execute("UPDATE passages SET attach_prev = ? WHERE id = ?",
                 (int(first_ap), passage_id))

    cur = conn.execute(
        "INSERT INTO passages (text_id, anchor_syl_id, position, color, attach_prev, "
        "own_segment) VALUES (?, ?, ?, ?, ?, ?)",
        (text_id, row["anchor_syl_id"], row["position"], row["color"], int(second_ap),
         int(payload.second_own_segment)))
    new_id = cur.lastrowid
    for j, (s, e) in enumerate(second_members):
        conn.execute(
            "INSERT INTO passage_members (passage_id, position, src_start_syl_id, "
            "src_end_syl_id) VALUES (?, ?, ?, ?)", (new_id, j, s, e))

    # Renumber same-anchor siblings deterministically with the new passage right after
    # the original (fresh passages may share position values; order is (position, id)).
    if row["anchor_syl_id"] is None:
        sibs = conn.execute(
            "SELECT id FROM passages WHERE text_id = ? AND anchor_syl_id IS NULL "
            "AND id != ? ORDER BY position, id", (text_id, new_id)).fetchall()
    else:
        sibs = conn.execute(
            "SELECT id FROM passages WHERE text_id = ? AND anchor_syl_id = ? "
            "AND id != ? ORDER BY position, id",
            (text_id, row["anchor_syl_id"], new_id)).fetchall()
    order = [s["id"] for s in sibs]
    order.insert(order.index(passage_id) + 1, new_id)
    for pos, pid in enumerate(order):
        conn.execute("UPDATE passages SET position = ? WHERE id = ?", (pos, pid))

    # Per-occurrence notes anchored in the second half travel with it.
    second_ids = set(flat[i + 1:])
    for n in conn.execute(
            "SELECT id, start_syl_id FROM notes WHERE passage_id = ?",
            (passage_id,)).fetchall():
        if n["start_syl_id"] in second_ids:
            conn.execute("UPDATE notes SET passage_id = ? WHERE id = ?",
                         (new_id, n["id"]))

    conn.commit()
    first_row = conn.execute("SELECT * FROM passages WHERE id = ?", (passage_id,)).fetchone()
    second_row = conn.execute("SELECT * FROM passages WHERE id = ?", (new_id,)).fetchone()
    out = {"first": _passage_out(conn, first_row), "second": _passage_out(conn, second_row)}
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
