"""Syllable base layer = the published ``manifest.json``.

This is the bridge between sapche_discovery's character-offset world and the
webapp's syllable-UUID world. We tokenize ``raw_text`` into syllables that
exactly partition it (every character belongs to exactly one syllable), assign
each a stable ``uuid5`` id, and persist them in the ``syllables`` table.

The tokenization mirrors ``prepare_data/base_layer_ingest.py``: botok's
``ChunkTokenizer`` per line, with newlines emitted as explicit ``SPACE`` tokens.
The id scheme is identical too, so the files we emit are byte-compatible with
the webapp's contract:

    NAMESPACE_KHYENTSE = uuid5(NAMESPACE_URL, "khyentse.website.data")
    id = uuid5(NAMESPACE_KHYENTSE, f"{instance_id}_{index}_{text}")

ChunkTokenizer is lossless per line (verified against the real text), so
the produced syllables reconstruct raw_text exactly and carry true offsets.
"""

import re
import uuid

from .tokenizer import split_text_at_yigmgo

NAMESPACE_KHYENTSE = uuid.uuid5(uuid.NAMESPACE_URL, "khyentse.website.data")


def default_instance_id(text: str) -> str:
    """A filesystem-safe fallback instance_id slug from a title/filename.

    The canonical instance_id (e.g. "drime_shalung_1") should be supplied
    explicitly; this only keeps ingestion working when one is omitted.
    """
    slug = re.sub(r"[^A-Za-z0-9]+", "_", (text or "").strip()).strip("_").lower()
    return slug or "instance"


def syllable_id(instance_id: str, index: int, text: str) -> str:
    """The stable manifest id for a syllable, matching base_layer_ingest.py."""
    return str(uuid.uuid5(NAMESPACE_KHYENTSE, f"{instance_id}_{index}_{text}"))


TSEK = "་"  # ་  Tibetan syllable delimiter
_TSEK_RUN = re.compile(f"({TSEK}{{2,}})")  # a maximal run of >=2 tseks


def _gap_nature(gap: str) -> str:
    """Nature for a span botok dropped: tseks are PUNCT, whitespace SPACE."""
    if all(c == TSEK for c in gap):
        return "PUNCT"
    if gap.isspace():
        return "SPACE"
    return "OTHER"


def tile_line(line: str) -> list[tuple[str, str]]:
    """Return ``(nature, text)`` chunks that EXACTLY tile ``line``.

    A maximal run of >=2 consecutive tseks (``་``) — a transcriber's mark for a
    missing/incomprehensible passage — is gathered into one ``PUNCT`` chunk and
    never merged into a neighbouring syllable. The text between runs is tokenised
    with botok's ``ChunkTokenizer``; anything botok drops (e.g. a lone leading
    tsek) is recovered as a filler chunk so the chunks always reconstruct ``line``.
    """
    from botok import ChunkTokenizer

    out: list[tuple[str, str]] = []
    for piece in _TSEK_RUN.split(line):
        if not piece:
            continue
        if _TSEK_RUN.fullmatch(piece):
            out.append(("PUNCT", piece))  # a gathered run of extra tseks
            continue
        # A normal text span: reconcile botok's tokens against `piece` by
        # position so any character botok drops becomes its own filler chunk.
        cur = 0
        for nature, tok in ChunkTokenizer(piece).tokenize():
            at = piece.find(tok, cur)
            if at < 0:  # defensive: token not locatable, keep it as-is
                out.append((nature, tok))
                continue
            if at > cur:
                gap = piece[cur:at]
                out.append((_gap_nature(gap), gap))
            out.append((nature, tok))
            cur = at + len(tok)
        if cur < len(piece):
            rest = piece[cur:]
            out.append((_gap_nature(rest), rest))
    # Never glue a closing mark to an opening yig-mgo: split each chunk at the first
    # yig-mgo so the from-``༄`` part is its own (following-joining) PUNCT syllable.
    return [(nat, part) for nat, tok in out for part in split_text_at_yigmgo(tok)]


def generate_syllables(raw_text: str, instance_id: str) -> list[dict]:
    """Partition raw_text into syllables with exact offsets and uuid5 ids.

    Returns dicts: {idx, id, start_offset, end_offset, text, nature}.
    Guarantees: the syllables tile raw_text with no gaps or overlaps, i.e.
    ``"".join(s["text"] for s in result) == raw_text``.
    """
    syllables: list[dict] = []
    cursor = 0
    index = 1
    n = len(raw_text)
    lines = raw_text.split("\n")

    def emit(start: int, end: int, text: str, nature: str) -> None:
        nonlocal index
        syllables.append({
            "idx": index,
            "id": syllable_id(instance_id, index, text),
            "start_offset": start,
            "end_offset": end,
            "text": text,
            "nature": nature,
        })
        index += 1

    for i, line in enumerate(lines):
        for nature, tok in tile_line(line):
            emit(cursor, cursor + len(tok), tok, nature)
            cursor += len(tok)
        # A '\n' separates every pair of lines; there is none after the last.
        if i < len(lines) - 1:
            emit(cursor, cursor + 1, "\n", "SPACE")
            cursor += 1

    assert cursor == n, f"syllable coverage {cursor} != raw_text {n}"
    return syllables


def persist_syllables(conn, text_id: int, instance_id: str, raw_text: str) -> int:
    """(Re)build the syllable layer for a text. Additive: only the
    ``syllables`` table for this text is touched — annotation tables are
    never read or modified here. Idempotent (re-runnable).

    Token ids are reconciled against any existing rows so they stay stable across
    re-ingest: an edited syllable keeps its id, an inserted one gets a fresh id,
    a deleted one drops (see id_reconcile). First ingest keeps the freshly-minted
    ids as the initial persistent identity."""
    from .id_reconcile import assign_stable_ids

    syllables = generate_syllables(raw_text, instance_id)
    existing = [
        {"id": r["id"], "text": r["text"]}
        for r in conn.execute(
            "SELECT id, text FROM syllables WHERE text_id = ? ORDER BY idx",
            (text_id,),
        )
    ]
    assign_stable_ids(existing, syllables)
    conn.execute("DELETE FROM syllables WHERE text_id = ?", (text_id,))
    conn.executemany(
        "INSERT INTO syllables (id, text_id, idx, start_offset, end_offset, text, nature) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (s["id"], text_id, s["idx"], s["start_offset"], s["end_offset"],
             s["text"], s["nature"])
            for s in syllables
        ],
    )
    return len(syllables)


def attach_cumulative_offsets(rows: list) -> list[dict]:
    """Phase 3 E5: derive ``start_offset``/``end_offset`` from the syllable sequence
    (cumulative ``text`` lengths) instead of reading stored columns. The syllables
    tile their text exactly, so this reproduces the offsets identically while letting
    the stored columns be dropped. ``rows`` must be ordered (idx, per text or
    per segment). Returns a list of dicts with offsets attached."""
    out: list[dict] = []
    pos = 0
    for r in rows:
        d = dict(r)
        end = pos + len(d["text"])
        d["start_offset"] = pos
        d["end_offset"] = end
        pos = end
        out.append(d)
    return out


def load_syllables(conn, text_id: int) -> list[dict]:
    """All syllables for a text, ordered by index. Offsets are derived from
    the syllable sequence (see ``attach_cumulative_offsets``), not stored."""
    rows = conn.execute(
        "SELECT id, idx, text, nature "
        "FROM syllables WHERE text_id = ? ORDER BY idx",
        (text_id,),
    ).fetchall()
    return attach_cumulative_offsets(rows)


def _text_corrected(conn, text_id: int):
    """Shared: ``(instance_id, corrected_text, offset_map)`` for a text with its
    accepted root ``suggestions`` applied (or ``None`` if the text is missing).
    ``offset_map`` maps corrected offsets back to raw (see ``apply_suggestions``)."""
    from .suggestion_applier import apply_suggestions

    row = conn.execute(
        "SELECT raw_text, instance_id FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    if row is None:
        return None
    accepted = [
        dict(r)
        for r in conn.execute(
            "SELECT start_offset, end_offset, suggested_text, created_at FROM suggestions "
            "WHERE text_id = ? "  # all suggestions are applied corrections now
            "ORDER BY start_offset ASC, created_at ASC",
            (text_id,),
        )
    ]
    corrected_text, offset_map = apply_suggestions(row["raw_text"] or "", accepted)
    return row["instance_id"] or "", corrected_text, offset_map


def corrected_root_units(conn, text_id: int) -> list[list]:
    """Root display units ``[start, end, text]`` with accepted suggestions applied to
    the *text* but **raw** offsets preserved (snapped through replacements). Same
    tokeniser/shape as ``texts.units_json`` — a drop-in for the Alignment tab's
    main-text column, leaving portion building / drag-to-suggest on raw offsets. With
    no accepted suggestions this reproduces ``units_json`` exactly."""
    from .suggestion_applier import corr_offset_to_raw
    from .tokenizer import tokenize_tibetan

    got = _text_corrected(conn, text_id)
    if got is None:
        return []
    _, corrected_text, offset_map = got
    return [
        [corr_offset_to_raw(offset_map, start, is_end=False),
         corr_offset_to_raw(offset_map, end, is_end=True), text]
        for start, end, text in tokenize_tibetan(corrected_text)
    ]


def corrected_root_syllables(conn, text_id: int) -> list[dict]:
    """Root skeleton syllables with accepted suggestions applied to the *text* but
    **raw** offsets preserved — the needle analogue of
    ``transcript_manifest.corrected_segment_syllables`` for the main-text matcher.
    Each dict: ``{start_offset, end_offset, text, nature, inserted}`` (``inserted``
    True for pure insertions with no raw home)."""
    from .suggestion_applier import corr_offset_to_raw

    got = _text_corrected(conn, text_id)
    if got is None:
        return []
    instance_id, corrected_text, offset_map = got
    out: list[dict] = []
    for s in generate_syllables(corrected_text, instance_id):
        rs = corr_offset_to_raw(offset_map, s["start_offset"], is_end=False)
        re_ = corr_offset_to_raw(offset_map, s["end_offset"], is_end=True)
        out.append({
            "start_offset": rs, "end_offset": re_, "text": s["text"],
            "nature": s["nature"], "inserted": re_ <= rs,
        })
    return out


def offset_to_syllable_index(syllables: list[dict], offset: int) -> int | None:
    """Index into ``syllables`` of the syllable containing ``offset``.

    Used for export-time mapping of stored annotation offsets to syllable ids
    without mutating any stored offset. An offset that falls between syllable
    boundaries resolves to the syllable whose range contains it; an offset at or
    past the end clamps to the last syllable.
    """
    if not syllables:
        return None
    # Binary search on start_offset.
    lo, hi = 0, len(syllables) - 1
    if offset <= syllables[0]["start_offset"]:
        return 0
    if offset >= syllables[-1]["start_offset"]:
        return len(syllables) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if syllables[mid]["start_offset"] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo


def syllable_ids_in_range(syllables: list[dict], start: int, end: int) -> list[str]:
    """uuid ids of all syllables overlapping the half-open range [start, end)."""
    out = []
    for s in syllables:
        if s["start_offset"] < end and s["end_offset"] > start:
            out.append(s["id"])
    return out


def syllable_ids_between(
    syllables: list[dict], start_syl_id: str, end_syl_id: str
) -> list[str]:
    """uuid ids from ``start_syl_id`` to ``end_syl_id`` inclusive, in reading order.

    Phase-3 offset-free analogue of ``syllable_ids_in_range`` for an on-grid range
    whose endpoints are stored syllable-UUID anchors. For an on-grid portion
    (start anchor's start == range start, end anchor's end == range end) the two
    return the same ids. Returns ``[]`` if either anchor is absent or reversed."""
    pos = {s["id"]: i for i, s in enumerate(syllables)}
    i, j = pos.get(start_syl_id), pos.get(end_syl_id)
    if i is None or j is None or i > j:
        return []
    return [syllables[k]["id"] for k in range(i, j + 1)]
