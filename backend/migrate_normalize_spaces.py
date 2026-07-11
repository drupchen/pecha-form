"""One-off migration: fold Unicode space separators (U+00A0 etc.) to U+0020 in
stored text, then rebuild the syllable skeletons.

Why: botok's ChunkTokenizer classifies U+00A0 (NO-BREAK SPACE) as LATIN, which
shatters punctuation clusters in the published manifest (``། །`` -> ``།`` / `` ``
/ ``།``). The ingestion paths now normalise these spaces, but documents ingested
before the fix still carry U+00A0 in ``documents.raw_text`` and
``srt_segments.text``. The replacement is length-preserving (1 char -> 1 char),
so every existing character offset — and thus every annotation — stays valid;
``id_reconcile`` keeps unchanged syllables' uuids stable while the newly-merged
punctuation units get fresh uuids.

Run against a *copy* of the DB first:

    cp sapche.db sapche.migrated.db
    python migrate_normalize_spaces.py --db sapche.migrated.db --dry-run
    python migrate_normalize_spaces.py --db sapche.migrated.db

After running, re-publish the document(s) so the JSON artefacts
(manifest.json, transcription_manifest.json, annotations.json, sapche.json,
compiled-sessions) reflect the merged punctuation.
"""
import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app.tokenizer import normalize_spaces  # noqa: E402
from app.manifest import persist_syllables, default_instance_id  # noqa: E402
from app.transcript_manifest import persist_transcript_syllables  # noqa: E402


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migrate(db_path: str, dry_run: bool) -> None:
    if not os.path.exists(db_path):
        raise SystemExit(f"DB not found: {db_path}")
    conn = _connect(db_path)

    docs = conn.execute(
        "SELECT id, instance_id, title, raw_text FROM documents"
    ).fetchall()

    docs_changed = 0
    segs_changed = 0
    for doc in docs:
        doc_id = doc["id"]
        instance_id = (doc["instance_id"] or "").strip() or default_instance_id(
            doc["title"] or ""
        )

        # --- root text -----------------------------------------------------
        raw = doc["raw_text"] or ""
        norm = normalize_spaces(raw)
        if norm != raw:
            docs_changed += 1
            assert len(norm) == len(raw), "normalize_spaces must be length-preserving"
            if not dry_run:
                conn.execute(
                    "UPDATE documents SET raw_text = ? WHERE id = ?", (norm, doc_id)
                )
        # Rebuild the root syllable skeleton from the normalised text. Safe to run
        # even when raw_text was unchanged (idempotent via id_reconcile).
        if not dry_run:
            persist_syllables(conn, doc_id, instance_id, norm)

        # --- transcript segments ------------------------------------------
        seg_rows = conn.execute(
            "SELECT id, text FROM srt_segments WHERE document_id = ?", (doc_id,)
        ).fetchall()
        had_segments = bool(seg_rows)
        for seg in seg_rows:
            seg_text = seg["text"] or ""
            seg_norm = normalize_spaces(seg_text)
            if seg_norm != seg_text:
                segs_changed += 1
                assert len(seg_norm) == len(seg_text)
                if not dry_run:
                    conn.execute(
                        "UPDATE srt_segments SET text = ? WHERE id = ?",
                        (seg_norm, seg["id"]),
                    )
        if had_segments and not dry_run:
            persist_transcript_syllables(conn, doc_id, instance_id)

        print(
            f"doc {doc_id} ({instance_id}): "
            f"raw_text {'changed' if norm != raw else 'unchanged'}, "
            f"{len(seg_rows)} transcript segment(s)"
        )

    if dry_run:
        print(
            f"\nDRY RUN — would normalise {docs_changed} document(s) and "
            f"{segs_changed} transcript segment(s). No changes written."
        )
        conn.close()
        return

    conn.commit()
    conn.close()
    print(
        f"\nDone — normalised {docs_changed} document(s) and {segs_changed} "
        f"transcript segment(s); syllable skeletons rebuilt. "
        f"Re-publish to refresh the exported JSON."
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--db",
        default=os.path.join(os.path.dirname(__file__), "sapche.db"),
        help="Path to the SQLite DB (default: backend/sapche.db)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing.",
    )
    args = ap.parse_args()
    migrate(args.db, args.dry_run)
