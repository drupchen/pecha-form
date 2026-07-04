"""Export the syllable base layer as the webapp's ``manifest.json``.

Shape (one object per syllable), matching
``floating-pecha-ui/public/data/archive/*/manifest.json``::

    {"index": 1, "id": "<uuid>", "text": "...", "nature": "TEXT",
     "size": "BIG", "tags": ["verse", ...]}

``size`` is formatting and is decided in the webapp, so we emit a constant
default. ``tags`` carries the *semantic* tag names (from regular-tag spans)
covering each syllable; the webapp maps those names to its own presentation.

Accepted ``suggestions`` are applied into the published ``text`` while the
original string is preserved per syllable as ``original`` (emitted only when it
differs from ``text``, i.e. on edited/deleted syllables). The uuid skeleton stays
the original tokenisation; see ``corrected_layer.merge_corrected``.
"""

from ..manifest import load_syllables, generate_syllables
from ..suggestion_applier import apply_suggestions
from ..corrected_layer import merge_corrected, original_offset_index

DEFAULT_SIZE = "BIG"


def _accepted_suggestions(conn, text_id: int) -> list[dict]:
    # Every suggestion is an applied correction now (no accept lifecycle); delete
    # to revert. Kept the name for callers.
    return [
        dict(r)
        for r in conn.execute(
            "SELECT start_offset, end_offset, suggested_text, created_at "
            "FROM suggestions WHERE text_id = ? "
            "ORDER BY start_offset ASC, created_at ASC",
            (text_id,),
        )
    ]


def build_root_merged(conn, text_id: int) -> tuple[list[dict], str, str]:
    """Build the published *corrected* token list for the root layer, shared by the
    manifest and annotations exporters. Returns ``(merged, raw_text, instance_id)``
    where ``merged`` is ``corrected_layer.merge_corrected`` output (one entry per
    published token: ``id, text, original, nature, orig_start, orig_end, inserted``).
    Accepted suggestions are applied; the skeleton uuids are preserved.
    """
    skeleton = load_syllables(conn, text_id)
    if not skeleton:
        raise ValueError(
            f"Text {text_id} has no syllable layer. "
            f"Build it first (POST /api/texts/{text_id}/build-manifest)."
        )

    doc = conn.execute(
        "SELECT raw_text, instance_id FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    raw_text = doc["raw_text"] or ""
    instance_id = doc["instance_id"] or ""

    accepted = _accepted_suggestions(conn, text_id)
    corrected_text, _ = apply_suggestions(raw_text, accepted)
    corrected_syls = generate_syllables(corrected_text, instance_id)
    merged = merge_corrected(skeleton, corrected_syls, seed_prefix=instance_id)
    return merged, raw_text, instance_id


def build_manifest(conn, text_id: int) -> list[dict]:
    merged, _raw_text, _instance_id = build_root_merged(conn, text_id)

    # Tag overlay: regular-tag spans projected onto the published tokens via their
    # stored syllable-UUID anchors. `positions` lists the non-inserted tokens in
    # original (skeleton) order; `rank_by_id` maps each token uuid to its rank in
    # that order, so a span [start_syl_id..end_syl_id] (inclusive) covers ranks
    # r0..r1 — exactly what the old orig-offset bisection resolved (start_syl_id's
    # orig_start == span.start_offset, end_syl_id's orig_end == span.end_offset).
    # Robust to moves; inserted syllables carry no tags.
    _starts, _ends, positions = original_offset_index(merged)
    rank_by_id = {merged[p]["id"]: k for k, p in enumerate(positions)}
    tags_per: list[list[str]] = [[] for _ in merged]

    spans = conn.execute(
        """
        SELECT s.start_syl_id, s.end_syl_id, t.name
        FROM spans s JOIN tags t ON s.tag_id = t.id
        WHERE s.text_id = ? AND t.tag_kind = 'regular'
        ORDER BY s.start_offset
        """,
        (text_id,),
    ).fetchall()

    for sp in spans:
        r0 = rank_by_id.get(sp["start_syl_id"])
        r1 = rank_by_id.get(sp["end_syl_id"])
        if r0 is None or r1 is None:
            continue
        for k in range(r0, r1 + 1):
            tags_per[positions[k]].append(sp["name"])

    out: list[dict] = []
    for i, m in enumerate(merged):
        entry = {
            "index": i + 1,
            "id": m["id"],
            "text": m["text"],
            "nature": m["nature"],
            "size": DEFAULT_SIZE,
            "tags": tags_per[i],
        }
        if m["original"] is not None and m["original"] != m["text"]:
            entry["original"] = m["original"]
        out.append(entry)
    return out


def build_editor_tokens(conn, text_id: int) -> list[dict]:
    """The corrected root syllable layer for the *editor* (Phase 3 E1).

    Same corrected/merged tokens the published manifest is built from, but shaped
    for the workspace tagger: each token carries its stable uuid ``id`` plus the
    skeleton char offsets (``start_offset``/``end_offset`` = ``orig_start``/
    ``orig_end``) so the frontend can render corrected text as the live selectable
    text while still deriving raw-text offsets for the (still offset-based) create
    paths. ``inserted`` flags net-new suggestion tokens (no skeleton anchor / tags).
    ``original`` is included only when the corrected text differs."""
    merged, _raw_text, _instance_id = build_root_merged(conn, text_id)
    out: list[dict] = []
    for i, m in enumerate(merged):
        tok = {
            "idx": i + 1,
            "id": m["id"],
            "text": m["text"],
            "nature": m["nature"],
            "inserted": m["inserted"],
            "start_offset": m["orig_start"],
            "end_offset": m["orig_end"],
        }
        if m["original"] is not None and m["original"] != m["text"]:
            tok["original"] = m["original"]
        out.append(tok)
    return out
