"""Live inheritance of syllable-anchored annotations down the derivation graph.

A secondary text does NOT copy its parent's tags/markers/notes/passages/tree — it
INHERITS them live on read: syllable uuids are shared (identity remap at derive),
so a source's anchor syllables are present in the child's composed stream. Every
annotation read gathers rows from ``[text_id] + source_texts(text_id)`` and keeps
the ones whose anchors resolve in the child's stream. Editing happens on the
OWNING text and ripples; the child only adds its own rows.
"""


def source_texts(cursor, text_id: int, _seen=None) -> list[int]:
    """Every text whose annotations can resolve on this text's composed stream: the
    parent chain plus transclusion sources, recursively (a grandparent's transcluded
    source flows through too). Cycle-guarded; self excluded; stable order."""
    _seen = set() if _seen is None else _seen
    if text_id in _seen:
        return []
    _seen.add(text_id)
    out: list[int] = []
    row = cursor.execute(
        "SELECT parent_text_id FROM texts WHERE id = ?", (text_id,)).fetchone()
    if row and row["parent_text_id"] and row["parent_text_id"] not in _seen:
        out.append(row["parent_text_id"])
        out.extend(source_texts(cursor, row["parent_text_id"], _seen))
    for r in cursor.execute(
            "SELECT DISTINCT src_text_id FROM derivation_ops "
            "WHERE text_id = ? AND op_kind = 'transclude' AND src_text_id IS NOT NULL "
            "ORDER BY src_text_id", (text_id,)).fetchall():
        src = r["src_text_id"]
        if src not in _seen:
            out.append(src)
            out.extend(source_texts(cursor, src, _seen))
    return out
