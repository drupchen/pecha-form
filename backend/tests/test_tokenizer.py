"""§13: Tokenizer tests.

Round-trip tests on real sadhana excerpts. Verifies every item in §5:
- units[0].start == 0
- units[-1].end == len(raw_text)
- units[k].end == units[k+1].start for all k
- "".join(u.text for u in units) == raw_text
- No unit's text is whitespace-only

Test inputs cover: leading whitespace, trailing whitespace, double spaces
between syllables, spaces between a shad and the following syllable.
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

from app.tokenizer import prepare_and_tokenize, simple_syllable_tokenize, normalize_spaces
from app.manifest import generate_syllables, tile_line
# (The transcript-import tests that lived here exercised app/transcript_manifest.py,
# a sapche_discovery module that was never ported — transcripts are not a pecha-form
# feature. They were dropped with the module, not skipped.)


def run_invariant_tests(text: str, units: list):
    """Assert all five items of the §5 boundary invariant."""
    assert len(units) > 0, "Units should not be empty"
    assert units[0][0] == 0, f"First unit must start at 0, got {units[0][0]}"
    assert units[-1][1] == len(text), (
        f"Last unit must end at {len(text)}, got {units[-1][1]}"
    )
    
    # Contiguous coverage
    for k in range(len(units) - 1):
        assert units[k][1] == units[k+1][0], (
            f"Gap or overlap between unit {k} (end={units[k][1]}) "
            f"and unit {k+1} (start={units[k+1][0]})"
        )
        
    # Concatenation
    assert "".join(u[2] for u in units) == text, "Boundary invariant failed on concatenation"
    
    # No whitespace-only units — EXCEPT pure-newline units, which are deliberate:
    # newlines survive tokenization as standalone SPACE units so the display-break
    # machinery can render and edit line breaks (see generate_syllables' newline
    # assertion below). Bare spaces must still never form a unit of their own.
    for s, e, t in units:
        assert t.strip() != "" or t.strip("\n") == "", (
            f"Whitespace-only unit at [{s}:{e}]: {repr(t)}"
        )


# ── Real sadhana excerpts ──────────────────────────────────────────────

SADHANA_EXCERPT_1 = """སྐྱབས་སེམས།
ན་མོ།  བླ་མ་སངས་རྒྱས་ཆོས་དང་ཚོགས། །
དཔལ་ལྡན་བླ་མའི་ཞབས་ལ་ཕྱག་འཚལ་ལོ།"""

SADHANA_EXCERPT_2 = """བྱང་ཆུབ་སེམས་བསྐྱེད། སེམས་ཅན་ཐམས་ཅད་བདེ་བ་དང་བདེ་བའི་རྒྱུ་དང་ལྡན་པར་གྱུར་ཅིག"""

SADHANA_EXCERPT_3 = """  ཨོཾ་ཨཱཿཧཱུྃ། བཛྲ་གུ་རུ་པདྨ་སིདྡྷི་ཧཱུྃ།  """  # leading + trailing whitespace

SADHANA_EXCERPT_4 = """སྨོན་ལམ། །དགེ་བ་འདི་ཡིས་མྱུར་དུ་བདག །བླ་མ་སངས་རྒྱས་འགྲུབ་གྱུར་ནས། །"""

SADHANA_EXCERPT_5 = """བསྒྲུབས་ སྐྱེ་ རྒྱུས་"""  # double space between syllables

# Edge cases from spec
EDGE_LEADING_WHITESPACE = "  བཀྲ་ཤིས་བདེ་ལེགས།  "
EDGE_DOUBLE_SPACE = "བཀྲ་ཤིས་  བདེ་ལེགས།"
EDGE_SHAD_SPACE = "སྐྱབས་འགྲོ། བྱང་ཆུབ་སེམས་བསྐྱེད།"
EDGE_MIXED_SCRIPT = "Hello བཀྲ་ཤིས་ world"


def test_tokenizer_sadhana_excerpts():
    """§13: at least five real sadhana excerpts with the Botok tokenizer."""
    for case in [
        SADHANA_EXCERPT_1,
        SADHANA_EXCERPT_2,
        SADHANA_EXCERPT_3,
        SADHANA_EXCERPT_4,
        SADHANA_EXCERPT_5,
    ]:
        raw_text, units = prepare_and_tokenize(case)
        run_invariant_tests(raw_text, units)


def test_tokenizer_edge_cases():
    """§13: leading/trailing whitespace, double spaces, shad+space, mixed script."""
    for case in [
        EDGE_LEADING_WHITESPACE,
        EDGE_DOUBLE_SPACE,
        EDGE_SHAD_SPACE,
        EDGE_MIXED_SCRIPT,
    ]:
        raw_text, units = prepare_and_tokenize(case)
        run_invariant_tests(raw_text, units)


def test_fallback_tokenizer_sadhana_excerpts():
    """§13: parallel tests for the fallback simple_syllable_tokenize."""
    for case in [
        SADHANA_EXCERPT_1,
        SADHANA_EXCERPT_2,
        SADHANA_EXCERPT_3,
        SADHANA_EXCERPT_4,
        SADHANA_EXCERPT_5,
    ]:
        units = simple_syllable_tokenize(case)
        run_invariant_tests(case, units)


def test_fallback_tokenizer_edge_cases():
    for case in [
        EDGE_LEADING_WHITESPACE,
        EDGE_DOUBLE_SPACE,
        EDGE_SHAD_SPACE,
        EDGE_MIXED_SCRIPT,
    ]:
        units = simple_syllable_tokenize(case)
        run_invariant_tests(case, units)


# -- No-break space normalisation -------------------------------------------

NBSP = "\u00a0"   # U+00A0 NO-BREAK SPACE
NNBSP = "\u202f"  # U+202F NARROW NO-BREAK SPACE


def test_normalize_spaces_is_length_preserving():
    """Zs separators (U+00A0, U+202F) map to U+0020, 1:1, leaving \n and \t."""
    src = "abc" + NBSP + "de" + NNBSP + "f\n\tg"
    out = normalize_spaces(src)
    assert len(out) == len(src), "normalize_spaces must be length-preserving"
    assert NBSP not in out and NNBSP not in out
    assert out == "abc de f\n\tg"  # newline and tab untouched


def test_normalize_spaces_folds_tsheg_bstar():
    """U+0F0C (tsheg bstar, non-breaking tsek) folds to the regular tsek U+0F0B,
    1:1 (length-preserving); the regular tsek is left untouched."""
    src = "ཡང" + "༌" + "།" + "ལུས" + "་"
    out = normalize_spaces(src)
    assert len(out) == len(src)
    assert "༌" not in out
    assert out == "ཡང" + "་" + "།" + "ལུས" + "་"


def test_nbsp_punctuation_joins_into_single_syllable():
    """The reported bug: U+00A0 between shads must not explode the punctuation
    cluster. After normalisation each cluster is one PUNCT and no whitespace
    LATIN token survives. Standalone newlines stay their own SPACE syllables
    (the webapp renders them as <br>)."""
    # Built with real U+00A0 between the shads, exactly like the source docs.
    raw = normalize_spaces(
        "༄༅།" + NBSP + "།"          # yig-mgo + shad NBSP shad
        + "རྫོགས་པ་\n"
        + "བཞུགས་སོ"
        + "།།" + NBSP + "།།" + "\n\n"
        + "༄༅།" + NBSP + "།"
        + "ན་མོ"
    )
    syls = generate_syllables(raw, "test_instance")

    # Tiling invariant still holds after normalisation.
    assert "".join(s["text"] for s in syls) == raw
    assert syls[0]["start_offset"] == 0
    assert syls[-1]["end_offset"] == len(raw)

    puncts = [s["text"] for s in syls if s["nature"] == "PUNCT"]
    assert "༄༅། །" in puncts          # opening yig-mgo cluster
    assert "།། །།" in puncts          # double-shad cluster
    # No syllable is a bare no-break/space LATIN fragment.
    assert not any(s["nature"] == "LATIN" and s["text"].strip() == "" for s in syls)
    # Newlines survive as standalone SPACE syllables.
    assert any(s["nature"] == "SPACE" and s["text"] == "\n" for s in syls)


def test_tile_line_gathers_extra_tsek_runs():
    """A maximal run of >=2 tseks (a transcriber's missing-audio mark) becomes one
    standalone PUNCT chunk, never merged into a neighbour; tiling stays exact even
    when botok would drop a leading tsek run."""
    cases = {
        # leading run -> own PUNCT syllable, then normal syllables
        "་་་་་ལུས་ལས་": [("PUNCT", "་་་་་"), ("TEXT", "ལུས་"), ("TEXT", "ལས་")],
        # trailing run -> `རྩ` and `་་་་` are SEPARATE (not merged)
        "ནང་གི་རྩ་་་་": [("TEXT", "ནང་"), ("TEXT", "གི་"), ("TEXT", "རྩ"), ("PUNCT", "་་་་")],
        # pure run
        "་་་་": [("PUNCT", "་་་་")],
        # lone leading tsek (run of 1) is recovered as its own PUNCT filler
        "་ལུས": [("PUNCT", "་"), ("TEXT", "ལུས")],
        # ordinary line is left exactly as botok produces it
        "ལུས་ལས": [("TEXT", "ལུས་"), ("TEXT", "ལས")],
    }
    for line, expected in cases.items():
        got = tile_line(line)
        # Always tiles the line exactly.
        assert "".join(t for _, t in got) == line, f"{line!r} -> {got!r}"
        assert got == expected, f"{line!r} -> {got!r} (expected {expected!r})"
