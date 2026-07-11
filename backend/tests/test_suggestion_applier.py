"""splice_suggestions (syllable-native): a zero-width insertion adjacent to a run is
applied (not an overlap error); a genuine intersection still raises. The corrected string
is the joined splice.

Part 6, Phase 3: suggestions are anchored by syllable id and applied by splicing syllable
runs — no char offsets. These tests use a synthetic single-char syllable sequence so the
splice can be exercised without a DB.

Run: `venv/bin/python tests/test_suggestion_applier.py`
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.suggestion_applier import splice_suggestions, segments_text


# Ten single-char syllables "A".."J" with ids s0..s9 tiling offsets 0..10.
SYLS = [
    {"id": f"s{i}", "idx": i + 1, "text": ch, "nature": "TEXT",
     "start_offset": i, "end_offset": i + 1}
    for i, ch in enumerate("ABCDEFGHIJ")
]


def _repl(start, end, text, created=""):
    """Replace/delete the inclusive syllable run [s{start}..s{end}]."""
    return {"start_syl_id": f"s{start}", "end_syl_id": f"s{end}",
            "suggested_text": text, "created_at": created}


def _ins(before, text, created=""):
    """Zero-width insertion before syllable s{before}."""
    return {"start_syl_id": f"s{before}", "end_syl_id": None,
            "suggested_text": text, "created_at": created}


def _apply(suggestions):
    return segments_text(splice_suggestions(SYLS, suggestions))


def test_insertion_at_region_start_applies_before():
    # Replace [s5..s7] ("FGH") with "Y" and insert "X" before s5 → "ABCDEXYIJ".
    # created_at makes the replacement sort first by time; the insertion must still be
    # ordered ahead of it because it is zero-width at the same start syllable.
    out = _apply([_repl(5, 7, "Y", "t1"), _ins(5, "X", "t2")])
    assert out == "ABCDEXYIJ", out


def test_insertion_at_region_end_applies_after():
    # Replace [s5..s7] with "Y" and insert "X" before s8 (just past the run) → "ABCDEYXIJ".
    out = _apply([_repl(5, 7, "Y", "t1"), _ins(8, "X", "t2")])
    assert out == "ABCDEYXIJ", out


def test_insertion_strictly_inside_region_is_skipped():
    # An insertion strictly inside a replacement can't be placed → dropped on read (the
    # replacement still applies). Resilience: one bad suggestion never blanks the doc.
    out = _apply([_repl(5, 7, "Y"), _ins(6, "X")])
    assert out == "ABCDEYIJ", out


def test_two_regions_overlap_skips_the_later_one():
    # Two intersecting runs: the first (by start, then created_at) is applied, the
    # overlapping one is skipped rather than raising.
    out = _apply([_repl(5, 7, "Y"), _repl(7, 9, "Z")])
    assert out == "ABCDEYIJ", out


def test_pure_deletion_removes_the_run():
    out = _apply([_repl(5, 7, "")])
    assert out == "ABCDEIJ", out


def test_no_suggestions_is_identity():
    assert _apply([]) == "ABCDEFGHIJ"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
