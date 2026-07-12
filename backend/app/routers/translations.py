"""Translation layer, Phase T1: languages, chunks, canonical translations.

A CHUNK is the unit of translation — the stretch between two empty lines (or
segment boundaries) of a booklet's stream. It is persisted as a source-syllable
RANGE anchored at the text that owns those syllables, so translations ripple: any
booklet whose composed stream contains the range sees them live, exactly like
inherited tag spans (``spans._span_source_texts``).

Anchoring rule (find-or-create): if both endpoints belong to the same physical
text and the range resolves over that text's exposed sequence, the chunk is
canonical there (maximum reuse). A range that straddles texts (crosses a
transclusion boundary or mixes hosted edits) anchors at the booklet itself —
still translatable, it just cannot ripple beyond that booklet.
"""
import html as html_mod
from html.parser import HTMLParser
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import get_db
from ..derivation import base_tokens
from ..manifest import syllable_ids_between
from .spans import _span_source_texts

router = APIRouter(prefix="/api", tags=["translations"])


# ─── Schemas ────────────────────────────────────────────────────────────────────

class LanguageOut(BaseModel):
    code: str
    name: str

class TranslationOut(BaseModel):
    lang: str
    body: str
    status: str
    translated_from: Optional[str] = None
    updated_at: str

class ChunkOut(BaseModel):
    id: int
    origin_text_id: int
    start_syl_id: str
    end_syl_id: str
    kind: str
    # Title level for heading chunks (sapche/title), NULL = not a heading.
    level: Optional[int] = None
    # The chunk's full Tibetan text resolved from its origin — so a booklet that
    # includes the chunk only PARTIALLY can still display the whole unit.
    text: str
    translations: List[TranslationOut] = []

class TranslationUpsertIn(BaseModel):
    # The booklet the translator is working in (anchoring fallback + validation).
    context_text_id: int
    start_syl_id: str
    end_syl_id: str
    lang: str
    body: str
    status: str = "draft"
    translated_from: Optional[str] = None
    kind: str = "text"


# ─── Body sanitization ──────────────────────────────────────────────────────────
# Translation bodies are a SMALL HTML subset that flows untransformed into the
# paginated booklet page: p, br, strong, em (b/i normalized), and the footnote
# carrier span.fn[data-note] (numbering is assigned at pagination, never stored).

class _Sanitizer(HTMLParser):
    _INLINE = {"strong": "strong", "b": "strong", "em": "em", "i": "em"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list = []
        self._stack: list = []  # emitted close tags, in order

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.out.append("<br>")
            return
        if tag == "p":
            self.out.append("<p>")
            self._stack.append((tag, "</p>"))
        elif tag in self._INLINE:
            norm = self._INLINE[tag]
            self.out.append(f"<{norm}>")
            self._stack.append((tag, f"</{norm}>"))
        elif tag == "span":
            a = dict(attrs)
            if "fn" in (a.get("class") or "").split() and a.get("data-note") is not None:
                note = html_mod.escape(a.get("data-note") or "", quote=True)
                self.out.append(f'<span class="fn" data-note="{note}" title="{note}">')
                self._stack.append((tag, "</span>"))
            else:
                self._stack.append((tag, ""))  # unwrap: keep children only
        else:
            self._stack.append((tag, ""))

    def handle_endtag(self, tag):
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                closer = self._stack.pop(i)[1]
                if closer:
                    self.out.append(closer)
                break

    def handle_data(self, data):
        self.out.append(html_mod.escape(data))


def _sanitize_body(body: str) -> str:
    """Reduce ``body`` to the allowed subset; plain text passes through escaped."""
    if not body:
        return ""
    if "<" not in body and ">" not in body:
        return html_mod.escape(body)
    s = _Sanitizer()
    s.feed(body)
    s.close()
    # Close anything left open (malformed input), outermost last.
    for _, closer in reversed(s._stack):
        if closer:
            s.out.append(closer)
    return "".join(s.out)


# ─── Languages ──────────────────────────────────────────────────────────────────

@router.get("/languages", response_model=List[LanguageOut])
def list_languages():
    conn = get_db()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT code, name FROM languages ORDER BY code").fetchall()]
    finally:
        conn.close()


class LanguageIn(BaseModel):
    code: str
    name: str


@router.post("/languages", response_model=LanguageOut)
def add_language(payload: LanguageIn):
    code = payload.code.strip().lower()
    if not code:
        raise HTTPException(400, "Language code required")
    conn = get_db()
    try:
        conn.execute("INSERT OR IGNORE INTO languages (code, name) VALUES (?, ?)",
                     (code, payload.name.strip() or code))
        conn.commit()
        row = conn.execute("SELECT code, name FROM languages WHERE code = ?", (code,)).fetchone()
        return dict(row)
    finally:
        conn.close()


# ─── Chunk anchoring ────────────────────────────────────────────────────────────

def _owner_text(conn, syl_id: str):
    row = conn.execute("SELECT text_id FROM syllables WHERE id = ?", (syl_id,)).fetchone()
    return row["text_id"] if row else None


def _resolve_chunk_range(conn, text_id: int, start_syl_id: str, end_syl_id: str):
    """Ids of the chunk's tokens over ``text_id``'s exposed sequence, or []."""
    return syllable_ids_between(base_tokens(conn, text_id), start_syl_id, end_syl_id)


def _find_or_create_chunk(conn, context_text_id: int, start_syl_id: str,
                          end_syl_id: str, kind: str) -> int:
    """Canonicalize the chunk at the OWNER text when both endpoints share one and
    the range resolves there; otherwise anchor at the booklet (context text)."""
    owner_s, owner_e = _owner_text(conn, start_syl_id), _owner_text(conn, end_syl_id)
    origin = None
    if owner_s is not None and owner_s == owner_e \
            and _resolve_chunk_range(conn, owner_s, start_syl_id, end_syl_id):
        origin = owner_s
    elif _resolve_chunk_range(conn, context_text_id, start_syl_id, end_syl_id):
        origin = context_text_id
    if origin is None:
        raise HTTPException(400, "Chunk endpoints must be tokens of the text, in order")
    row = conn.execute(
        "SELECT id FROM translation_chunks WHERE origin_text_id = ? "
        "AND start_syl_id = ? AND end_syl_id = ?",
        (origin, start_syl_id, end_syl_id),
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO translation_chunks (origin_text_id, start_syl_id, end_syl_id, kind) "
        "VALUES (?, ?, ?, ?)", (origin, start_syl_id, end_syl_id, kind))
    return cur.lastrowid


# ─── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/texts/{text_id}/translations", response_model=List[ChunkOut])
def list_text_translations(text_id: int):
    """Every chunk applicable to this text's stream — its own plus those of every
    ancestor/transclusion source (the same graph tag inheritance walks). A chunk
    applies when ANY of its member syllables appears in the stream; the response
    carries the chunk's FULL text so partial inclusion still shows the whole unit."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        if not cursor.execute("SELECT 1 FROM texts WHERE id = ?", (text_id,)).fetchone():
            raise HTTPException(404, "Text not found")
        stream_ids = {t["id"] for t in base_tokens(conn, text_id)}
        origins = [text_id] + _span_source_texts(cursor, text_id)
        out = []
        for origin in origins:
            rows = cursor.execute(
                "SELECT * FROM translation_chunks WHERE origin_text_id = ?", (origin,)
            ).fetchall()
            if not rows:
                continue
            toks = base_tokens(conn, origin)
            by_id = {t["id"]: t for t in toks}
            for ch in rows:
                ids = syllable_ids_between(toks, ch["start_syl_id"], ch["end_syl_id"])
                if not ids or not any(i in stream_ids for i in ids):
                    continue
                translations = [
                    TranslationOut(
                        lang=t["lang"], body=t["body"], status=t["status"],
                        translated_from=t["translated_from"],
                        updated_at=str(t["updated_at"]),
                    )
                    for t in cursor.execute(
                        "SELECT * FROM translations WHERE chunk_id = ?", (ch["id"],)
                    ).fetchall()
                ]
                out.append(ChunkOut(
                    id=ch["id"], origin_text_id=origin,
                    start_syl_id=ch["start_syl_id"], end_syl_id=ch["end_syl_id"],
                    kind=ch["kind"], level=ch["level"],
                    text="".join(by_id[i]["text"] for i in ids),
                    translations=translations,
                ))
        return out
    finally:
        conn.close()


@router.put("/translations", response_model=ChunkOut)
def upsert_translation(payload: TranslationUpsertIn):
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM languages WHERE code = ?",
                            (payload.lang,)).fetchone():
            raise HTTPException(400, f"Unknown language '{payload.lang}'")
        chunk_id = _find_or_create_chunk(
            conn, payload.context_text_id, payload.start_syl_id,
            payload.end_syl_id, payload.kind)
        body = _sanitize_body(payload.body)
        conn.execute(
            "INSERT INTO translations (chunk_id, lang, body, status, translated_from, updated_at) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(chunk_id, lang) DO UPDATE SET body = excluded.body, "
            "status = excluded.status, translated_from = excluded.translated_from, "
            "updated_at = CURRENT_TIMESTAMP",
            (chunk_id, payload.lang, body, payload.status, payload.translated_from),
        )
        conn.commit()
        ch = conn.execute("SELECT * FROM translation_chunks WHERE id = ?", (chunk_id,)).fetchone()
        toks = base_tokens(conn, ch["origin_text_id"])
        by_id = {t["id"]: t for t in toks}
        ids = syllable_ids_between(toks, ch["start_syl_id"], ch["end_syl_id"])
        translations = [
            TranslationOut(lang=t["lang"], body=t["body"], status=t["status"],
                           translated_from=t["translated_from"], updated_at=str(t["updated_at"]))
            for t in conn.execute("SELECT * FROM translations WHERE chunk_id = ?",
                                  (chunk_id,)).fetchall()
        ]
        return ChunkOut(
            id=ch["id"], origin_text_id=ch["origin_text_id"],
            start_syl_id=ch["start_syl_id"], end_syl_id=ch["end_syl_id"], kind=ch["kind"],
            level=ch["level"],
            text="".join(by_id[i]["text"] for i in ids), translations=translations,
        )
    finally:
        conn.close()


class ChunkLevelIn(BaseModel):
    context_text_id: int
    start_syl_id: str
    end_syl_id: str
    level: Optional[int] = None   # 1..n; None clears (not a heading)


@router.put("/translation-chunks/level", response_model=ChunkOut)
def set_chunk_level(payload: ChunkLevelIn):
    """Set/clear a chunk's title level (language-independent; whole chunk). The
    chunk is created if it does not exist yet — a level can precede any translation."""
    if payload.level is not None and not (1 <= payload.level <= 9):
        raise HTTPException(400, "level must be 1..9 or null")
    conn = get_db()
    try:
        chunk_id = _find_or_create_chunk(
            conn, payload.context_text_id, payload.start_syl_id,
            payload.end_syl_id, "text")
        conn.execute("UPDATE translation_chunks SET level = ? WHERE id = ?",
                     (payload.level, chunk_id))
        conn.commit()
        ch = conn.execute("SELECT * FROM translation_chunks WHERE id = ?", (chunk_id,)).fetchone()
        toks = base_tokens(conn, ch["origin_text_id"])
        by_id = {t["id"]: t for t in toks}
        ids = syllable_ids_between(toks, ch["start_syl_id"], ch["end_syl_id"])
        translations = [
            TranslationOut(lang=t["lang"], body=t["body"], status=t["status"],
                           translated_from=t["translated_from"], updated_at=str(t["updated_at"]))
            for t in conn.execute("SELECT * FROM translations WHERE chunk_id = ?",
                                  (chunk_id,)).fetchall()
        ]
        return ChunkOut(
            id=ch["id"], origin_text_id=ch["origin_text_id"],
            start_syl_id=ch["start_syl_id"], end_syl_id=ch["end_syl_id"], kind=ch["kind"],
            level=ch["level"],
            text="".join(by_id[i]["text"] for i in ids), translations=translations,
        )
    finally:
        conn.close()


@router.delete("/translations/{chunk_id}/{lang}")
def delete_translation(chunk_id: int, lang: str):
    """Remove one language's translation; the chunk row stays (other languages may
    reference it). An empty chunk is garbage-collected."""
    conn = get_db()
    try:
        conn.execute("DELETE FROM translations WHERE chunk_id = ? AND lang = ?",
                     (chunk_id, lang))
        left = conn.execute("SELECT 1 FROM translations WHERE chunk_id = ?",
                            (chunk_id,)).fetchone()
        # GC only fully-empty chunks — a title level is data worth keeping.
        if not left:
            conn.execute(
                "DELETE FROM translation_chunks WHERE id = ? AND level IS NULL",
                (chunk_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
