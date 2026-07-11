from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
import sqlite3

from ..db import get_db
from ..schemas import (
    TreeNodeOut, TreeNodeCreate, TreeNodeUpdate, TreeNodeMove, TreeNodeReorder
)
from ..syllable_anchors import anchor_for_point, offset_for_syl_start, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["tree_nodes"])


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_node(row: sqlite3.Row, id2start: dict) -> dict:
    d = dict(row)
    d["transparent"] = bool(d["transparent"])
    # Part 6, Phase 3: segment_start is DERIVED from the syllable anchor (the stored
    # segment_start offset column was dropped) — a frontend render aid.
    syl = d.get("segment_start_syl_id")
    d["segment_start"] = id2start.get(syl) if syl is not None else None
    return d


def _validate_parent(cursor, text_id: int, parent_id: Optional[int]) -> None:
    if parent_id is None:
        return
    cursor.execute(
        "SELECT id FROM tree_nodes WHERE id = ? AND text_id = ?",
        (parent_id, text_id),
    )
    if not cursor.fetchone():
        raise HTTPException(404, f"Parent tree node {parent_id} not found in this text")


def _validate_segment_start(cursor, text_id: int, segment_start: Optional[int]) -> None:
    """`segment_start` is a raw_text offset. It must be in [0, len(raw_text)].
    We do NOT require it to match a current marker position — markers can move,
    and an unmatched offset just means the link is orphaned (handled by the UI)."""
    if segment_start is None:
        return
    if segment_start < 0:
        raise HTTPException(400, "segment_start must be >= 0")
    cursor.execute("SELECT raw_text FROM texts WHERE id = ?", (text_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(404, "Text not found")
    if segment_start > len(row["raw_text"]):
        raise HTTPException(400, "segment_start exceeds text length")


def _max_sibling_position(cursor, parent_id: Optional[int], text_id: int) -> int:
    """Return the next free position among siblings of `parent_id` in this text."""
    if parent_id is None:
        cursor.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos "
            "FROM tree_nodes WHERE parent_id IS NULL AND text_id = ?",
            (text_id,),
        )
    else:
        cursor.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos "
            "FROM tree_nodes WHERE parent_id = ?",
            (parent_id,),
        )
    return cursor.fetchone()["next_pos"]


def _sibling_count(cursor, parent_id: Optional[int], text_id: int) -> int:
    if parent_id is None:
        cursor.execute(
            "SELECT COUNT(*) AS c FROM tree_nodes WHERE parent_id IS NULL AND text_id = ?",
            (text_id,),
        )
    else:
        cursor.execute(
            "SELECT COUNT(*) AS c FROM tree_nodes WHERE parent_id = ?",
            (parent_id,),
        )
    return cursor.fetchone()["c"]


def _is_descendant(cursor, ancestor_id: int, candidate_id: int) -> bool:
    """Return True if `candidate_id` is `ancestor_id` itself or any descendant."""
    if ancestor_id == candidate_id:
        return True
    cursor.execute(
        """
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM tree_nodes WHERE parent_id = ?
            UNION ALL
            SELECT t.id FROM tree_nodes t JOIN descendants d ON t.parent_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = ?
        """,
        (ancestor_id, candidate_id),
    )
    return cursor.fetchone() is not None


def _shift_siblings(
    cursor, parent_id: Optional[int], text_id: int,
    from_pos: int, delta: int,
) -> None:
    """Shift `position` by `delta` for siblings with position >= from_pos.

    Uses a two-step shift via a high offset to dodge the UNIQUE(parent_id, position) constraint.
    """
    HIGH = 1_000_000  # safe scratch space well above realistic sibling counts
    if parent_id is None:
        # Move into scratch space
        cursor.execute(
            "UPDATE tree_nodes SET position = position + ? "
            "WHERE parent_id IS NULL AND text_id = ? AND position >= ?",
            (HIGH, text_id, from_pos),
        )
        # Move back with the desired delta
        cursor.execute(
            "UPDATE tree_nodes SET position = position - ? + ? "
            "WHERE parent_id IS NULL AND text_id = ? AND position >= ?",
            (HIGH, delta, text_id, from_pos + HIGH),
        )
    else:
        cursor.execute(
            "UPDATE tree_nodes SET position = position + ? "
            "WHERE parent_id = ? AND position >= ?",
            (HIGH, parent_id, from_pos),
        )
        cursor.execute(
            "UPDATE tree_nodes SET position = position - ? + ? "
            "WHERE parent_id = ? AND position >= ?",
            (HIGH, delta, parent_id, from_pos + HIGH),
        )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/texts/{text_id}/tree-nodes", response_model=List[TreeNodeOut])
def list_tree_nodes(text_id: int):
    """Flat list of tree nodes for a text, sorted by parent_id, position."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM tree_nodes WHERE text_id = ? "
        "ORDER BY parent_id IS NULL DESC, parent_id ASC, position ASC",
        (text_id,),
    )
    id2start, _ = _syl_offset_maps(conn, text_id)
    rows = [_row_to_node(r, id2start) for r in cursor.fetchall()]
    conn.close()
    return rows


@router.get("/texts/{text_id}/tree-nodes/tree")
def get_nested_tree(text_id: int):
    """Convenience: nested tree shape for read-only consumption."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM tree_nodes WHERE text_id = ? ORDER BY parent_id, position",
        (text_id,),
    )
    id2start, _ = _syl_offset_maps(conn, text_id)
    rows = [_row_to_node(r, id2start) for r in cursor.fetchall()]
    conn.close()

    by_parent: dict[Optional[int], list[dict]] = {}
    for r in rows:
        by_parent.setdefault(r["parent_id"], []).append(r)

    def build(parent_id: Optional[int]) -> list[dict]:
        children = by_parent.get(parent_id, [])
        children.sort(key=lambda n: n["position"])
        return [{**n, "children": build(n["id"])} for n in children]

    return {"text_id": text_id, "roots": build(None)}


@router.post("/texts/{text_id}/tree-nodes", response_model=TreeNodeOut)
def create_tree_node(text_id: int, payload: TreeNodeCreate):
    conn = get_db()
    cursor = conn.cursor()

    # Validate text exists
    cursor.execute("SELECT id FROM texts WHERE id = ?", (text_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    # Part 6: a segment link is anchored by syllable UUID. Prefer the syllable id the
    # frontend linked (existence is the check); the legacy offset path maps the offset
    # back to a syllable start via the syllables table.
    from_syl = payload.segment_start_syl_id is not None
    seg_syl_id = None
    if from_syl:
        try:
            offset_for_syl_start(conn, text_id, payload.segment_start_syl_id)
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))
        seg_syl_id = payload.segment_start_syl_id

    try:
        _validate_parent(cursor, text_id, payload.parent_id)
        if not from_syl:
            _validate_segment_start(cursor, text_id, payload.segment_start)
    except HTTPException:
        conn.close()
        raise

    if not from_syl and payload.segment_start is not None:
        seg_syl_id = anchor_for_point(conn, text_id, payload.segment_start)
        if seg_syl_id is None:
            conn.close()
            raise HTTPException(400, "segment_start must fall on a syllable boundary")

    if payload.title is None and seg_syl_id is None:
        conn.close()
        raise HTTPException(400, "title or segment_start must be provided")

    if payload.position is None:
        position = _max_sibling_position(cursor, payload.parent_id, text_id)
    else:
        sib_count = _sibling_count(cursor, payload.parent_id, text_id)
        if payload.position < 0 or payload.position > sib_count:
            conn.close()
            raise HTTPException(400, f"position must be in [0, {sib_count}]")
        position = payload.position
        # Open slot at `position`
        _shift_siblings(cursor, payload.parent_id, text_id, position, +1)

    try:
        # Part 6, Phase 3: store only the syllable anchor (segment_start derived on read).
        cursor.execute(
            "INSERT INTO tree_nodes (text_id, parent_id, position, title, transparent, segment_start_syl_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                text_id, payload.parent_id, position, payload.title,
                int(payload.transparent), seg_syl_id,
            ),
        )
        new_id = cursor.lastrowid
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        conn.close()
        raise HTTPException(400, f"Integrity error: {e}")

    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (new_id,))
    id2start, _ = _syl_offset_maps(conn, text_id)
    row = _row_to_node(cursor.fetchone(), id2start)
    conn.close()
    return row


@router.patch("/tree-nodes/{node_id}", response_model=TreeNodeOut)
def update_tree_node(node_id: int, payload: TreeNodeUpdate):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (node_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Tree node not found")

    provided = payload.model_dump(exclude_unset=True)

    new_title = payload.title if payload.title is not None else existing["title"]
    new_transparent = (
        int(payload.transparent) if payload.transparent is not None
        else existing["transparent"]
    )

    # segment_start: only touch when the caller actually sent it (so existing
    # links aren't accidentally cleared by partial PATCHes). Multiple nodes
    # may now share the same segment_start — no uniqueness check. Part 6: a
    # segment_start_syl_id takes precedence and derives the offset from the
    # syllables table (existence check, no units_json).
    from_syl = "segment_start_syl_id" in provided and payload.segment_start_syl_id is not None
    new_seg_syl_id = existing["segment_start_syl_id"]
    new_passage_id = existing["passage_id"]
    if from_syl:
        try:
            offset_for_syl_start(conn, existing["text_id"], payload.segment_start_syl_id)
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))
        new_seg_syl_id = payload.segment_start_syl_id
        new_passage_id = None  # a node links a segment OR a passage, not both
    elif "segment_start" in provided:
        new_segment_start = payload.segment_start  # may be None to unlink
        if new_segment_start is not None:
            try:
                _validate_segment_start(cursor, existing["text_id"], new_segment_start)
            except HTTPException:
                conn.close()
                raise
            new_seg_syl_id = anchor_for_point(conn, existing["text_id"], new_segment_start)
            if new_seg_syl_id is None:
                conn.close()
                raise HTTPException(400, "segment_start must fall on a syllable boundary")
            new_passage_id = None
        else:
            new_seg_syl_id = None  # explicit unlink (also releases a passage link)
            new_passage_id = None

    # passage link: the sapche section IS that passage occurrence. Mutually exclusive
    # with the segment link — setting one clears the other.
    if "passage_id" in provided:
        if payload.passage_id is not None:
            ok = conn.execute(
                "SELECT 1 FROM passages WHERE id = ? AND text_id = ?",
                (payload.passage_id, existing["text_id"]),
            ).fetchone()
            if not ok:
                conn.close()
                raise HTTPException(404, "Passage not found in this text")
            new_passage_id = payload.passage_id
            new_seg_syl_id = None
        else:
            new_passage_id = None

    # CHECK constraint: at least one of title / segment_start_syl_id must be non-null
    # (a passage-linked node therefore needs a title — it has no host segment).
    if new_title is None and new_seg_syl_id is None:
        conn.close()
        raise HTTPException(400, "Cannot clear title on a free-form node")
    cursor.execute(
        "UPDATE tree_nodes SET title = ?, transparent = ?, "
        "segment_start_syl_id = ?, passage_id = ?, updated_at = CURRENT_TIMESTAMP "
        "WHERE id = ?",
        (new_title, new_transparent, new_seg_syl_id, new_passage_id, node_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (node_id,))
    id2start, _ = _syl_offset_maps(conn, existing["text_id"])
    row = _row_to_node(cursor.fetchone(), id2start)
    conn.close()
    return row


@router.patch("/tree-nodes/{node_id}/move", response_model=TreeNodeOut)
def move_tree_node(node_id: int, payload: TreeNodeMove):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (node_id,))
    node = cursor.fetchone()
    if not node:
        conn.close()
        raise HTTPException(404, "Tree node not found")

    text_id = node["text_id"]
    old_parent = node["parent_id"]
    old_position = node["position"]
    new_parent = payload.new_parent_id

    try:
        _validate_parent(cursor, text_id, new_parent)
    except HTTPException:
        conn.close()
        raise

    if new_parent is not None and _is_descendant(cursor, node_id, new_parent):
        conn.close()
        raise HTTPException(409, "Move would create a cycle")

    # Compute valid range for new_position.
    # When same-parent move, removing the node first reduces sibling count by 1.
    same_parent = old_parent == new_parent
    sib_count = _sibling_count(cursor, new_parent, text_id)
    upper = sib_count - 1 if same_parent else sib_count
    if payload.new_position < 0 or payload.new_position > upper:
        conn.close()
        raise HTTPException(400, f"new_position must be in [0, {upper}]")

    try:
        # Step 0: park the moving node at a scratch position OUTSIDE its
        # parent's normal range so the close-gap shift can't collide with it.
        # _shift_siblings uses HIGH=1e6 internally for its two-phase shuffle,
        # so we park at 2*HIGH to stay clear of that band.
        PARK = 2_000_000
        cursor.execute(
            "UPDATE tree_nodes SET position = ? WHERE id = ?",
            (PARK, node_id),
        )
        # Step 1: close the old gap (the moving node is parked, so this is safe).
        _shift_siblings(cursor, old_parent, text_id, old_position + 1, -1)
        # Step 2: open slot in new parent at new_position.
        _shift_siblings(cursor, new_parent, text_id, payload.new_position, +1)
        # Step 3: drop the node into its final spot.
        cursor.execute(
            "UPDATE tree_nodes SET parent_id = ?, position = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (new_parent, payload.new_position, node_id),
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        conn.close()
        raise HTTPException(400, f"Move failed: {e}")

    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (node_id,))
    id2start, _ = _syl_offset_maps(conn, text_id)
    row = _row_to_node(cursor.fetchone(), id2start)
    conn.close()
    return row


@router.delete("/tree-nodes/{node_id}")
def delete_tree_node(
    node_id: int,
    on_children: str = Query("promote", regex="^(promote|cascade)$"),
):
    """Delete a node. on_children=promote pulls children up to grandparent; cascade removes the subtree."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tree_nodes WHERE id = ?", (node_id,))
    node = cursor.fetchone()
    if not node:
        conn.close()
        raise HTTPException(404, "Tree node not found")

    text_id = node["text_id"]
    parent_id = node["parent_id"]
    position = node["position"]

    if on_children == "promote":
        # Fetch children sorted by position so we can splice them into the parent.
        cursor.execute(
            "SELECT id FROM tree_nodes WHERE parent_id = ? ORDER BY position ASC",
            (node_id,),
        )
        children = [r["id"] for r in cursor.fetchall()]
        n_children = len(children)

        try:
            # Detach children temporarily (set parent_id to a sentinel impossible value).
            # SQLite has no transactions across PRAGMA, so we use sequential UPDATEs in a single commit.

            # Step 1: open a window of size n_children in the parent at `position`.
            if n_children > 0:
                _shift_siblings(cursor, parent_id, text_id, position + 1, n_children - 1)
                # The deleted node currently occupies `position` — children will slot starting there.
                # First move children out of the way using HIGH offset to avoid UNIQUE collisions,
                # then re-position them under the new parent.
                HIGH = 1_000_000
                cursor.executemany(
                    "UPDATE tree_nodes SET position = ? WHERE id = ?",
                    [(HIGH + i, cid) for i, cid in enumerate(children)],
                )
                # Reparent children with their new positions.
                cursor.executemany(
                    "UPDATE tree_nodes SET parent_id = ?, position = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE id = ?",
                    [(parent_id, position + i, cid) for i, cid in enumerate(children)],
                )
                # The deleted node still sits at `position` with old siblings shifted by (n_children - 1).
                # Move it out of the way before deleting (avoids collision with first promoted child).
                cursor.execute(
                    "UPDATE tree_nodes SET position = ? WHERE id = ?",
                    (HIGH + n_children, node_id),
                )

            cursor.execute("DELETE FROM tree_nodes WHERE id = ?", (node_id,))

            if n_children == 0:
                # Close the gap left by the deleted node.
                _shift_siblings(cursor, parent_id, text_id, position + 1, -1)

            conn.commit()
        except sqlite3.IntegrityError as e:
            conn.rollback()
            conn.close()
            raise HTTPException(400, f"Delete failed: {e}")

    else:  # cascade
        try:
            cursor.execute("DELETE FROM tree_nodes WHERE id = ?", (node_id,))
            # Close gap left by removed sibling.
            _shift_siblings(cursor, parent_id, text_id, position + 1, -1)
            conn.commit()
        except sqlite3.IntegrityError as e:
            conn.rollback()
            conn.close()
            raise HTTPException(400, f"Delete failed: {e}")

    conn.close()
    return {"status": "ok"}


@router.post("/texts/{text_id}/tree-nodes/reorder")
def reorder_siblings(text_id: int, payload: TreeNodeReorder):
    """Bulk reorder: set siblings of `parent_id` to the order given by `ordered_ids`."""
    conn = get_db()
    cursor = conn.cursor()

    # Validate parent
    try:
        _validate_parent(cursor, text_id, payload.parent_id)
    except HTTPException:
        conn.close()
        raise

    # Validate that ordered_ids matches the actual sibling set
    if payload.parent_id is None:
        cursor.execute(
            "SELECT id FROM tree_nodes WHERE parent_id IS NULL AND text_id = ?",
            (text_id,),
        )
    else:
        cursor.execute(
            "SELECT id FROM tree_nodes WHERE parent_id = ?",
            (payload.parent_id,),
        )
    actual_ids = {r["id"] for r in cursor.fetchall()}
    if set(payload.ordered_ids) != actual_ids:
        conn.close()
        raise HTTPException(
            400, f"ordered_ids must contain exactly the existing sibling ids: {actual_ids}"
        )

    try:
        HIGH = 1_000_000
        # Move everything to scratch space first.
        cursor.executemany(
            "UPDATE tree_nodes SET position = ? WHERE id = ?",
            [(HIGH + i, cid) for i, cid in enumerate(payload.ordered_ids)],
        )
        # Set final positions.
        cursor.executemany(
            "UPDATE tree_nodes SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [(i, cid) for i, cid in enumerate(payload.ordered_ids)],
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        conn.close()
        raise HTTPException(400, f"Reorder failed: {e}")

    conn.close()
    return {"status": "ok"}
