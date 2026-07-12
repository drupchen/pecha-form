"""Migrate existing secondaries to LIVE annotation inheritance.

Before this change, deriving a secondary COPIED the parent's markers/notes/
passages/tree. Those tables now inherit live on read (app/inherit.source_texts),
so the copies are duplicates. This deletes the copied rows on every existing
secondary — a row is a copy when the same anchor exists on one of the secondary's
source texts (parent chain + transclusion sources). The boundary/annotation is
preserved: it now shows as INHERITED (read-only) from its owning text. Child-only
rows (boundaries the booklet added itself) are kept.

Idempotent. Run:  cd backend && .venv/bin/python scripts/migrate_inherited_annotations.py [--markers|--all] [--dry-run]
Phases: --markers (T-fix Phase 1). Phases 2–3 extend with --notes/--passages/--tree.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.db import get_db, init_db          # noqa: E402
from app.inherit import source_texts        # noqa: E402


def secondaries(conn):
    return [r["id"] for r in conn.execute(
        "SELECT id FROM texts WHERE text_type = 'secondary'").fetchall()]


def migrate_markers(conn, dry: bool) -> int:
    cur = conn.cursor()
    removed = 0
    for sid in secondaries(conn):
        srcs = source_texts(cur, sid)
        if not srcs:
            continue
        src_syls = {
            r["syl_id"] for r in cur.execute(
                f"SELECT DISTINCT syl_id FROM markers WHERE text_id IN "
                f"({','.join('?' * len(srcs))}) AND syl_id IS NOT NULL", srcs).fetchall()
        }
        if not src_syls:
            continue
        rows = cur.execute(
            "SELECT rowid AS rid, syl_id FROM markers WHERE text_id = ? AND syl_id IS NOT NULL",
            (sid,)).fetchall()
        copies = [r["rid"] for r in rows if r["syl_id"] in src_syls]
        removed += len(copies)
        if not dry:
            for rid in copies:
                conn.execute("DELETE FROM markers WHERE rowid = ?", (rid,))
        print(f"  text {sid}: {len(copies)} copied markers "
              f"({len(rows) - len(copies)} own kept)")
    return removed


def _member_ranges(cur, pid):
    return tuple((m["src_start_syl_id"], m["src_end_syl_id"]) for m in cur.execute(
        "SELECT src_start_syl_id, src_end_syl_id FROM passage_members "
        "WHERE passage_id = ? ORDER BY position", (pid,)).fetchall())


def migrate_passages(conn, dry: bool) -> int:
    cur = conn.cursor()
    removed = 0
    for sid in secondaries(conn):
        srcs = source_texts(cur, sid)
        if not srcs:
            continue
        src_keys = {
            (r["anchor_syl_id"], _member_ranges(cur, r["id"]))
            for r in cur.execute(
                f"SELECT id, anchor_syl_id FROM passages WHERE text_id IN "
                f"({','.join('?' * len(srcs))})", srcs).fetchall()
        }
        copies = [r["id"] for r in cur.execute(
            "SELECT id, anchor_syl_id FROM passages WHERE text_id = ?", (sid,)).fetchall()
            if (r["anchor_syl_id"], _member_ranges(cur, r["id"])) in src_keys]
        removed += len(copies)
        if not dry:
            for pid in copies:
                conn.execute("DELETE FROM passages WHERE id = ?", (pid,))  # cascades members
        if copies:
            print(f"  text {sid}: {len(copies)} copied passages")
    return removed


def migrate_notes(conn, dry: bool) -> int:
    cur = conn.cursor()
    removed = 0
    for sid in secondaries(conn):
        srcs = source_texts(cur, sid)
        if not srcs:
            continue
        src_keys = {
            (r["start_syl_id"], r["end_syl_id"], r["body"], r["passage_id"])
            for r in cur.execute(
                f"SELECT start_syl_id, end_syl_id, body, passage_id FROM notes "
                f"WHERE text_id IN ({','.join('?' * len(srcs))})", srcs).fetchall()
        }
        copies = [r["id"] for r in cur.execute(
            "SELECT id, start_syl_id, end_syl_id, body, passage_id FROM notes WHERE text_id = ?",
            (sid,)).fetchall()
            if (r["start_syl_id"], r["end_syl_id"], r["body"], r["passage_id"]) in src_keys]
        removed += len(copies)
        if not dry:
            for nid in copies:
                conn.execute("DELETE FROM notes WHERE id = ?", (nid,))
        if copies:
            print(f"  text {sid}: {len(copies)} copied notes")
    return removed


def _tree_key(r):
    return (r["title"], r["segment_start_syl_id"], r["passage_id"])


def migrate_tree(conn, dry: bool) -> int:
    """Delete a secondary's COPIED tree nodes (matched against source nodes by
    title+anchor) so it inherits the source tree live; re-parent its genuine OWN
    nodes onto the inherited originals. SELF-VERIFYING: after the change, the text's
    gathered tree (inherited + own) must have no duplicated (title,anchor) — i.e. no
    doubling — and must retain every own node with a resolvable parent, or the whole
    text's migration is rolled back."""
    from app.routers.tree_nodes import _gathered_tree_rows
    cur = conn.cursor()
    removed = 0
    for sid in secondaries(conn):
        srcs = source_texts(cur, sid)
        if not srcs:
            continue
        src_nodes = cur.execute(
            f"SELECT id, title, segment_start_syl_id, passage_id FROM tree_nodes "
            f"WHERE text_id IN ({','.join('?' * len(srcs))})", srcs).fetchall()
        src_by_key = {_tree_key(r): r["id"] for r in src_nodes}
        own_rows = cur.execute(
            "SELECT id, parent_id, title, segment_start_syl_id, passage_id "
            "FROM tree_nodes WHERE text_id = ?", (sid,)).fetchall()
        # copy map: this text's copy id -> source original id
        copy_map = {r["id"]: src_by_key[_tree_key(r)]
                    for r in own_rows if _tree_key(r) in src_by_key}
        own = [r for r in own_rows if r["id"] not in copy_map]
        if not copy_map:
            continue

        conn.execute("SAVEPOINT tree_mig")
        try:
            # Re-parent own nodes whose parent was a copy onto the inherited original.
            for r in own:
                if r["parent_id"] in copy_map:
                    conn.execute("UPDATE tree_nodes SET parent_id = ? WHERE id = ?",
                                 (copy_map[r["parent_id"]], r["id"]))
            for cid in copy_map:
                conn.execute("DELETE FROM tree_nodes WHERE id = ?", (cid,))
            # Verify: gathered tree has no doubled (title,anchor); every own kept.
            gathered = _gathered_tree_rows(conn, sid)
            keys = [(_tree_key(g)) for g in gathered]
            dup = len(keys) != len(set(keys))
            own_ids = {r["id"] for r in own}
            present = {g["id"] for g in gathered}
            parents_ok = all(
                g["parent_id"] is None or g["parent_id"] in present
                for g in gathered if g["id"] in own_ids)
            if dup or not own_ids <= present or not parents_ok:
                raise RuntimeError(
                    f"tree self-verify failed for text {sid} "
                    f"(dup={dup}, own_kept={own_ids <= present}, parents_ok={parents_ok})")
            removed += len(copy_map)
            print(f"  text {sid}: {len(copy_map)} copied nodes removed, "
                  f"{len(own)} own re-parented/kept")
            if dry:
                conn.execute("ROLLBACK TO tree_mig")
            conn.execute("RELEASE tree_mig")
        except Exception as e:
            conn.execute("ROLLBACK TO tree_mig")
            conn.execute("RELEASE tree_mig")
            print(f"  text {sid}: SKIPPED — {e}")
    return removed


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--markers", action="store_true")
    ap.add_argument("--notes", action="store_true")
    ap.add_argument("--passages", action="store_true")
    ap.add_argument("--tree", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    init_db()
    conn = get_db()
    total = 0
    if args.markers or args.all:
        print("markers:")
        total += migrate_markers(conn, args.dry_run)
    if args.passages or args.all:
        print("passages:")
        total += migrate_passages(conn, args.dry_run)
    if args.notes or args.all:
        print("notes:")
        total += migrate_notes(conn, args.dry_run)
    if args.tree or args.all:
        print("tree:")
        total += migrate_tree(conn, args.dry_run)
    if not args.dry_run:
        conn.commit()
    conn.close()
    print(f"{'[dry-run] would remove' if args.dry_run else 'removed'} {total} copied rows")
