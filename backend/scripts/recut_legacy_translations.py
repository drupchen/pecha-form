"""Re-cut legacy fr/pt/de translations onto the en-adjusted chunk grid.

The English was manually aligned to the derived translation units in the bench: each en body
now sits on its unit's exact syllable range (the fine 'draft' chunks). fr/pt/de still sit on
the coarse 2023-import chunks, which the bench shows only as covers to trim.

The correct cut already exists, in two places that check each other:

- The legacy SHEETS (``input/<family>_<lang>.tsv``) are LINE-aligned — one row per Tibetan
  line with its own Phonetics and Translation cells. A line's Tibetan locates directly in the
  composed stream, so every line carries its own anchor. The booklet spans several families
  (rpn_long is the sadhana; rpn_gyunsol the front matter; the plain-TSV prayer families the
  rest), so all of them feed one pool.
- The published booklet DOCX (``output/booklets/rpn_long_booklets/<lang>/…``) is the SHIPPED
  print: each `Phonetics` paragraph names its Tibetan line and the following `Translation`
  paragraph is its translation. Wording that was fixed for print exists only here, so each
  docx pair is matched (by phonetics) to its pool line and, where the wording differs, the
  docx wins — flagged for review.

Safety rules, in order of importance:
- NEVER overwrite: a chunk that already has a row for the language is skipped outright
  (protects the hand-made fr drafts and every coarse final).
- A line that STRADDLES a chunk boundary poisons every chunk it touches — none of them is
  written. A silently partial body looks complete in the bench; an absent one correctly shows
  the coarse cover to trim, which is the existing manual flow.
- Cross-check: the en sheets are grouped by the same procedure; a chunk where the language's
  line count differs from en's is still written but listed for review (the language tabs are
  row-parallel, so equal counts is the expected case).

Run:  cd backend && .venv/bin/python scripts/recut_legacy_translations.py fr,pt,de 33 --dry-run
Idempotent by construction: reruns skip everything already written.
"""
import argparse
import csv
import html as html_mod
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from docx import Document                          # noqa: E402

from import_legacy_translations import (           # noqa: E402
    REPO_ROOT, StreamIndex, TITLE_LEVELS, clean, parse_sheet,
)
from app.db import get_db, init_db                 # noqa: E402
from app.derivation import base_tokens             # noqa: E402
from app.routers.translations import _sanitize_body  # noqa: E402

# The sheet families that compose this booklet, in anchor-priority order: where two families
# carry the same line (rpn_daily repeats gyunsol content), the earlier family's copy wins.
FAMILIES = ["rpn_long", "rpn_gyunsol", "beginning_prayers", "ending_prayers",
            "rpn_lineage", "rpn_daily"]
# A family contributes nothing unless a decent share of its lines locates EXACTLY — the guard
# against fuzzy false anchors from a family that simply is not part of this booklet.
MIN_EXACT_RATIO = 0.3


def norm(s: str) -> str:
    """Wording-comparison space: entities decoded, tags dropped, punctuation/case collapsed."""
    s = html_mod.unescape(html_mod.unescape(s or ""))
    s = re.sub(r"<[^>]+>", "", s)
    s = unicodedata.normalize("NFC", s).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s)).strip()


# ─── Sheet parsing: one path for HTML dumps, one for plain TSV ───────────────────

def parse_tsv(path: Path):
    """The plain-TSV families, yielded in ``parse_sheet``'s segment shape. Same columns
    (indexed by header name — rpn_lineage carries a stray empty column). Translation cells
    are plain text here, so they are escaped into the HTML subset."""
    rows = list(csv.reader(path.open(), delimiter="\t"))
    hdr = rows[0]
    col = {h.strip(): i for i, h in enumerate(hdr)}
    if "hub" not in col or "Tibetan" not in col:
        raise SystemExit(f"Missing hub/Tibetan columns in {path}: {hdr}")

    def get(cells, name):
        i = col.get(name)
        return cells[i] if i is not None and i < len(cells) else ""

    segments, cur = [], None
    for cells in rows[1:]:
        hub = get(cells, "hub").strip()
        if hub.startswith("|") or hub in TITLE_LEVELS:
            if cur and cur["lines"]:
                segments.append(cur)
            cur = {"type": hub.strip("|"), "lines": []}
        if cur is None:
            cur = {"type": "n", "lines": []}
        tib = get(cells, "Tibetan") or get(cells, "Tibetan- no phonetics") or get(cells, "Sanskrit")
        trans = get(cells, "Translation").strip()
        if not tib.strip() and not trans:
            continue
        cur["lines"].append({
            "tib": tib, "phon": get(cells, "Phonetics"),
            "skt": get(cells, "Sanskrit"),
            "trans_html": html_mod.escape(trans) if trans else "",
        })
    if cur and cur["lines"]:
        segments.append(cur)
    return segments


def family_lines(stem: str, lang: str):
    """Flat (family, tib, phon, trans_html, extras) lines for one family, or None if the
    file does not exist for this language. Translation-only rows are continuations of their
    preceding Tibetan line; leading ones attach to the following line."""
    path = REPO_ROOT / "input" / f"{stem}_{lang}.tsv"
    if not path.exists():
        return None
    head = path.open(errors="replace").read(200)
    segments = parse_sheet(path) if head.lstrip().startswith("<") else parse_tsv(path)
    lines, leading = [], []
    for seg in segments:
        for ln in seg["lines"]:
            trans = ln["trans_html"].strip()
            if not clean(ln["tib"]):
                if trans:
                    (lines[-1]["extras"] if lines else leading).append(trans)
                continue
            lines.append({"family": stem, "tib": ln["tib"], "phon": ln["phon"],
                          "trans_html": trans, "extras": []})
            if leading:
                lines[-1]["extras"][:0] = leading
                leading = []
    return lines


# ─── The anchored pool ───────────────────────────────────────────────────────────

def build_pool(idx: StreamIndex, lang: str):
    """Locate every family's lines in the stream. Returns (pool, family_stats). Each pool
    line adds {c_start, c_end, how}. A family below MIN_EXACT_RATIO contributes nothing; a
    line whose span overlaps an already-pooled line is dropped (the earlier family wins)."""
    pool, stats = [], {}
    taken: list[tuple[int, int]] = []     # accepted spans, for cross-family overlap checks

    def overlaps(a, b):
        return a[0] < b[1] and b[0] < a[1]

    for stem in FAMILIES:
        lines = family_lines(stem, lang)
        if lines is None:
            stats[stem] = "no file"
            continue
        cursor, located, exact = 0, [], 0
        unlocated = 0
        for ln in lines:
            loc = idx.locate(clean(ln["tib"]), cursor)
            if not loc:
                unlocated += 1
                continue
            c_start, c_end, how = loc
            cursor = c_end
            exact += how == "exact"
            located.append({**ln, "c_start": c_start, "c_end": c_end, "how": how})
        ratio = exact / len(lines) if lines else 0
        if ratio < MIN_EXACT_RATIO:
            stats[stem] = f"DROPPED ({exact}/{len(lines)} exact — not this booklet)"
            continue
        kept = dupes = 0
        for ln in located:
            span = (ln["c_start"], ln["c_end"])
            if any(overlaps(span, t) for t in taken):
                dupes += 1
                continue
            taken.append(span)
            pool.append(ln)
            kept += 1
        stats[stem] = (f"{kept} lines ({exact} exact, {len(located) - exact} fuzzy, "
                       f"{unlocated} unlocatable, {dupes} duplicate spans)")
    pool.sort(key=lambda ln: ln["c_start"])
    return pool, stats


# ─── The docx: shipped wording, matched to pool lines by phonetics ───────────────

def docx_html(p) -> str:
    """A docx paragraph as the sanitized HTML subset, keeping bold/italic runs."""
    parts = []
    for run in p.runs:
        t = html_mod.escape(run.text)
        if not t:
            continue
        if run.bold:
            t = f"<strong>{t}</strong>"
        if run.italic:
            t = f"<em>{t}</em>"
        parts.append(t)
    return "".join(parts).strip()


def docx_wording(lang: str, pool):
    """Match each docx (Phonetics → Translation) pair to its pool line by normalized
    phonetics (consuming pool lines in stream order, so repeated lines pair off one by one).
    Returns (n_pairs, n_anchored): mutates matched pool lines with {docx_html}."""
    path = (REPO_ROOT / "output" / "booklets" / "rpn_long_booklets" / lang
            / f"rpn_long_booklet_{lang}.docx")
    if not path.exists():
        return 0, 0
    doc = Document(str(path))
    paras = [p for p in doc.paragraphs if p.text.strip()]
    by_phon: dict[str, list] = {}
    for ln in pool:
        if (ln["phon"] or "").strip():
            by_phon.setdefault(norm(ln["phon"]), []).append(ln)

    pairs = anchored = 0
    for i, p in enumerate(paras):
        if p.style.name != "Phonetics" or i + 1 >= len(paras):
            continue
        nxt = paras[i + 1]
        if nxt.style.name != "Translation":
            continue
        pairs += 1
        cands = by_phon.get(norm(p.text))
        if not cands:
            continue
        ln = cands.pop(0) if len(cands) > 1 else cands[0]   # consume repeats in order
        body = docx_html(nxt)
        if body:
            ln["docx_html"] = body
            anchored += 1
    return pairs, anchored


# ─── Targets: the en-adjusted chunk grid ─────────────────────────────────────────

def chunk_ranges(conn, idx: StreamIndex, lang: str):
    """Every kind='text' chunk carrying an en translation, as clean-stream char ranges.
    A chunk already holding ``lang`` is never a write target."""
    tok_span: dict[str, tuple[int, int]] = {}
    for ci, ti in enumerate(idx.owner):
        tid = idx.tokens[ti]["id"]
        s, _ = tok_span.get(tid, (ci, ci))
        tok_span[tid] = (min(s, ci), ci + 1)

    rows = conn.execute(
        "SELECT tc.id, tc.origin_text_id, tc.start_syl_id, tc.end_syl_id, "
        "  EXISTS(SELECT 1 FROM translations x WHERE x.chunk_id = tc.id AND x.lang = ?) has_lang "
        "FROM translation_chunks tc "
        "WHERE tc.kind = 'text' "
        "  AND EXISTS(SELECT 1 FROM translations e WHERE e.chunk_id = tc.id AND e.lang = 'en')",
        (lang,)).fetchall()

    targets, skipped_existing, unmapped = [], 0, []
    for r in rows:
        if r["has_lang"]:
            skipped_existing += 1
            continue
        s, e = tok_span.get(r["start_syl_id"]), tok_span.get(r["end_syl_id"])
        if s is None or e is None:
            unmapped.append(r["id"])
            continue
        targets.append({"id": r["id"], "origin": r["origin_text_id"],
                        "c_start": s[0], "c_end": e[1]})
    targets.sort(key=lambda t: t["c_start"])
    return targets, skipped_existing, unmapped


def group_lines(targets, pool):
    """Assign each pool line to the tightest target chunk containing its span. A straddler
    poisons every chunk it touches. Pool lines inside no target are simply unused."""
    straddlers = 0
    for ln in pool:
        inside = [t for t in targets if t["c_start"] <= ln["c_start"] and ln["c_end"] <= t["c_end"]]
        if inside:
            t = min(inside, key=lambda t: t["c_end"] - t["c_start"])
            t.setdefault("lines", []).append(ln)
            continue
        touched = [t for t in targets
                   if ln["c_start"] < t["c_end"] and t["c_start"] < ln["c_end"]]
        if touched:
            straddlers += 1
            for t in touched:
                t["poisoned"] = True
    return straddlers


def body_of(chunk):
    """(body_html, diff): the sheet lines are the skeleton (they keep every line kind —
    small letters and continuations have no docx counterpart). The docx is compared at
    CHUNK level, never line by line: the print re-lineated translations relative to
    phonetics in places, so a per-line splice would swap in the neighbouring line's text.
    Joined-and-normalized equal → pure re-lineation, sheet body stands, no flag. Genuinely
    different → the docx wording shipped, so it wins — but only when its pairs cover every
    phonetics line of the chunk (a partial cover would splice again); otherwise the sheet
    body stands and the chunk is flagged for a human."""
    sheet_parts, docx_parts = [], []
    phon_lines = docx_hits = 0
    for ln in chunk.get("lines", []):
        if ln["trans_html"]:
            sheet_parts.append(f"<p>{ln['trans_html']}</p>")
        sheet_parts.extend(f"<p>{x}</p>" for x in ln["extras"])
        if (ln["phon"] or "").strip():
            phon_lines += 1
            if ln.get("docx_html"):
                docx_hits += 1
                docx_parts.append(f"<p>{ln['docx_html']}</p>")
    sheet_body = _sanitize_body("".join(sheet_parts))
    if not sheet_body and docx_parts:
        # The sheet never carried this wording; the print did. The docx is the only source.
        return _sanitize_body("".join(docx_parts)), ("docx-only", "", "".join(docx_parts))
    if not docx_parts or norm("".join(docx_parts)) == norm(sheet_body):
        return sheet_body, None
    if docx_hits == phon_lines and not any(ln["extras"] for ln in chunk.get("lines", [])) \
            and all(bool(ln["trans_html"]) == bool(ln.get("docx_html"))
                    for ln in chunk.get("lines", [])):
        return _sanitize_body("".join(docx_parts)), ("docx", sheet_body, "".join(docx_parts))
    return sheet_body, ("sheet", sheet_body, "".join(docx_parts))


# ─── Run ─────────────────────────────────────────────────────────────────────────

def recut(lang: str, context_text_id: int, en_counts, dry: bool):
    conn = get_db()
    tokens = base_tokens(conn, context_text_id)
    if not tokens:
        raise SystemExit(f"Text {context_text_id} has no tokens")
    idx = StreamIndex(tokens)

    pool, fam_stats = build_pool(idx, lang)
    n_pairs, n_anchored = docx_wording(lang, pool)
    targets, skipped_existing, unmapped = chunk_ranges(conn, idx, lang)
    straddlers = group_lines(targets, pool)

    written = empty = poisoned = mismatched = worded = 0
    review = []
    for t in targets:
        if t.get("poisoned"):
            poisoned += 1
            review.append(f"chunk {t['id']} (text {t['origin']}): STRADDLED — left for the bench")
            continue
        body, diff = body_of(t)
        if not body:
            empty += 1
            continue
        if diff:
            worded += 1
            used, sheet_w, docx_w = diff
            if used == "docx-only":
                review.append(f"chunk {t['id']} (text {t['origin']}): sheet has no wording — "
                              f"print wording written: {norm(docx_w)[:80]!r}")
            else:
                review.append(f"chunk {t['id']} (text {t['origin']}): wording differs, "
                              f"{'PRINT wording written' if used == 'docx' else 'sheet written (docx covers it only partially)'} —")
                review.append(f"       sheet: {norm(sheet_w)[:100]!r}")
                review.append(f"       docx : {norm(docx_w)[:100]!r}")
        en_n = en_counts.get(t["id"])
        n = len(t.get("lines", []))
        if en_n is not None and en_n != n:
            mismatched += 1
            review.append(f"chunk {t['id']} (text {t['origin']}): {n} {lang} lines vs "
                          f"{en_n} en — written, review the cut")
        if not dry:
            conn.execute(
                "INSERT INTO translations (chunk_id, lang, body, status, updated_at) "
                "VALUES (?, ?, ?, 'draft', CURRENT_TIMESTAMP) "
                "ON CONFLICT(chunk_id, lang) DO NOTHING",
                (t["id"], lang, body))
        written += 1

    if not dry:
        conn.commit()
    conn.close()

    print(f"\n════ {lang} → text {context_text_id}{'   [DRY RUN]' if dry else ''}")
    for stem, s in fam_stats.items():
        print(f"   {stem:20} {s}")
    print(f"   docx: {n_pairs} phon+trans pairs, {n_anchored} anchored to pool lines")
    print(f"   targets missing {lang}: {len(targets)}  "
          f"(+{skipped_existing} already have it — untouched; {len(unmapped)} outside this stream)")
    print(f"   WRITTEN {written}   empty {empty}   straddled {poisoned} "
          f"(from {straddlers} straddling lines)   print-wording diffs {worded}   "
          f"line-count mismatch vs en {mismatched}")
    for r in review[:20]:
        print(f"     {r}")
    if len(review) > 20:
        print(f"     … and {len(review) - 20} more")
    return {"targets": len(targets), "written": written}


def en_line_counts(context_text_id: int):
    """The cross-check baseline: the en sheets pooled and grouped by the same procedure."""
    conn = get_db()
    idx = StreamIndex(base_tokens(conn, context_text_id))
    pool, _ = build_pool(idx, "en")
    targets, _, _ = chunk_ranges(conn, idx, "__none__")
    group_lines(targets, pool)
    conn.close()
    return {t["id"]: len(t.get("lines", [])) for t in targets if not t.get("poisoned")}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("langs", help="comma-separated language codes, e.g. fr,pt,de")
    ap.add_argument("context_text_id", type=int, help="text whose composed stream to align on")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    init_db()
    en_counts = en_line_counts(args.context_text_id)
    print(f"en baseline: {len(en_counts)} chunks with grouped line counts")
    for lang in args.langs.split(","):
        recut(lang.strip(), args.context_text_id, en_counts, dry=args.dry_run)
