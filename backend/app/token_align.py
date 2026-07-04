"""Move-aware token-sequence alignment for stable syllable identity.

The reconcilers (`id_reconcile.assign_stable_ids`, `corrected_layer.merge_corrected`)
need to decide, for each token in a *new* sequence, which *old* token it inherits its
UUID from. Plain text diffs (``difflib``) get this wrong in two ways for Tibetan
syllables:

1. A **moved** syllable (inverted / displaced) is encoded as delete+insert, so it
   loses its identity and gets a fresh UUID.
2. **Repeated** common syllables (པ་, བ་, …) cause greedy/ambiguous matches that churn
   neighbours too.

This module fixes both:

- **Base alignment** uses RapidFuzz's ``Levenshtein.opcodes`` — an *optimal* edit
  distance (unlike difflib's non-optimal Ratcliff-Obershelp), with ``replace`` ops so
  an in-place syllable edit carries its id by position. (We benchmarked difflib,
  RapidFuzz and ``patiencediff`` each under the same move post-pass on the real
  corpus: RapidFuzz tied for the least spurious churn — 0 — while patience was
  marginally worse, so the chosen base is the most accurate *and* dependency-light,
  not merely the one already installed.)
- **Move detection** is a Heckel-style post-pass: residual deleted vs inserted tokens
  with **identical text** are re-paired as ``move`` ops, so a relocated syllable keeps
  its UUID. Duplicate identical texts are disambiguated by minimal positional
  displacement. *This post-pass does the heavy lifting; the base aligner is
  second-order once moves are detected.*

``align_tokens`` returns ordered ops (in *new*-sequence order, with deletes inline) so
both consumers can iterate once. Op kinds and how identity flows:

- ``equal``   — same text, same place → carry id (content).
- ``move``    — same text, relocated  → carry id (content).  *(detect_moves only)*
- ``replace`` — different text, same place → carry id (position = in-place edit).
- ``insert``  — genuinely new → mint.
- ``delete``  — gone → drop / retained empty slot.
"""

from collections import defaultdict
from typing import NamedTuple

from rapidfuzz.distance import Levenshtein


class Op(NamedTuple):
    kind: str          # equal | move | replace | insert | delete
    old: int | None    # index into old sequence (None for insert)
    new: int | None    # index into new sequence (None for delete)


def _match_moves(
    del_old: list[int], ins_new: list[int], old: list[str], new: list[str]
) -> tuple[set[int], dict[int, int]]:
    """Pair residual deleted tokens with residual inserted tokens of identical text
    (Heckel's move step). Returns ``(moved_old, target_to_source)`` where ``moved_old``
    is the set of old indices that moved (their delete is suppressed) and
    ``target_to_source`` maps each new index that is a move target to its old index.

    Duplicate identical texts are matched in ascending index order, which minimises
    total positional displacement (the right one of two identical syllables wins)."""
    by_text_old: dict[str, list[int]] = defaultdict(list)
    by_text_new: dict[str, list[int]] = defaultdict(list)
    for a in del_old:
        by_text_old[old[a]].append(a)
    for b in ins_new:
        by_text_new[new[b]].append(b)

    moved_old: set[int] = set()
    tgt2src: dict[int, int] = {}
    for text, olds in by_text_old.items():
        news = by_text_new.get(text)
        if not news:
            continue
        for a, b in zip(sorted(olds), sorted(news)):  # ascending → min displacement
            moved_old.add(a)
            tgt2src[b] = a
    return moved_old, tgt2src


def align_tokens(old: list[str], new: list[str], *, detect_moves: bool) -> list[Op]:
    """Align two token-text sequences into ordered identity-carrying ops.

    With ``detect_moves=True`` a relocated token is emitted as a single ``move`` (id
    carried by content) instead of delete+insert. With ``detect_moves=False`` the
    result is the classic ``equal/replace/insert/delete`` (used as a test/comparison
    baseline)."""
    opcodes = Levenshtein.opcodes(old, new).as_list()  # equal/replace/insert/delete

    moved_old: set[int] = set()
    tgt2src: dict[int, int] = {}
    if detect_moves:
        # Residual pool: delete/insert blocks + the surplus side of replace blocks.
        # Replace *overlap* pairs are genuine in-place edits, not move candidates.
        del_old: list[int] = []
        ins_new: list[int] = []
        for tag, a1, a2, b1, b2 in opcodes:
            if tag == "delete":
                del_old.extend(range(a1, a2))
            elif tag == "insert":
                ins_new.extend(range(b1, b2))
            elif tag == "replace":
                ov = min(a2 - a1, b2 - b1)
                del_old.extend(range(a1 + ov, a2))
                ins_new.extend(range(b1 + ov, b2))
        moved_old, tgt2src = _match_moves(del_old, ins_new, old, new)

    def emit_new(b: int) -> Op:
        return Op("move", tgt2src[b], b) if b in tgt2src else Op("insert", None, b)

    ops: list[Op] = []
    for tag, a1, a2, b1, b2 in opcodes:
        if tag == "equal":
            ops.extend(Op("equal", a1 + k, b1 + k) for k in range(a2 - a1))
        elif tag == "replace":
            ov = min(a2 - a1, b2 - b1)
            ops.extend(Op("replace", a1 + k, b1 + k) for k in range(ov))
            for a in range(a1 + ov, a2):
                if a not in moved_old:
                    ops.append(Op("delete", a, None))
            for b in range(b1 + ov, b2):
                ops.append(emit_new(b))
        elif tag == "delete":
            ops.extend(Op("delete", a, None) for a in range(a1, a2) if a not in moved_old)
        elif tag == "insert":
            ops.extend(emit_new(b) for b in range(b1, b2))
    return ops
