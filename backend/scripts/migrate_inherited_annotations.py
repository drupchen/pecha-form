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


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--markers", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    init_db()
    conn = get_db()
    total = 0
    if args.markers or args.all:
        print("markers:")
        total += migrate_markers(conn, args.dry_run)
    if not args.dry_run:
        conn.commit()
    conn.close()
    print(f"{'[dry-run] would remove' if args.dry_run else 'removed'} {total} copied rows")
