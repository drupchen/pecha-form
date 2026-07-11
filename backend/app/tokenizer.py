import unicodedata


# Tsek variants folded to the regular intersyllabic tsek U+0F0B (``་``):
#   U+0F0C TSHEG BSTAR (non-breaking tsek).
_TSEK_FOLD = {"༌": "་"}

TSEK = "་"  # U+0F0B — the Tibetan intersyllabic tsek (syllable separator)

# Yig-mgo (head marks), U+0F04–U+0F0A: ༄ ༅ ༆ ༇ ༈ ༉ ༊, plus U+0F3C ༼ (gug rtags gyon, the
# opening bracket). Unlike a closing shad, these *introduce*/open the text that follows, so a
# PUNCT syllable made of them joins the FOLLOWING segment rather than the preceding one — and
# a cluster like ``༔ ༼`` splits so ``༼`` starts its own syllable.
_YIGMGO = set("༄༅༆༇༈༉༊༼")
# Shad family that may trail a yig-mgo within one opening cluster (e.g. ``༄༅། །``).
_SHAD_FAMILY = set("།༎༏༐༑༔༴")


def is_yigmgo(text: str) -> bool:
    """True if ``text`` is a yig-mgo (head-mark) punctuation syllable: it **starts** with a
    yig-mgo and is all punctuation (yig-mgo or shad family). A head mark *introduces* the
    text that follows — and the trailing shads of an opening flourish (``༄༅། །``) go with
    it — so attribution attaches such a syllable to the FOLLOWING segment, not the previous.
    The leading-yig-mgo test (not "all chars are yig-mgo") pairs with the tokenizer splitting
    a cluster at the first yig-mgo (see ``split_text_at_yigmgo``), so the from-``༄`` part is
    recognised even though it carries shads."""
    core = [c for c in text if not c.isspace()]
    return bool(core) and core[0] in _YIGMGO and all(c in _YIGMGO or c in _SHAD_FAMILY for c in core)


def split_text_at_yigmgo(text: str) -> list[str]:
    """Split a punctuation token at the first yig-mgo so a closing mark is never glued to an
    opening one. Everything *before* the first ``༄`` (U+0F04–U+0F0A) is one piece (joins the
    preceding); everything *from* ``༄`` onward is a second piece (joins the following). A
    token with no yig-mgo, or one already starting with yig-mgo, is returned unchanged.
    Splitting is offset-neutral: the two pieces concatenate back to ``text``."""
    i = next((k for k, c in enumerate(text) if c in _YIGMGO), -1)
    return [text[:i], text[i:]] if i > 0 else [text]


def split_units_at_yigmgo(units: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Apply :func:`split_text_at_yigmgo` to a tiling of ``(start, end, text)`` units,
    keeping offsets exact (the split point lands inside the unit)."""
    out: list[tuple[int, int, str]] = []
    for s, e, t in units:
        parts = split_text_at_yigmgo(t)
        if len(parts) == 1:
            out.append((s, e, t))
        else:
            out.append((s, s + len(parts[0]), parts[0]))
            out.append((s + len(parts[0]), e, parts[1]))
    return out


def norm_syllable(s: str) -> str:
    """Normalise a syllable for equality comparison: NFC, drop surrounding
    whitespace and any trailing tsek so ``བཀྲ`` matches a tokenised ``བཀྲ་``."""
    return unicodedata.normalize("NFC", s).strip().rstrip(TSEK).strip()


def normalize_spaces(text: str) -> str:
    """Map Unicode space separators (U+00A0 NO-BREAK SPACE, etc.) to plain
    U+0020. Length-preserving (1 char -> 1 char) so character offsets — and thus
    existing annotations — are unaffected. Newlines and tabs (category Cc) are
    left alone.

    botok's ChunkTokenizer classifies U+00A0 as LATIN rather than whitespace,
    which shatters punctuation clusters (``། །`` -> ``།`` / `` `` / ``།``).
    Folding these to a plain space lets botok join the cluster into one token.
    Also folds the tsek variant U+0F0C (tsheg bstar) to the regular tsek U+0F0B
    so all tseks tokenize uniformly.
    """
    return "".join(
        " " if (unicodedata.category(c) == "Zs" and c != " ")
        else _TSEK_FOLD.get(c, c)
        for c in text
    )


# Tibetan punctuation that bounds a "cluster" for the cross-newline fold: shad family
# (defined below as TIB_PUNCT) + the yig-mgo head marks. A newline whose nearest
# non-space neighbour on BOTH sides is one of these is interior to a punctuation cluster.
_CLUSTER_PUNCT = set("།༎༏༐༑༔༴") | _YIGMGO
_FOLD_SPACE = (" ", "\t", "\n")


def fold_punct_newlines(text: str) -> str:
    """Fold a newline to a regular space **only when it sits inside a punctuation
    cluster** — i.e. the nearest non-space character on each side is Tibetan punctuation
    (shad family or yig-mgo). So ``།\\n།`` becomes ``། །`` (one PUNCT syllable once
    tokenised) while a newline in prose stays a line break.

    Length-preserving (each folded ``\\n`` → one space), so character offsets — and thus
    existing offset-based annotations — are unaffected. Run-collapsing (several spaces →
    one) is deliberately NOT done here; it shortens text and is deferred to the
    syllable-first migration."""
    chars = list(text)
    n = len(chars)
    for i, c in enumerate(chars):
        if c != "\n":
            continue
        j = i - 1
        while j >= 0 and chars[j] in _FOLD_SPACE:
            j -= 1
        k = i + 1
        while k < n and chars[k] in _FOLD_SPACE:
            k += 1
        if 0 <= j and k < n and chars[j] in _CLUSTER_PUNCT and chars[k] in _CLUSTER_PUNCT:
            chars[i] = " "
    return "".join(chars)


def merge_whitespace_units(raw_units: list[tuple[int, int]], text: str) -> list[tuple[int, int, str]]:
    """Fold whitespace-only units into their preceding neighbor.
    If whitespace appears at index 0, fold it into the following unit instead.
    Empty lines (\n\n) are whitespace-only and follow the same rule: they go to preceding.
    """
    out: list[tuple[int, int]] = []
    i = 0
    while i < len(raw_units):
        s, e = raw_units[i][:2]
        if text[s:e].strip() == "":
            if out:
                ps, _ = out[-1]
                out[-1] = (ps, e)
            elif i + 1 < len(raw_units):
                ns, ne = raw_units[i + 1][:2]
                out.append((s, ne))
                i += 2
                continue
            else:
                out.append((s, e))  # degenerate: text is only whitespace
        else:
            out.append((s, e))
        i += 1
    # Split any unit at the first yig-mgo so a closing mark is never glued to an opening
    # one (matches the uuid layer's tile_line). Shared by both editor-unit tokenizers.
    return split_units_at_yigmgo([(s, e, text[s:e]) for s, e in out])


def tokenize_tibetan(raw_text: str) -> list[tuple[int, int, str]]:
    """Tokenize using botok, treating \\n as a hard unit boundary.

    Botok with space_as_punct=False absorbs \\n into the preceding chunk,
    which can merge end-of-line punctuation with start-of-next-line punctuation.
    To prevent this, we split the text line-by-line (keepends=True so each
    fragment ends with its own \\n), tokenize each fragment independently,
    then combine with global offsets before running merge_whitespace_units.
    Empty lines (\\n-only fragments) become whitespace units that get folded
    into the preceding unit, satisfying 'empty lines belong to preceding unit'.
    """
    try:
        from botok.tokenizers.simpletokenizer import SimpleTokenizer
        raw: list[tuple[int, int]] = []
        offset = 0
        for line in raw_text.splitlines(keepends=True):
            line_tokens = SimpleTokenizer.tokenize(line, space_as_punct=False)
            for t in line_tokens:
                raw.append((offset + t.start, offset + t.start + t.len))
            offset += len(line)
        return merge_whitespace_units(raw, raw_text)
    except ImportError:
        return simple_syllable_tokenize(raw_text)


TSEK = "\u0F0B"
# Shad family + yig-mgo head marks (U+0F04–U+0F0A) so the no-botok fallback groups a
# head mark into the same PUNCT cluster botok would.
TIB_PUNCT = set("།༎༏༐༑༔༴") | _YIGMGO


def simple_syllable_tokenize(text: str) -> list[tuple[int, int, str]]:
    """Fallback tokenizer when botok is unavailable. Also breaks at \\n."""
    raw: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        start = i
        ch = text[i]
        if ch == '\n':
            # Newline: single-char unit so it always forms its own boundary
            i += 1
        elif ch.isspace():
            while i < n and text[i].isspace() and text[i] != '\n':
                i += 1
        elif ch in TIB_PUNCT:
            while i < n and text[i] in TIB_PUNCT:
                i += 1
        else:
            while i < n and text[i] not in TIB_PUNCT and text[i] != TSEK and not text[i].isspace():
                i += 1
            while i < n and text[i] == TSEK:
                i += 1
        raw.append((start, i))

    return merge_whitespace_units(raw, text)


def prepare_and_tokenize(upload_text: str) -> tuple[str, list[tuple[int, int, str]]]:
    """1. NFC-normalize / fold. 2. Partition into syllables and project to units.
    Returns (raw_text, units).

    Part 6, Phase 2: units are now a projection of the *syllable* partition
    (``manifest.generate_syllables``) — the one and only tokenisation of a text —
    rather than a second, independent ``tokenize_tibetan`` pass that could disagree
    with the syllables at a boundary (the last-segment tagging bug). Instance ids do
    not affect the offsets/text of the partition, so a throwaway id is fine here; the
    persisted syllables use the text's real instance_id but yield the same units."""
    from .manifest import generate_syllables, units_from_syllables

    raw_text = fold_punct_newlines(normalize_spaces(unicodedata.normalize("NFC", upload_text)))
    units = units_from_syllables(generate_syllables(raw_text, "instance"))
    return raw_text, units
