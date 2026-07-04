"""apply_suggestions: a zero-width insertion adjacent to a region is applied (not an
overlap error); a genuine intersection still raises.

Run: `venv/bin/python tests/test_suggestion_applier.py`
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.suggestion_applier import apply_suggestions


def _sug(s, e, text, created=""):
    return {"start_offset": s, "end_offset": e, "suggested_text": text, "created_at": created}


def test_insertion_at_region_start_applies_before():
    # ABCDEFGHIJ: insert "X" at 5, replace [5,8] "FGH" with "Y" → "ABCDEXY IJ" sans space.
    text = "ABCDEFGHIJ"
    # created_at deliberately makes the replacement sort first by time; the insertion must
    # still be ordered ahead of it because it is zero-width at the same offset.
    out, _ = apply_suggestions(text, [_sug(5, 8, "Y", "t1"), _sug(5, 5, "X", "t2")])
    assert out == "ABCDEXYIJ", out


def test_insertion_at_region_end_applies_after():
    text = "ABCDEFGHIJ"
    out, _ = apply_suggestions(text, [_sug(5, 8, "Y", "t1"), _sug(8, 8, "X", "t2")])
    assert out == "ABCDEYXIJ", out


def test_insertion_strictly_inside_region_raises():
    text = "ABCDEFGHIJ"
    try:
        apply_suggestions(text, [_sug(5, 8, "Y"), _sug(6, 6, "X")])
        assert False, "expected overlap error"
    except ValueError:
        pass


def test_two_regions_overlap_raises():
    text = "ABCDEFGHIJ"
    try:
        apply_suggestions(text, [_sug(5, 8, "Y"), _sug(7, 9, "Z")])
        assert False, "expected overlap error"
    except ValueError:
        pass


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
