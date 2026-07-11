"""Build the corrected root syllable layer for the workspace editor.

Applies the text's ``suggestions`` (every one an applied correction — delete to
revert) onto the raw tokenisation, aligns the corrected syllables back to the
stable uuid skeleton (``corrected_layer.merge_corrected``), and shapes the result
as ``editor-tokens`` for the tagger. The per-syllable ``original`` string is kept
where the corrected text differs.

(Export to the webapp's ``manifest.json`` was removed — see git history; it will
be reintroduced later on the syllable-native model.)
"""

from ..manifest import load_syllables, generate_syllables, _text_corrected
from ..corrected_layer import merge_corrected


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

    # Part 6, Phase 3: the corrected string comes from the syllable-native splice
    # (suggestions anchored by syllable id); re-tokenise it and realign to the stable
    # uuid skeleton via merge_corrected exactly as before.
    got = _text_corrected(conn, text_id)
    corrected_text = got[1] if got else raw_text
    corrected_syls = generate_syllables(corrected_text, instance_id)
    merged = merge_corrected(skeleton, corrected_syls, seed_prefix=instance_id)
    return merged, raw_text, instance_id


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
