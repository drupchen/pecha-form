"""Full-fidelity JSON dump for a single text.

This is the round-trip format. Re-importing the JSON via POST
/api/texts/import-json reconstructs the text exactly: same raw text,
same tags (regular + session with their open/close positions), same spans,
markers, tree nodes (preserving parent/child structure and segment_start
links), and same suggestions with their statuses.

Schema version bumps when the format changes incompatibly.
"""

import json
from typing import Any

from ..db import get_db


SCHEMA_VERSION = 1


def dump_text_json(text_id: int) -> str:
    """Return a pretty-printed JSON string that fully describes a text."""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM texts WHERE id = ?", (text_id,))
    doc_row = cursor.fetchone()
    if not doc_row:
        conn.close()
        raise ValueError(f"Text {text_id} not found")
    doc = dict(doc_row)

    cursor.execute(
        "SELECT id, name, color, tag_kind, open_position, close_position "
        "FROM tags WHERE text_id = ? ORDER BY id",
        (text_id,),
    )
    tags = [dict(r) for r in cursor.fetchall()]

    cursor.execute(
        "SELECT id, tag_id, start_offset, end_offset "
        "FROM spans WHERE text_id = ? ORDER BY start_offset, id",
        (text_id,),
    )
    spans = [dict(r) for r in cursor.fetchall()]

    cursor.execute(
        "SELECT position FROM markers WHERE text_id = ? ORDER BY position",
        (text_id,),
    )
    markers = [{"position": r["position"]} for r in cursor.fetchall()]

    cursor.execute(
        "SELECT id, parent_id, position, title, segment_start, transparent "
        "FROM tree_nodes WHERE text_id = ? "
        "ORDER BY parent_id IS NULL DESC, parent_id ASC, position ASC",
        (text_id,),
    )
    tree_nodes = []
    for r in cursor.fetchall():
        n = dict(r)
        n["transparent"] = bool(n["transparent"])
        tree_nodes.append(n)

    cursor.execute(
        "SELECT start_offset, end_offset, suggested_text, status, created_at "
        "FROM suggestions WHERE text_id = ? ORDER BY start_offset, created_at",
        (text_id,),
    )
    suggestions = [dict(r) for r in cursor.fetchall()]

    conn.close()

    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "text": {
            "filename": doc["filename"],
            "title": doc["title"],
            "source_text": doc["source_text"],
            "raw_text": doc["raw_text"],
            "units": json.loads(doc["units_json"]),
        },
        "tags": tags,
        "spans": spans,
        "markers": markers,
        "tree_nodes": tree_nodes,
        "suggestions": suggestions,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)
