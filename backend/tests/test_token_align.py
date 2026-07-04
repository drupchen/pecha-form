"""Tests for the move-aware token aligner (`app.token_align`) and the identity
carry it gives `id_reconcile.assign_stable_ids`.

Run: `python tests/test_token_align.py` (plain asserts, no pytest needed).
"""
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.token_align import align_tokens
from app.id_reconcile import assign_stable_ids


def _kinds(a, b, detect_moves=True):
    return [(o.kind, o.old, o.new) for o in align_tokens(a, b, detect_moves=detect_moves)]


def _carry(old_texts, new_texts):
    """Simulate persist: existing rows carry ids 'o0','o1',... ; fresh rows start with
    placeholder ids. Returns the fresh ids after reconciliation."""
    existing = [{"id": f"o{i}", "text": t} for i, t in enumerate(old_texts)]
    fresh = [{"id": f"new{i}", "text": t} for i, t in enumerate(new_texts)]
    assign_stable_ids(existing, fresh, mint=lambda: "MINT")
    return [f["id"] for f in fresh]


def test_equal_passthrough():
    assert _carry(["a", "b", "c"], ["a", "b", "c"]) == ["o0", "o1", "o2"]


def test_in_place_edit_keeps_id():
    # b -> x : the edited syllable keeps its identity (replace), neighbours stable
    assert _carry(["a", "b", "c"], ["a", "x", "c"]) == ["o0", "o1", "o2"]


def test_insert_only_new_mints():
    out = _carry(["a", "b", "c"], ["a", "b", "NEW", "c"])
    assert out == ["o0", "o1", "MINT", "o2"]


def test_delete_drops():
    assert _carry(["a", "b", "c"], ["a", "c"]) == ["o0", "o2"]


def test_adjacent_swap_keeps_both():
    # A B -> B A : both syllables keep their UUID (was: difflib churned one)
    out = _carry(["A", "B"], ["B", "A"])
    assert out == ["o1", "o0"], out


def test_displacement_keeps_moved_block():
    # move 'b' to the end across 5 syllables -> b keeps id, all others stable
    old = ["a", "b", "c", "d", "e", "f", "g"]
    new = ["a", "c", "d", "e", "f", "g", "b"]
    out = _carry(old, new)
    assert out == ["o0", "o2", "o3", "o4", "o5", "o6", "o1"], out


def test_displacement_two_block_both_directions():
    old = list("a b c d e f g h i j".split())
    # move the 2-block [c d] five later (to after i)
    new = list("a b e f g h i c d j".split())
    out = _carry(old, new)
    # c,d (o2,o3) relocated but preserved; everyone else stable
    assert out == ["o0", "o1", "o4", "o5", "o6", "o7", "o8", "o2", "o3", "o9"], out


def test_repeated_syllables_minimal_churn():
    # dropping one of three identical 'pa' should preserve the two survivors' ids and
    # only drop one — no churn of the surrounding unique anchors.
    old = ["x", "pa", "pa", "pa", "y"]
    new = ["x", "pa", "pa", "y"]
    out = _carry(old, new)
    assert out[0] == "o0" and out[-1] == "o4"
    # two of the three pa-ids survive
    survived = {i for i in ("o1", "o2", "o3") if i in out}
    assert len(survived) == 2, out


def test_detect_moves_false_is_classic():
    # with move detection off, a swap degrades to delete+insert (no 'move' kind)
    kinds = {k for k, _o, _n in _kinds(["A", "B"], ["B", "A"], detect_moves=False)}
    assert "move" not in kinds


def test_first_ingest_keeps_fresh_ids():
    fresh = [{"id": "f0", "text": "a"}]
    assign_stable_ids([], fresh)
    assert fresh[0]["id"] == "f0"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
