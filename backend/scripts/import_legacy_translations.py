"""One-time import (Phase T3): seed translations + phonetics from the legacy
Google-Sheets booklets into the canonical chunk store.

The legacy sheet (downloaded published HTML in ``input/<stem>_<lang>.tsv``) is a
table ``hub | Tibetan- no phonetics | Translation | Tibetan | Phonetics |
Sanskrit [| Sanskrit phonetics]``. A ``hub`` cell starting with ``|`` (or a title
marker T/sub/t1/t2) opens a SEGMENT; following rows with a blank hub continue it;
blank rows separate verses. Each row is one LINE (tib + phonetics + translation).

Import strategy:
- Parse segments; join each segment's Tibetan; align it against the target text's
  COMPOSED stream by whitespace-stripped exact search first (sequential cursor),
  then rapidfuzz ``partial_ratio_alignment`` on a window as fallback.
- Segment → translation chunk (find-or-create, canonicalized at the owner text —
  the ripple model) + one translation row per language; title segments also set
  the chunk's heading level.
- Each LINE aligns inside its segment's span → one ``phonetics`` row (kind 'bo'
  from the Phonetics column, 'skt' from Sanskrit phonetics on mantra segments),
  status 'reviewed' (these shipped in print).

Run:  cd backend && .venv/bin/python scripts/import_legacy_translations.py rpn_long en 33
Idempotent: chunks/translations/phonetics upsert on conflict.
"""
import argparse
import html as html_mod
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString
from rapidfuzz import fuzz

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.db import get_db, init_db                      # noqa: E402
from app.derivation import base_tokens                  # noqa: E402
from app.routers.translations import (                  # noqa: E402
    _find_or_create_chunk, _sanitize_body,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TITLE_LEVELS = {"T": 1, "sub": 2, "t1": 2, "t2": 3}
FUZZY_THRESHOLD = 75.0

_ws = re.compile(r"\s+")


def clean(s: str) -> str:
    return _ws.sub("", s or "")


# ─── Sheet parsing ───────────────────────────────────────────────────────────────

def cell_html(td) -> str:
    """A translation cell as our sanitized HTML subset (bold/italic from spans)."""
    parts: list = []

    def walk(el, bold=False, italic=False):
        if isinstance(el, NavigableString):
            t = str(el)
            # Strip the legacy /type-text/ inline sub-typing markers from the TEXT
            # (never from HTML — slashes there are closing tags).
            t = re.sub(r"/([^/-]+)-", "", t).replace("/", "")
            if t:
                h = html_mod.escape(t)
                if bold:
                    h = f"<strong>{h}</strong>"
                if italic:
                    h = f"<em>{h}</em>"
                parts.append(h)
            return
        style = el.attrs.get("style", "") if el.attrs else ""
        b = bold or "bold" in style
        i = italic or "italic" in style
        for c in el.children:
            walk(c, b, i)

    cls = td.attrs.get("class", [""])[0] if td.attrs else ""
    for c in td.children:
        walk(c, italic=(cls == "s4"))
    return "".join(parts).strip()


def parse_sheet(path: Path):
    """Yield segments: {type, lines: [{tib, phon, skt, trans_html}]}."""
    soup = BeautifulSoup(path.read_text(), "html.parser")
    table = soup.find("table")
    if not table:
        raise SystemExit(f"No table in {path}")
    rows = []
    for tr in table.find_all("tr"):
        tds = tr.find_all(["td", "th"])
        rows.append(([td.get_text(strip=True) for td in tds], tds))
    headers = rows[1][0]
    col = {}
    for idx, h in enumerate(headers):
        h = h.strip()
        if h == "hub":
            col["hub"] = idx
        elif h == "Tibetan":
            col["tib"] = idx
        elif h == "Tibetan- no phonetics":
            # Titles and small-letter instructions (not recited → no phonetics)
            # carry their Tibetan here instead of the Tibetan column.
            col["tib_nophon"] = idx
        elif h == "Translation":
            col["trans"] = idx
        elif h == "Phonetics":
            col["phon"] = idx
        elif h == "Sanskrit phonetics":
            col["skt"] = idx
        elif h == "Sanskrit" and "skt" not in col:
            col["skt_fallback"] = idx
    if "hub" not in col or "tib" not in col:
        raise SystemExit(f"Missing hub/Tibetan columns in {path}: {headers}")

    def get(cells, key):
        i = col.get(key)
        return cells[i] if i is not None and i < len(cells) else ""

    segments = []
    cur = None
    for cells, tds in rows[2:]:
        hub = get(cells, "hub").strip()
        opens = hub.startswith("|") or hub in TITLE_LEVELS
        if opens:
            if cur and cur["lines"]:
                segments.append(cur)
            cur = {"type": hub.strip("|"), "lines": []}
        if cur is None:
            cur = {"type": "n", "lines": []}
        tib = get(cells, "tib") or get(cells, "tib_nophon")
        if not tib.strip() and not get(cells, "trans").strip():
            continue  # blank spacer row
        ti = col.get("trans")
        trans_html = cell_html(tds[ti]) if ti is not None and ti < len(tds) else ""
        cur["lines"].append({
            "tib": tib,
            "phon": get(cells, "phon"),
            "skt": get(cells, "skt") or get(cells, "skt_fallback"),
            "trans_html": trans_html,
        })
    if cur and cur["lines"]:
        segments.append(cur)
    return segments


# ─── Alignment ───────────────────────────────────────────────────────────────────

class StreamIndex:
    """The composed stream as a whitespace-stripped string with a map back to
    token indexes, for exact + fuzzy locating of sheet Tibetan."""

    def __init__(self, tokens):
        self.tokens = tokens
        chars, owner = [], []
        for ti, t in enumerate(tokens):
            for ch in t["text"]:
                if not ch.isspace():
                    chars.append(ch)
                    owner.append(ti)
        self.clean = "".join(chars)
        self.owner = owner

    def locate(self, needle_clean: str, cursor: int):
        """(start_char, end_char, how) in clean space, or None. Searches from
        ``cursor`` first (sequential documents), then anywhere, then fuzzy."""
        if not needle_clean:
            return None
        at = self.clean.find(needle_clean, cursor)
        if at < 0:
            at = self.clean.find(needle_clean)
        if at >= 0:
            return at, at + len(needle_clean), "exact"
        # Fuzzy: window from cursor first (documents are mostly sequential), then
        # the whole stream (segments can sit out of order relative to the sheet).
        w_start = max(0, cursor - 200)
        w_end = min(len(self.clean), cursor + len(needle_clean) * 3 + 2000)
        window = self.clean[w_start:w_end]
        res = fuzz.partial_ratio_alignment(needle_clean, window)
        if res is not None and res.score >= FUZZY_THRESHOLD:
            return w_start + res.dest_start, w_start + res.dest_end, "fuzzy"
        res = fuzz.partial_ratio_alignment(needle_clean, self.clean)
        if res is not None and res.score >= FUZZY_THRESHOLD:
            return res.dest_start, res.dest_end, "fuzzy"
        return None

    def token_range(self, c_start: int, c_end: int):
        ti_start = self.owner[c_start]
        ti_end = self.owner[min(c_end - 1, len(self.owner) - 1)]
        return self.tokens[ti_start]["id"], self.tokens[ti_end]["id"]


# ─── Import ──────────────────────────────────────────────────────────────────────

def import_sheet(stem: str, lang: str, text_id: int, dry: bool = False):
    path = REPO_ROOT / "input" / f"{stem}_{lang}.tsv"
    if not path.exists():
        raise SystemExit(f"Sheet not found: {path}")
    segments = parse_sheet(path)

    conn = get_db()
    tokens = base_tokens(conn, text_id)
    if not tokens:
        raise SystemExit(f"Text {text_id} has no tokens")
    idx = StreamIndex(tokens)

    stats = {"segments": len(segments), "exact": 0, "fuzzy": 0, "skipped": 0,
             "translations": 0, "levels": 0, "phon": 0, "skt": 0, "titles": 0}
    skipped: list = []
    cursor = 0
    # Translation-only segments (no Tibetan at all) are EXPLICIT TITLES — implied
    # in the Tibetan, made explicit in translation: exactly the scramble layer's
    # title chunks. They queue until the next matched segment provides an anchor.
    pending_titles: list = []

    def flush_titles(anchor_syl):
        """Titles pending at one anchor pair BY INDEX with the title layouts already
        at that anchor (created by another language's run or a rerun) — the lang
        body is upserted onto the shared layout; missing ones are created."""
        if not pending_titles:
            return
        existing = [] if dry else conn.execute(
            "SELECT id FROM chunk_layouts WHERE kind = 'title' AND text_id IS NULL "
            "AND anchor_syl_id IS ? ORDER BY position, id", (anchor_syl,)).fetchall()
        for i, t_seg in enumerate(pending_titles):
            body = "".join(
                f"<p>{ln['trans_html']}</p>" for ln in t_seg["lines"] if ln["trans_html"].strip())
            if not body:
                continue
            level = TITLE_LEVELS.get(t_seg["type"], 3)
            stats["titles"] += 1
            if dry:
                continue
            if i < len(existing):
                layout_id = existing[i]["id"]
            else:
                layout_id = conn.execute(
                    "INSERT INTO chunk_layouts (text_id, kind, anchor_syl_id, level, position) "
                    "VALUES (NULL, 'title', ?, ?, "
                    "(SELECT COALESCE(MAX(position), 0) + 1 FROM chunk_layouts))",
                    (anchor_syl, level)).lastrowid
            conn.execute(
                "INSERT INTO layout_titles (layout_id, lang, body) VALUES (?, ?, ?) "
                "ON CONFLICT(layout_id, lang) DO UPDATE SET body = excluded.body, "
                "updated_at = CURRENT_TIMESTAMP",
                (layout_id, lang, _sanitize_body(body)))
        pending_titles.clear()

    for seg in segments:
        tib_all = clean("".join(ln["tib"] for ln in seg["lines"]))
        if not tib_all:
            pending_titles.append(seg)
            continue
        loc = idx.locate(tib_all, cursor)
        if not loc:
            stats["skipped"] += 1
            skipped.append((seg["type"], tib_all[:40]))
            continue
        c_start, c_end, how = loc
        stats[how] += 1
        cursor = c_end
        start_syl, end_syl = idx.token_range(c_start, c_end)
        flush_titles(start_syl)

        body = "".join(
            f"<p>{ln['trans_html']}</p>" for ln in seg["lines"] if ln["trans_html"].strip())
        level = TITLE_LEVELS.get(seg["type"])

        if not dry:
            chunk_id = _find_or_create_chunk(conn, text_id, start_syl, end_syl, "text")
            if body:
                conn.execute(
                    "INSERT INTO translations (chunk_id, lang, body, status, updated_at) "
                    "VALUES (?, ?, ?, 'final', CURRENT_TIMESTAMP) "
                    "ON CONFLICT(chunk_id, lang) DO UPDATE SET body = excluded.body, "
                    "status = 'final', updated_at = CURRENT_TIMESTAMP",
                    (chunk_id, lang, _sanitize_body(body)))
                stats["translations"] += 1
            if level is not None:
                conn.execute("UPDATE translation_chunks SET level = ? WHERE id = ?",
                             (level, chunk_id))
                stats["levels"] += 1
        elif body:
            stats["translations"] += 1

        # Line-level phonetics inside the segment's span.
        line_cursor = c_start
        for ln in seg["lines"]:
            lc = clean(ln["tib"])
            if not lc:
                continue
            at = idx.clean.find(lc, line_cursor)
            if at < 0 or at >= c_end:
                continue
            l_start, l_end = idx.token_range(at, at + len(lc))
            line_cursor = at + len(lc)
            owner = conn.execute("SELECT text_id FROM syllables WHERE id = ?",
                                 (l_start,)).fetchone()
            origin = owner["text_id"] if owner else text_id
            for kind, val in (("bo", ln["phon"]), ("skt", ln["skt"])):
                if not (val or "").strip():
                    continue
                if not dry:
                    conn.execute(
                        "INSERT INTO phonetics (origin_text_id, start_syl_id, end_syl_id, "
                        "kind, body, status, engine, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, 'reviewed', 'legacy-import', CURRENT_TIMESTAMP) "
                        "ON CONFLICT(origin_text_id, start_syl_id, end_syl_id, kind) "
                        "DO UPDATE SET body = excluded.body, status = 'reviewed', "
                        "updated_at = CURRENT_TIMESTAMP",
                        (origin, l_start, l_end, kind, val.strip()))
                stats["phon" if kind == "bo" else "skt"] += 1

    flush_titles(None)  # trailing titles anchor at the end of the stream
    if not dry:
        conn.commit()
    conn.close()

    print(f"{stem}_{lang} -> text {text_id}: {stats}")
    if skipped:
        print(f"  skipped segments ({len(skipped)}):")
        for t, preview in skipped[:10]:
            print(f"    [{t}] {preview}")
        if len(skipped) > 10:
            print(f"    … and {len(skipped) - 10} more")
    return stats


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stem", help="sheet stem, e.g. rpn_long")
    ap.add_argument("langs", help="comma-separated language codes, e.g. en,fr,de,pt")
    ap.add_argument("text_id", type=int)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    init_db()
    for lang in args.langs.split(","):
        import_sheet(args.stem, lang.strip(), args.text_id, dry=args.dry_run)
