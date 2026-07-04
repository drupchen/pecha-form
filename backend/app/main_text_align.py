"""Main-text ↔ audio alignment from a main-text SRT.

The sapche_discovery port of the legacy ``prepare_data`` base-alignment step
(``srt_sessions_1_parse.py``): given an SRT whose cues are *passages of the root
text* with audio timecodes, fuzzy-match each cue against the text's
syllables and return the matched syllable offset range + the cue's timecodes.

Each matched cue becomes a timed ``text_portion`` — the base "listen to this
passage" unit the webapp's compiled_sessions export is built from.

Matching is byte-for-byte the legacy algorithm: ``thefuzz`` (rapidfuzz backend)
``fuzz.ratio`` with a ≥85 prefix gate then a ≥80 full-window check, scanning
forward from the previous match so the alignment stays monotonic.
"""

import bisect
import re

from thefuzz import fuzz

from .manifest import load_syllables
from .tokenizer import normalize_spaces, is_yigmgo

PREFIX_LEN = 5
PREFIX_THRESHOLD = 85
FULL_THRESHOLD = 80
# When a cue matches, its own syllable count can over-/under-count the text's
# tokenisation of the same passage. Advancing the monotonic cursor by that raw count
# can overshoot into the *next* cue's start and skip it (seen in B8). After a match we
# re-estimate the true footprint by trying window lengths within ±LEN_SLACK and taking
# the best-scoring (shortest on ties), then advance the cursor by that.
LEN_SLACK = 6

# Embedded cross-reference markers some main-text SRTs carry, e.g.
# "<055 B-Nyingthig Mapu Tri_4>" — session-boundary notes that are NOT part of the
# recited text and must not pollute the fuzzy match.
_MARKER_RE = re.compile(r"<[^>]*>")
# A token counts as a real (matchable) syllable only if it contains Tibetan; this
# drops stray Latin/punctuation (e.g. a lone "a") that would otherwise inflate a
# cue's token count and push the monotonic matcher off the next cue.
_TIBETAN_RE = re.compile(r"[ༀ-࿿]")


def parse_main_text_srt(text: str) -> list[dict]:
    """Parse a main-text SRT into [{seg_id, start_tc, end_tc, text}] using pysrt."""
    import pysrt

    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    subs = pysrt.from_string(text)
    return [
        {
            "seg_id": sub.index,
            "start_tc": str(sub.start),  # "HH:MM:SS,mmm"
            "end_tc": str(sub.end),
            "text": sub.text,
        }
        for sub in subs
    ]


def _clean_cue_syllables(text: str) -> list[str]:
    """Tokenise a cue's text the same way the manifest is built (botok per line),
    dropping whitespace/empty tokens. Returns stripped syllable strings.

    Robust to SRT pollution: embedded ``<…>`` reference markers are stripped and any
    token without a Tibetan character is dropped, so cross-reference notes and stray
    Latin characters don't break (or shift) the fuzzy alignment."""
    from botok import ChunkTokenizer

    syls: list[str] = []
    for line in (text or "").split("\n"):
        line = normalize_spaces(_MARKER_RE.sub(" ", line)).strip()
        if not line:
            continue
        for nature, tok in ChunkTokenizer(line).tokenize():
            t = tok.strip()
            # Drop PUNCT too (not just SPACE): the matched window must begin/end on
            # recited text, so punctuation is left entirely to ``attribute_gaps``
            # (joins the preceding portion, yig-mgo the following). Keeping punct here
            # let a window start on a leading ``། །`` that belongs to the prior segment.
            if nature not in ("SPACE", "PUNCT") and t and _TIBETAN_RE.search(t):
                syls.append(t)
    return syls


def align_cues(conn, text_id: int, cues: list[dict]) -> list[dict]:
    """Match each main-text cue to a syllable range. Sequential (each match
    starts where the previous ended), mirroring the legacy matcher.

    cues: [{seg_id, start_tc, end_tc, text}] (e.g. from parse_main_text_srt).
    Returns one record per cue:
        {seg_id, start_tc, end_tc, matched: bool,
         start_offset, end_offset, score}  (offsets/score only when matched)
    """
    syllables = load_syllables(conn, text_id)
    # Haystack = recited text only. PUNCT (and SPACE) are excluded so a matched
    # window can never begin or end on a punctuation syllable; all punctuation is
    # attributed afterwards by ``attribute_gaps`` (preceding, yig-mgo → following).
    clean = [
        (s["start_offset"], s["end_offset"], s["text"].strip())
        for s in syllables
        if s["nature"] not in ("SPACE", "PUNCT") and s["text"].strip()
    ]
    clean_texts = [c[2] for c in clean]
    n_clean = len(clean)

    out: list[dict] = []
    last_pos = 0

    for cue in cues:
        cue_syls = _clean_cue_syllables(cue.get("text", ""))
        rec = {
            "seg_id": cue.get("seg_id"),
            "start_tc": cue.get("start_tc"),
            "end_tc": cue.get("end_tc"),
            "matched": False,
        }
        if not cue_syls:
            out.append(rec)
            continue

        n = len(cue_syls)
        cue_str = "".join(cue_syls)
        plen = min(PREFIX_LEN, n)
        prefix = "".join(cue_syls[:plen])

        best = None
        for i in range(last_pos, n_clean - plen + 1):
            win_prefix = "".join(clean_texts[i : i + plen])
            if fuzz.ratio(win_prefix, prefix) >= PREFIX_THRESHOLD:
                win_full = "".join(clean_texts[i : i + n])
                score = fuzz.ratio(cue_str, win_full)
                if score >= FULL_THRESHOLD:
                    best = (i, score)
                    break

        if best is not None:
            i, score = best
            # Re-estimate the matched window's true length so the monotonic cursor
            # advances by the text's footprint, not the cue's raw syllable count
            # (which can overshoot and skip the next cue). Search ±LEN_SLACK, keep the
            # highest ratio and the shortest length on ties (avoids overshoot).
            best_len, best_r = n, fuzz.ratio(cue_str, "".join(clean_texts[i : i + n]))
            lo = max(1, n - LEN_SLACK)
            hi = min(n_clean - i, n + LEN_SLACK)
            for L in range(lo, hi + 1):
                r = fuzz.ratio(cue_str, "".join(clean_texts[i : i + L]))
                if r > best_r:
                    best_r, best_len = r, L
            end_idx = min(i + best_len - 1, n_clean - 1)
            rec.update({
                "matched": True,
                "start_offset": clean[i][0],
                "end_offset": clean[end_idx][1],
                "score": score,
            })
            last_pos = i + best_len
        out.append(rec)

    return out


def attribute_gaps(matched: list[dict], syllables: list[dict], cues: list[dict],
                   open_pos, close_pos) -> None:
    """Make the matched portions tile the recited span, attributing the small gaps the
    fuzzy matcher leaves (a cue's own trailing punctuation / undershoot) to the
    **preceding** portion — except a leading **yig-mgo** run, which joins the
    **following** portion. Mutates ``matched`` rows' ``start_offset``/``end_offset``.

    Gaps are only closed between cues that are *adjacent* in the SRT (consecutive
    ``seg_id``); a gap spanning an *unmatched* cue is left open so it still shows as a
    coverage gap. Head/tail are extended to ``open_pos``/``close_pos`` only when the
    first/last *cue* matched (so the recited span is fully covered without absorbing a
    region that belongs to an unmatched cue)."""
    if not matched:
        return
    m = sorted(matched, key=lambda r: r["start_offset"])
    seg_ids = [c["seg_id"] for c in cues]
    first_cue, last_cue = (seg_ids[0], seg_ids[-1]) if seg_ids else (None, None)

    def gap_syllables(lo: int, hi: int) -> list[dict]:
        return [s for s in syllables if s["start_offset"] >= lo and s["end_offset"] <= hi]

    def yigmgo_split(gap: list[dict]) -> int:
        """Offset where the trailing yig-mgo run of ``gap`` starts (it joins the next
        portion); = end of the gap when there is none."""
        k = len(gap)
        while k > 0 and is_yigmgo(gap[k - 1]["text"]):
            k -= 1
        return gap[k]["start_offset"] if k < len(gap) else None

    # Interior: close the gap between each pair of adjacent matched cues.
    for a, b in zip(m, m[1:]):
        if b["seg_id"] != a["seg_id"] + 1:
            continue  # an unmatched cue lies between → leave the gap
        gap = gap_syllables(a["end_offset"], b["start_offset"])
        split = yigmgo_split(gap) if gap else None
        boundary = split if split is not None else b["start_offset"]
        a["end_offset"] = boundary
        b["start_offset"] = boundary

    # Head: if the first cue matched, pull the first portion back to the session start,
    # leaving any leading yig-mgo with it (it introduces the passage).
    if open_pos is not None and m[0]["seg_id"] == first_cue and m[0]["start_offset"] > open_pos:
        m[0]["start_offset"] = open_pos
    # Tail: if the last cue matched, extend the last portion to the session end so its
    # trailing punctuation / undershoot is covered.
    if close_pos is not None and m[-1]["seg_id"] == last_cue and m[-1]["end_offset"] < close_pos:
        m[-1]["end_offset"] = close_pos


def snap_offset_to_syllable(offset: int, syls: list[dict], starts: list[int]) -> int:
    """Snap a single boundary offset (a section marker / tree-node segment_start) onto a
    syllable edge so it never falls *inside* a syllable: a straddled punctuation joins the
    **preceding** unit (snap to its end), a **yig-mgo** the **following** (snap to its
    start). Offsets already on an edge are returned unchanged. ``syls`` is sorted by
    ``start_offset``; ``starts`` is the parallel list of start offsets (for bisect)."""
    i = bisect.bisect_right(starts, offset) - 1
    if 0 <= i < len(syls):
        s = syls[i]
        if s["start_offset"] < offset < s["end_offset"]:
            return s["start_offset"] if is_yigmgo(s["text"]) else s["end_offset"]
    return offset


def snap_section_boundary(offset: int, syls: list[dict], starts: list[int]) -> int:
    """Place a single section boundary (a sapche-section marker / tree-node
    ``segment_start``) on the syllable grid following the systemwide rule: punctuation
    joins the **preceding** section, except a **yig-mgo** head mark, which introduces —
    and so joins — the **following** section.

    ``snap_offset_to_syllable`` only fixes a boundary that lands *inside* a syllable. A
    boundary already on a syllable edge but sitting *right after* a yig-mgo run leaves
    that head mark with the previous section (the reader bug). So after snapping, pull
    the boundary back over any immediately-preceding yig-mgo run — mirroring the head
    handling in :func:`attribute_gaps` (``yigmgo_split``). ``syls`` is sorted by
    ``start_offset``; ``starts`` is the parallel list of start offsets."""
    offset = snap_offset_to_syllable(offset, syls, starts)
    i = bisect.bisect_left(starts, offset) - 1
    while 0 <= i < len(syls) and syls[i]["end_offset"] == offset and is_yigmgo(syls[i]["text"]):
        offset = syls[i]["start_offset"]
        i -= 1
    return offset


def snap_portions_to_syllables(portions: list[dict], syllables: list[dict]) -> bool:
    """Re-tile existing portions onto the current syllable grid so no syllable straddles
    a portion edge (a straddling syllable would be only partially covered → a spurious
    coverage gap). A straddling syllable joins the **preceding** portion, except a
    **yig-mgo** one which joins the **following**. Head/tail are pulled outward to cover
    a boundary syllable. Mutates ``portions`` rows' ``start_offset``/``end_offset`` and
    returns True if anything changed.

    Used after a tokenizer/space-folding upgrade re-collapses clusters (e.g. ``།␣།``):
    the offsets are unchanged but two former tokens merge into one, so an old portion
    boundary can now fall inside that merged token. This snaps the boundaries back onto
    syllable edges without needing to re-run the SRT match."""
    if not portions or not syllables:
        return False
    syls = sorted(syllables, key=lambda s: s["start_offset"])
    starts = [s["start_offset"] for s in syls]

    def straddling(x: int):
        i = bisect.bisect_right(starts, x) - 1
        if 0 <= i < len(syls) and syls[i]["start_offset"] < x < syls[i]["end_offset"]:
            return syls[i]
        return None

    p = sorted(portions, key=lambda r: r["start_offset"])
    changed = False

    for a, b in zip(p, p[1:]):
        contiguous = a["end_offset"] == b["start_offset"]
        s = straddling(a["end_offset"])
        if s is not None:
            nb = s["start_offset"] if is_yigmgo(s["text"]) else s["end_offset"]
            if nb != a["end_offset"] and nb > a["start_offset"]:
                a["end_offset"] = nb
                changed = True
                if contiguous and nb < b["end_offset"]:
                    b["start_offset"] = nb
        if not contiguous:
            s2 = straddling(b["start_offset"])
            if s2 is not None and s2["start_offset"] < b["end_offset"]:
                b["start_offset"] = s2["start_offset"]
                changed = True

    sh = straddling(p[0]["start_offset"])
    if sh is not None and sh["start_offset"] < p[0]["end_offset"]:
        p[0]["start_offset"] = sh["start_offset"]
        changed = True
    st = straddling(p[-1]["end_offset"])
    if st is not None and st["end_offset"] > p[-1]["start_offset"]:
        p[-1]["end_offset"] = st["end_offset"]
        changed = True

    return changed
