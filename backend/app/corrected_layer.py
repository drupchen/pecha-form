"""Project the immutable syllable skeleton + accepted corrections into the
published, per-syllable *corrected* view — shared by the root and transcription
manifest/sessions exporters.

The skeleton (``syllables`` / ``transcript_syllables``) is the **original**
tokenisation and never changes. At export time we tokenise the corrected text
(raw text with accepted suggestions applied) and align it against the skeleton,
carrying every original id across and recording the original string per syllable:

- a syllable edited in place keeps its skeleton uuid; ``text`` becomes the
  corrected string, ``original`` holds the old one;
- a deleted syllable is **retained as an empty slot** (``text == ""``) so its uuid
  survives, with ``original`` holding the old string;
- a genuinely new syllable (from an insertion or a length-growing replacement)
  gets a fresh **deterministic** uuid5 and no ``original``.

This is the move-aware alignment of ``id_reconcile.assign_stable_ids`` generalised to
(a) keep deletes instead of dropping them and (b) carry the ``original`` field. A
``move`` (same text, relocated — e.g. a suggestion that reorders syllables) carries
the skeleton uuid to the new position instead of dropping it and minting a fresh one,
so main-text moves keep their identity. The mapping is fully deterministic, so
re-exporting is idempotent.

NOTE: a ``move`` makes the emitted list no longer sorted by ``orig_start``/``orig_end``
(a relocated token carries its *original* skeleton offsets to its new position). The
exporters that bisect those offsets onto the published tokens
(``manifest_exporter.build_manifest`` tag overlay, ``annotations_exporter``) must use
``original_offset_index`` below rather than assuming emit order is ascending.
"""

import uuid

from .manifest import NAMESPACE_KHYENTSE
from .token_align import align_tokens


def _mint(seed_anchor: str, k: int, text: str) -> str:
    """A deterministic uuid5 for a net-new (inserted) syllable.

    Seeded on the preceding skeleton uuid (or a layer anchor when the insert is at
    the very start) + a running per-anchor counter + the text, so the same accepted
    correction always yields the same id and never collides with a skeleton id.
    """
    return str(uuid.uuid5(NAMESPACE_KHYENTSE, f"{seed_anchor}_+{k}_{text}"))


def merge_corrected(
    original_syls: list[dict], corrected_syls: list[dict], seed_prefix: str
) -> list[dict]:
    """Align the corrected syllables against the original skeleton.

    ``original_syls`` / ``corrected_syls`` are
    ``[{idx,id,start_offset,end_offset,text,nature}]`` (corrected ids are ignored).
    Returns one ordered entry per published syllable::

        {id, text, original, nature, orig_start, orig_end, inserted}

    where ``original`` is ``None`` for inserted syllables, ``orig_start/orig_end``
    are the skeleton char-offsets (used by the exporters to bisect annotation offsets
    onto tokens — via ``original_offset_index``, which sorts them, since a ``move``
    can emit them out of order), and ``inserted`` flags net-new syllables (no tags).
    """
    old_texts = [s["text"] for s in original_syls]
    new_texts = [s["text"] for s in corrected_syls]

    out: list[dict] = []
    # Anchor + counter for deterministic minting of inserted syllables.
    seed_anchor = seed_prefix
    insert_k = 1
    # The insertion point (original offset) for net-new syllables = end of the last
    # emitted skeleton syllable, or 0 before any.
    anchor_offset = original_syls[0]["start_offset"] if original_syls else 0

    def emit_skeleton(o: dict, text: str, original: str) -> None:
        nonlocal seed_anchor, insert_k, anchor_offset
        out.append({
            "id": o["id"],
            "text": text,
            "original": original,
            "nature": o["nature"],
            "orig_start": o["start_offset"],
            "orig_end": o["end_offset"],
            "inserted": False,
        })
        seed_anchor = o["id"]
        insert_k = 1
        anchor_offset = o["end_offset"]

    def emit_inserted(c: dict) -> None:
        nonlocal insert_k
        out.append({
            "id": _mint(seed_anchor, insert_k, c["text"]),
            "text": c["text"],
            "original": None,
            "nature": c["nature"],
            "orig_start": anchor_offset,
            "orig_end": anchor_offset,
            "inserted": True,
        })
        insert_k += 1

    for op in align_tokens(old_texts, new_texts, detect_moves=True):
        if op.kind == "equal":
            o = original_syls[op.old]
            emit_skeleton(o, o["text"], o["text"])
        elif op.kind == "move":  # same text, relocated: keep id at the new position
            o = original_syls[op.old]
            emit_skeleton(o, corrected_syls[op.new]["text"], o["text"])
        elif op.kind == "replace":  # edited in place: keep id, new text
            o = original_syls[op.old]
            emit_skeleton(o, corrected_syls[op.new]["text"], o["text"])
        elif op.kind == "delete":  # retained empty slot (keeps uuid)
            o = original_syls[op.old]
            emit_skeleton(o, "", o["text"])
        elif op.kind == "insert":
            emit_inserted(corrected_syls[op.new])
    return out


def original_offset_index(
    merged: list[dict],
) -> tuple[list[int], list[int], list[int]]:
    """Sorted view of ``merge_corrected`` output for mapping *original-text* offsets
    onto published tokens, robust to ``move`` (which leaves ``merged`` no longer
    sorted by ``orig_start``). Returns ``(starts, ends, positions)`` — three aligned
    lists, sorted by original start offset, over the **non-inserted** tokens (which
    tile the original text). Bisect ``ends``/``starts`` for an annotation range, then
    map the slice back to ``merged`` indices via ``positions``."""
    rows = sorted(
        (m["orig_start"], m["orig_end"], i)
        for i, m in enumerate(merged)
        if not m["inserted"]
    )
    starts = [r[0] for r in rows]
    ends = [r[1] for r in rows]
    positions = [r[2] for r in rows]
    return starts, ends, positions
