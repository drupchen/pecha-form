"""One-time migration: re-mint syllable uuids with per-text-unique instance ids.

Why: `default_instance_id` slugged every Tibetan title to the literal "instance", and
syllable uuids are `uuid5(ns, f"{instance}_{idx}_{text}")` — so any two texts sharing
(idx, syllable-text) minted the SAME uuid. That broke the global-uniqueness invariant
(e.g. text 31's title-span end resolved inside a transcluded run of text 10 → the
title-tag bleed). This script gives every primary a unique instance
(f"{old}_t{id}"), recomputes all syllable ids positionally, and rewrites every uuid
reference in the DB. Colliding old ids are disambiguated per reference by OWNER
(host chain first, then transclusion sources).

Run:  cd backend && .venv/bin/python scripts/remint_unique_instances.py
A backup is written to sapche.db.pre-remint-bak first. The script verifies the result
and rolls back (no commit) on any inconsistency.
"""
import os
import shutil
import sys
from collections import Counter

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.db import get_db, DB_PATH  # noqa: E402
from app.manifest import syllable_id  # noqa: E402

# (table, column, owner_column) — owner_column names the text whose anchor space the
# uuid lives in ('text_id' unless noted). passage_members joins through passages.
REF_COLUMNS = [
    ("spans", "start_syl_id", "text_id"),
    ("spans", "end_syl_id", "text_id"),
    ("notes", "start_syl_id", "text_id"),
    ("notes", "end_syl_id", "text_id"),
    ("suggestions", "start_syl_id", "text_id"),
    ("suggestions", "end_syl_id", "text_id"),
    ("markers", "syl_id", "text_id"),
    ("reading_positions", "syl_id", "text_id"),
    ("tree_nodes", "segment_start_syl_id", "text_id"),
    ("tags", "open_syl_id", "text_id"),
    ("tags", "close_syl_id", "text_id"),
    ("passages", "anchor_syl_id", "text_id"),
]


def parent_chain(conn, tid):
    out = []
    while True:
        r = conn.execute("SELECT parent_text_id FROM texts WHERE id=?", (tid,)).fetchone()
        if not r or not r[0]:
            return out
        out.append(r[0])
        tid = r[0]


def graph_sources(conn, tid, _seen=None):
    """Texts reachable from tid through parent links and transclusions (self excluded)."""
    _seen = set() if _seen is None else _seen
    if tid in _seen:
        return []
    _seen.add(tid)
    out = []
    for p in parent_chain(conn, tid):
        if p not in _seen:
            out.append(p)
            out.extend(graph_sources(conn, p, _seen))
    for r in conn.execute(
            "SELECT DISTINCT src_text_id FROM derivation_ops WHERE text_id=? "
            "AND op_kind='transclude' AND src_text_id IS NOT NULL ORDER BY src_text_id",
            (tid,)).fetchall():
        if r[0] not in _seen:
            out.append(r[0])
            out.extend(graph_sources(conn, r[0], _seen))
    return out


def main():
    bak = DB_PATH + ".pre-remint-bak"
    if not os.path.exists(bak):
        shutil.copyfile(DB_PATH, bak)
        print(f"backup: {bak}")

    conn = get_db()

    def dangling_refs():
        """(table, column, value) of refs whose uuid resolves to NO syllable row —
        the set must not grow."""
        all_ids = {r[0] for r in conn.execute("SELECT id FROM syllables")}
        out = []
        for table, col, _ in REF_COLUMNS:
            for r in conn.execute(
                    f"SELECT {col} AS v FROM {table} WHERE {col} IS NOT NULL").fetchall():
                if r["v"] not in all_ids:
                    out.append((table, col, r["v"]))
        for col in ("src_start_syl_id", "src_end_syl_id", "anchor_syl_id"):
            for r in conn.execute(
                    f"SELECT {col} AS v FROM derivation_ops WHERE {col} IS NOT NULL").fetchall():
                if r["v"] not in all_ids:
                    out.append(("derivation_ops", col, r["v"]))
        for col in ("src_start_syl_id", "src_end_syl_id"):
            for r in conn.execute(
                    f"SELECT {col} AS v FROM passage_members").fetchall():
                if r["v"] not in all_ids:
                    out.append(("passage_members", col, r["v"]))
        return out

    dangling_before = dangling_refs()

    # ── 1. Re-mint every primary's syllable layer with a unique instance. ─────────
    maps: dict[int, dict[str, str]] = {}   # text_id -> old_id -> new_id
    for t in conn.execute(
            "SELECT id, instance_id FROM texts WHERE text_type='primary'").fetchall():
        tid = t["id"]
        old_inst = (t["instance_id"] or "instance").strip() or "instance"
        if old_inst.endswith(f"_t{tid}"):
            continue  # already unique (idempotent re-run)
        new_inst = f"{old_inst}_t{tid}"
        m = {}
        for s in conn.execute(
                "SELECT id, idx, text FROM syllables WHERE text_id=? ORDER BY idx",
                (tid,)).fetchall():
            new_id = syllable_id(new_inst, s["idx"], s["text"])
            if new_id != s["id"]:
                m[s["id"]] = new_id
        for old, new in m.items():
            conn.execute("UPDATE syllables SET id=? WHERE text_id=? AND id=?",
                         (new, tid, old))
        conn.execute("UPDATE texts SET instance_id=? WHERE id=?", (new_inst, tid))
        maps[tid] = m
        print(f"text {tid}: instance {old_inst!r} -> {new_inst!r}, {len(m)} ids re-minted")

    if not maps:
        print("nothing to migrate")
        conn.close()
        return

    # Colliding old ids = present in more than one text's map (owner decides).
    id_owners = Counter()
    for m in maps.values():
        id_owners.update(m.keys())
    colliding = {k for k, v in id_owners.items() if v > 1}
    global_map = {}
    for tid, m in maps.items():
        for old, new in m.items():
            if old not in colliding:
                global_map[old] = new
    print(f"unique old ids: {len(global_map)}, colliding: {len(colliding)}")

    def candidate_maps(owner):
        """Ordered maps for resolving a reference owned by `owner`: itself (if
        primary), then parent chain, then transclusion sources — host first."""
        order = ([owner] if owner in maps else []) + [
            t for t in graph_sources(conn, owner) if t in maps]
        return [maps[t] for t in order]

    # Colliding refs that don't resolve in their OWNER's space were ALREADY stale
    # (their anchor no longer exists in the owner's layer — e.g. pre-snap-era bakes);
    # the collision merely masked them. They stay dangling (skipped on read) and are
    # excluded from the "new dangling" failure below.
    unmasked_stale: set = set()

    def resolve(old_id, owner):
        if old_id in global_map:
            return global_map[old_id]
        if old_id in colliding:
            for m in candidate_maps(owner):
                if old_id in m:
                    return m[old_id]
            unmasked_stale.add(old_id)
        return None  # not a re-minted id (hosted secondary syl etc.) — leave

    # ── 2. Rewrite references. ─────────────────────────────────────────────────────
    for table, col, owner_col in REF_COLUMNS:
        n = 0
        for r in conn.execute(
                f"SELECT rowid AS rid, {col} AS v, {owner_col} AS owner FROM {table} "
                f"WHERE {col} IS NOT NULL").fetchall():
            new = resolve(r["v"], r["owner"])
            if new is not None:
                conn.execute(f"UPDATE {table} SET {col}=? WHERE rowid=?", (new, r["rid"]))
                n += 1
        print(f"{table}.{col}: {n} rewritten")

    # passage_members (owner = passages.text_id)
    for col in ("src_start_syl_id", "src_end_syl_id"):
        n = 0
        for r in conn.execute(
                f"SELECT pm.rowid AS rid, pm.{col} AS v, p.text_id AS owner "
                f"FROM passage_members pm JOIN passages p ON p.id = pm.passage_id").fetchall():
            new = resolve(r["v"], r["owner"])
            if new is not None:
                conn.execute(f"UPDATE passage_members SET {col}=? WHERE rowid=?",
                             (new, r["rid"]))
                n += 1
        print(f"passage_members.{col}: {n} rewritten")

    # derivation_ops: anchor lives in the op text's PARENT stream (host-first);
    # src_start/src_end live in exactly src_text_id's space (src first).
    n = 0
    for r in conn.execute(
            "SELECT rowid AS rid, anchor_syl_id AS v, text_id AS owner FROM derivation_ops "
            "WHERE anchor_syl_id IS NOT NULL").fetchall():
        new = resolve(r["v"], r["owner"])
        if new is not None:
            conn.execute("UPDATE derivation_ops SET anchor_syl_id=? WHERE rowid=?",
                         (new, r["rid"]))
            n += 1
    print(f"derivation_ops.anchor_syl_id: {n} rewritten")
    for col in ("src_start_syl_id", "src_end_syl_id"):
        n = 0
        for r in conn.execute(
                f"SELECT rowid AS rid, {col} AS v, src_text_id AS src FROM derivation_ops "
                f"WHERE {col} IS NOT NULL AND src_text_id IS NOT NULL").fetchall():
            new = resolve(r["v"], r["src"])
            if new is not None:
                conn.execute(f"UPDATE derivation_ops SET {col}=? WHERE rowid=?",
                             (new, r["rid"]))
                n += 1
        print(f"derivation_ops.{col}: {n} rewritten")

    # ── 3. Verify before committing. ───────────────────────────────────────────────
    from app.derivation import compose_secondary
    ok = True
    for t in conn.execute("SELECT id FROM texts WHERE text_type='secondary'").fetchall():
        toks = compose_secondary(conn, t["id"])
        by_id: dict = {}
        for x in toks:
            by_id.setdefault(x["id"], []).append(x.get("src_text_id") or "host")
        # A duplicate is LEGIT iff every occurrence comes from transcluding the SAME
        # source (one physical syllable displayed at several places, like a passage).
        # It is a cross-text collision iff the occurrences span different owners.
        bad = {k: v for k, v in by_id.items() if len(v) > 1 and len(set(v)) > 1}
        if bad:
            print(f"FAIL: text {t['id']} has cross-owner duplicate ids: "
                  f"{list(bad.items())[:3]}")
            ok = False
    for op in conn.execute(
            "SELECT * FROM derivation_ops WHERE op_kind='transclude'").fetchall():
        ids = {r[0] for r in conn.execute(
            "SELECT id FROM syllables WHERE text_id=?", (op["src_text_id"],))}
        if (op["src_start_syl_id"] not in ids) or (op["src_end_syl_id"] not in ids):
            print(f"FAIL: transclude op {op['id']} no longer resolves")
            ok = False
    dangling_after = dangling_refs()
    print(f"dangling refs: before={len(dangling_before)} after={len(dangling_after)}")
    if unmasked_stale:
        print(f"unmasked pre-existing stale refs (left dangling, skipped on read): "
              f"{sorted(unmasked_stale)}")
    new_dangling = [d for d in dangling_after
                    if d not in dangling_before and d[2] not in unmasked_stale]
    if new_dangling:
        print(f"FAIL: migration created new dangling references: {new_dangling[:10]}")
        ok = False
    if not ok:
        print("verification failed — NOT committing (DB unchanged)")
        conn.close()
        sys.exit(1)
    conn.commit()
    conn.close()
    print("done — committed")


if __name__ == "__main__":
    main()
