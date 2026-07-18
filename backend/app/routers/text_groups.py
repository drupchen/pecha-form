from fastapi import APIRouter, HTTPException
from typing import List, Optional

from ..auth import active_org_id
from ..db import get_db
from ..schemas import TextGroupCreate, TextGroupMove, TextGroupDelete, TextGroupReorder

router = APIRouter(prefix="/api/text-groups", tags=["text-groups"])

# Order encoding shared by GET / reorder: positioned siblings first (by position), then
# unpositioned ones alphabetically. The frontend uses each path's *index* in this list as a
# relative sibling-order key, so the list stays a plain `list[str]`.
_ORDER_BY = "ORDER BY (position IS NULL), position, path"


def normalize_group_path(raw: Optional[str]) -> Optional[str]:
    """A group is a "/"-separated path (arbitrary-depth sub-groups). Trim each segment,
    drop empties, re-join. An all-empty result is None (ungrouped). Shared by the texts
    router (per-text regroup) and this one so both normalize identically."""
    segments = [s.strip() for s in (raw or "").split("/")]
    joined = "/".join(s for s in segments if s)
    return joined or None


def _rewrite_prefix(conn, org: int, src: str, new_path: str) -> None:
    """Move a group's whole subtree from `src` to `new_path`: prefix-rewrite every affected
    text and registry row (`src` itself + `src/…` descendants). Registry is PK-on-path, so it
    rewrites collision-safe (delete then re-insert-or-ignore). Caller holds the transaction."""
    like = src + "/%"
    tail_from = len(src) + 1  # SUBSTR is 1-indexed; "" for the exact match, "/rest" for a child
    conn.execute(
        "UPDATE texts SET text_group = ? || SUBSTR(text_group, ?) "
        "WHERE org_id = ? AND (text_group = ? OR text_group LIKE ?)",
        (new_path, tail_from, org, src, like),
    )
    affected = [
        r["path"] for r in conn.execute(
            "SELECT path FROM text_groups WHERE org_id = ? AND (path = ? OR path LIKE ?)",
            (org, src, like)
        ).fetchall()
    ]
    # Preserve each row's position across the rename (it keeps its slot in its own parent).
    pos_by_path = {
        r["path"]: r["position"] for r in conn.execute(
            "SELECT path, position FROM text_groups "
            "WHERE org_id = ? AND (path = ? OR path LIKE ?)", (org, src, like)
        ).fetchall()
    }
    for old in affected:
        conn.execute("DELETE FROM text_groups WHERE org_id = ? AND path = ?", (org, old))
    for old in affected:
        rewritten = new_path + old[len(src):]
        conn.execute(
            "INSERT OR IGNORE INTO text_groups(org_id, path, position) VALUES (?, ?, ?)",
            (org, rewritten, pos_by_path.get(old)),
        )


def _direct_children(conn, org: int, parent: Optional[str]) -> List[str]:
    """All direct-child group paths of `parent` (None == root), from the union of the registry
    and the texts' own `text_group` paths, ordered the same way the tree renders them."""
    parent_depth = len(parent.split("/")) if parent else 0
    prefix = parent + "/" if parent else ""
    known = {r["path"] for r in conn.execute(
        "SELECT path FROM text_groups WHERE org_id = ?", (org,)).fetchall()}
    known |= {
        r["text_group"] for r in conn.execute(
            "SELECT DISTINCT text_group FROM texts "
            "WHERE org_id = ? AND text_group IS NOT NULL", (org,)
        ).fetchall()
    }
    children = set()
    for p in known:
        if parent and not p.startswith(prefix):
            continue
        segs = p.split("/")
        if len(segs) <= parent_depth:
            continue
        children.add("/".join(segs[:parent_depth + 1]))  # the direct-child ancestor of p
    pos = {r["path"]: r["position"] for r in conn.execute(
        "SELECT path, position FROM text_groups WHERE org_id = ?", (org,)).fetchall()}
    # Sort by the render key: positioned first (by position), then unpositioned by path.
    return sorted(children, key=lambda c: (pos.get(c) is None, pos.get(c) if pos.get(c) is not None else 0, c))


@router.get("", response_model=List[str])
def list_text_groups():
    conn = get_db()
    rows = conn.execute(
        f"SELECT path FROM text_groups WHERE org_id = ? {_ORDER_BY}",
        (active_org_id(),)).fetchall()
    conn.close()
    return [r["path"] for r in rows]


@router.post("", response_model=List[str])
def create_text_group(body: TextGroupCreate):
    """Register a (possibly empty) group so it persists with no texts in it. Intermediate
    ancestors are synthesized by the frontend tree builder, so we store only this path."""
    path = normalize_group_path(body.path)
    if not path:
        raise HTTPException(400, "Group name cannot be empty")
    conn = get_db()
    with conn:
        conn.execute("INSERT OR IGNORE INTO text_groups(org_id, path) VALUES (?, ?)",
                     (active_org_id(), path))
    rows = conn.execute(
        "SELECT path FROM text_groups WHERE org_id = ? ORDER BY path",
        (active_org_id(),)).fetchall()
    conn.close()
    return [r["path"] for r in rows]


@router.post("/move", response_model=List[str])
def move_text_group(body: TextGroupMove):
    """Reorganize a group: nest `src_path` under `dest_path` (dest "" == top level),
    prefix-rewriting every affected text and registry row. Refuses moving a group into
    itself or one of its own descendants."""
    src = normalize_group_path(body.src_path)
    dest = normalize_group_path(body.dest_path)  # None == root
    if not src:
        raise HTTPException(400, "src_path cannot be empty")
    leaf = src.split("/")[-1]
    new_path = f"{dest}/{leaf}" if dest else leaf
    if new_path == src:
        # No-op (already there); just return the current registry.
        conn = get_db()
        rows = conn.execute(
        f"SELECT path FROM text_groups WHERE org_id = ? {_ORDER_BY}",
        (active_org_id(),)).fetchall()
        conn.close()
        return [r["path"] for r in rows]
    if dest is not None and (dest == src or dest.startswith(src + "/")):
        raise HTTPException(400, "Cannot move a group into itself or a descendant")

    conn = get_db()
    with conn:
        _rewrite_prefix(conn, active_org_id(), src, new_path)
    rows = conn.execute(
        f"SELECT path FROM text_groups WHERE org_id = ? {_ORDER_BY}",
        (active_org_id(),)).fetchall()
    conn.close()
    return [r["path"] for r in rows]


@router.post("/reorder", response_model=List[str])
def reorder_text_group(body: TextGroupReorder):
    """Place `src_path` under `parent_path` ("" == root), immediately before the sibling
    `before_path` (or at the end if empty). Handles reordering root columns and promoting a
    sub-group to an independent root group. Numbers the whole destination sibling set so the
    order is deterministic."""
    src = normalize_group_path(body.src_path)
    parent = normalize_group_path(body.parent_path)  # None == root
    before = normalize_group_path(body.before_path)  # None == append
    if not src:
        raise HTTPException(400, "src_path cannot be empty")
    if parent is not None and (parent == src or parent.startswith(src + "/")):
        raise HTTPException(400, "Cannot move a group into itself or a descendant")
    leaf = src.split("/")[-1]
    new_path = f"{parent}/{leaf}" if parent else leaf

    conn = get_db()
    with conn:
        if new_path != src:
            # Reparent. Refuse a name clash with a *different* existing group at the destination.
            clash = conn.execute(
                "SELECT 1 FROM text_groups WHERE org_id = ? AND path = ? "
                "UNION SELECT 1 FROM texts WHERE org_id = ? "
                "AND (text_group = ? OR text_group LIKE ?) LIMIT 1",
                (active_org_id(), new_path, active_org_id(),
                 new_path, new_path + "/%"),
            ).fetchone()
            if clash:
                raise HTTPException(400, "A group with that name already exists there")
            _rewrite_prefix(conn, active_org_id(), src, new_path)

        # Re-number the destination sibling set with new_path slotted before `before`.
        siblings = [s for s in _direct_children(conn, active_org_id(), parent) if s != new_path]
        insert_at = len(siblings)
        if before and before != new_path:
            for i, s in enumerate(siblings):
                if s == before:
                    insert_at = i
                    break
        siblings.insert(insert_at, new_path)
        for i, path in enumerate(siblings):
            conn.execute("INSERT OR IGNORE INTO text_groups(org_id, path) VALUES (?, ?)",
                         (active_org_id(), path))
            conn.execute("UPDATE text_groups SET position = ? WHERE org_id = ? AND path = ?",
                         (i, active_org_id(), path))

    rows = conn.execute(
        f"SELECT path FROM text_groups WHERE org_id = ? {_ORDER_BY}",
        (active_org_id(),)).fetchall()
    conn.close()
    return [r["path"] for r in rows]


@router.delete("", response_model=List[str])
def delete_text_group(body: TextGroupDelete):
    """Delete an *empty* group (and any empty registry descendants). Refuses if any text
    still lives at the path or below it — those must be moved/ungrouped first."""
    path = normalize_group_path(body.path)
    if not path:
        raise HTTPException(400, "Group path cannot be empty")
    like = path + "/%"
    conn = get_db()
    in_use = conn.execute(
        "SELECT 1 FROM texts WHERE org_id = ? AND (text_group = ? OR text_group LIKE ?) "
        "LIMIT 1",
        (active_org_id(), path, like),
    ).fetchone()
    if in_use:
        conn.close()
        raise HTTPException(409, "Group is not empty — move its texts out first")
    with conn:
        conn.execute("DELETE FROM text_groups WHERE org_id = ? AND (path = ? OR path LIKE ?)",
                     (active_org_id(), path, like))
    rows = conn.execute(
        "SELECT path FROM text_groups WHERE org_id = ? ORDER BY path",
        (active_org_id(),)).fetchall()
    conn.close()
    return [r["path"] for r in rows]
