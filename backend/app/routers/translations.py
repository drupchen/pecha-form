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
    if payload.level is not None and not (1 <= payload.level <= 99):
        raise HTTPException(400, "level must be 1..99 or null")
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


# ─── Phase T2: booklet overrides ────────────────────────────────────────────────

class OverrideIn(BaseModel):
    chunk_id: int
    lang: str
    body: str

class OverrideOut(BaseModel):
    chunk_id: int
    lang: str
    body: str
    base_updated_at: Optional[str] = None
    updated_at: str


@router.get("/texts/{text_id}/translation-overrides", response_model=List[OverrideOut])
def list_overrides(text_id: int):
    conn = get_db()
    try:
        return [
            OverrideOut(chunk_id=r["chunk_id"], lang=r["lang"], body=r["body"],
                        base_updated_at=r["base_updated_at"], updated_at=str(r["updated_at"]))
            for r in conn.execute(
                "SELECT * FROM translation_overrides WHERE text_id = ?", (text_id,)
            ).fetchall()
        ]
    finally:
        conn.close()


@router.put("/texts/{text_id}/translation-overrides", response_model=OverrideOut)
def upsert_override(text_id: int, payload: OverrideIn):
    """Fork/edit a booklet-local variant. On FIRST fork the canonical's updated_at
    is snapshotted as base_updated_at (staleness reference); later edits keep it."""
    conn = get_db()
    try:
        body = _sanitize_body(payload.body)
        base = conn.execute(
            "SELECT updated_at FROM translations WHERE chunk_id = ? AND lang = ?",
            (payload.chunk_id, payload.lang)).fetchone()
        base_at = str(base["updated_at"]) if base else None
        conn.execute(
            "INSERT INTO translation_overrides (text_id, chunk_id, lang, body, base_updated_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(text_id, chunk_id, lang) DO UPDATE SET body = excluded.body, "
            "updated_at = CURRENT_TIMESTAMP",
            (text_id, payload.chunk_id, payload.lang, body, base_at))
        conn.commit()
        r = conn.execute(
            "SELECT * FROM translation_overrides WHERE text_id = ? AND chunk_id = ? AND lang = ?",
            (text_id, payload.chunk_id, payload.lang)).fetchone()
        return OverrideOut(chunk_id=r["chunk_id"], lang=r["lang"], body=r["body"],
                           base_updated_at=r["base_updated_at"], updated_at=str(r["updated_at"]))
    finally:
        conn.close()


class OverrideAckIn(BaseModel):
    chunk_id: int
    lang: str


@router.post("/texts/{text_id}/translation-overrides/ack", response_model=OverrideOut)
def ack_override_base(text_id: int, payload: OverrideAckIn):
    """'Keep mine': re-anchor the override's base watermark at the CURRENT canonical
    updated_at, clearing the stale badge without changing the override body."""
    conn = get_db()
    try:
        base = conn.execute(
            "SELECT updated_at FROM translations WHERE chunk_id = ? AND lang = ?",
            (payload.chunk_id, payload.lang)).fetchone()
        if base:
            conn.execute(
                "UPDATE translation_overrides SET base_updated_at = ? "
                "WHERE text_id = ? AND chunk_id = ? AND lang = ?",
                (str(base["updated_at"]), text_id, payload.chunk_id, payload.lang))
            conn.commit()
        r = conn.execute(
            "SELECT * FROM translation_overrides WHERE text_id = ? AND chunk_id = ? AND lang = ?",
            (text_id, payload.chunk_id, payload.lang)).fetchone()
        if not r:
            raise HTTPException(404, "Override not found")
        return OverrideOut(chunk_id=r["chunk_id"], lang=r["lang"], body=r["body"],
                           base_updated_at=r["base_updated_at"], updated_at=str(r["updated_at"]))
    finally:
        conn.close()


@router.delete("/texts/{text_id}/translation-overrides/{chunk_id}/{lang}")
def delete_override(text_id: int, chunk_id: int, lang: str):
    """Revert to the shared translation."""
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM translation_overrides WHERE text_id = ? AND chunk_id = ? AND lang = ?",
            (text_id, chunk_id, lang))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Phase T2: seen watermarks ──────────────────────────────────────────────────

class SeenIn(BaseModel):
    chunk_id: int
    lang: str
    seen_updated_at: str


@router.get("/texts/{text_id}/translation-seen")
def list_seen(text_id: int):
    conn = get_db()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT chunk_id, lang, seen_updated_at FROM translation_seen WHERE text_id = ?",
            (text_id,)).fetchall()]
    finally:
        conn.close()


@router.put("/texts/{text_id}/translation-seen")
def mark_seen(text_id: int, payload: SeenIn):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO translation_seen (text_id, chunk_id, lang, seen_updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(text_id, chunk_id, lang) DO UPDATE SET seen_updated_at = excluded.seen_updated_at",
            (text_id, payload.chunk_id, payload.lang, payload.seen_updated_at))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Phase T2: suggest upstream ─────────────────────────────────────────────────

class SuggestionIn(BaseModel):
    chunk_id: int
    lang: str
    body: str
    from_text_id: Optional[int] = None

class SuggestionOut(BaseModel):
    id: int
    chunk_id: int
    lang: str
    body: str
    from_text_id: Optional[int] = None
    status: str
    created_at: str


def _suggestion_out(r) -> SuggestionOut:
    return SuggestionOut(id=r["id"], chunk_id=r["chunk_id"], lang=r["lang"], body=r["body"],
                         from_text_id=r["from_text_id"], status=r["status"],
                         created_at=str(r["created_at"]))


@router.post("/translation-suggestions", response_model=SuggestionOut)
def create_suggestion(payload: SuggestionIn):
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM translation_chunks WHERE id = ?",
                            (payload.chunk_id,)).fetchone():
            raise HTTPException(404, "Chunk not found")
        cur = conn.execute(
            "INSERT INTO translation_suggestions (chunk_id, lang, body, from_text_id) "
            "VALUES (?, ?, ?, ?)",
            (payload.chunk_id, payload.lang, _sanitize_body(payload.body), payload.from_text_id))
        conn.commit()
        r = conn.execute("SELECT * FROM translation_suggestions WHERE id = ?",
                         (cur.lastrowid,)).fetchone()
        return _suggestion_out(r)
    finally:
        conn.close()


@router.get("/texts/{text_id}/translation-suggestions", response_model=List[SuggestionOut])
def list_suggestions(text_id: int):
    """PENDING suggestions for chunks applicable to this text's stream (owner view:
    the origin's chunks surface wherever the origin's content shows)."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        stream_ids = {t["id"] for t in base_tokens(conn, text_id)}
        origins = [text_id] + _span_source_texts(cursor, text_id)
        out: List[SuggestionOut] = []
        for origin in origins:
            for r in cursor.execute(
                "SELECT s.* FROM translation_suggestions s "
                "JOIN translation_chunks c ON c.id = s.chunk_id "
                "WHERE c.origin_text_id = ? AND s.status = 'pending'", (origin,),
            ).fetchall():
                ch = cursor.execute("SELECT * FROM translation_chunks WHERE id = ?",
                                    (r["chunk_id"],)).fetchone()
                ids = syllable_ids_between(
                    base_tokens(conn, ch["origin_text_id"]),
                    ch["start_syl_id"], ch["end_syl_id"])
                if ids and any(i in stream_ids for i in ids):
                    out.append(_suggestion_out(r))
        return out
    finally:
        conn.close()


class ResolveIn(BaseModel):
    accept: bool


@router.post("/translation-suggestions/{sug_id}/resolve", response_model=SuggestionOut)
def resolve_suggestion(sug_id: int, payload: ResolveIn):
    """Accept → the suggestion body becomes the CANONICAL translation (ripples to
    every booklet); reject → recorded and closed."""
    conn = get_db()
    try:
        r = conn.execute("SELECT * FROM translation_suggestions WHERE id = ?",
                         (sug_id,)).fetchone()
        if not r:
            raise HTTPException(404, "Suggestion not found")
        if r["status"] != "pending":
            raise HTTPException(400, "Suggestion already resolved")
        if payload.accept:
            conn.execute(
                "INSERT INTO translations (chunk_id, lang, body, status, updated_at) "
                "VALUES (?, ?, ?, 'draft', CURRENT_TIMESTAMP) "
                "ON CONFLICT(chunk_id, lang) DO UPDATE SET body = excluded.body, "
                "updated_at = CURRENT_TIMESTAMP",
                (r["chunk_id"], r["lang"], r["body"]))
        conn.execute(
            "UPDATE translation_suggestions SET status = ?, resolved_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            ("accepted" if payload.accept else "rejected", sug_id))
        conn.commit()
        return _suggestion_out(conn.execute(
            "SELECT * FROM translation_suggestions WHERE id = ?", (sug_id,)).fetchone())
    finally:
        conn.close()


# ─── Phase T2: scramble layer (moves + title chunks) ────────────────────────────

class LayoutIn(BaseModel):
    text_id: Optional[int] = None   # NULL = global default; else booklet-specific
    kind: str                       # 'move' | 'title'
    src_start_syl_id: Optional[str] = None
    src_end_syl_id: Optional[str] = None
    # 'segment'/'title': lands BEFORE the chunk starting here. 'inline': lands beside this
    # very syllable, inside its chunk (after it when anchor_after). NULL = end of stream.
    anchor_syl_id: Optional[str] = None
    move_mode: str = "inline"       # 'inline' (hairline) | 'segment' (bar between chunks)
    anchor_after: bool = False      # 'inline' only: place after the anchor syllable
    level: Optional[int] = None
    lang: Optional[str] = None      # move only: NULL = shared across editions; else that edition

class LayoutOut(BaseModel):
    id: int
    text_id: Optional[int] = None
    kind: str
    src_start_syl_id: Optional[str] = None
    src_end_syl_id: Optional[str] = None
    anchor_syl_id: Optional[str] = None
    move_mode: str = "inline"
    anchor_after: bool = False
    level: Optional[int] = None
    lang: Optional[str] = None      # NULL = shared across editions; else that edition only
    disabled: bool = False
    position: int = 0
    titles: dict = {}               # lang -> body (title rows)


def _layout_out(conn, r) -> LayoutOut:
    titles = {t["lang"]: t["body"] for t in conn.execute(
        "SELECT lang, body FROM layout_titles WHERE layout_id = ?", (r["id"],)).fetchall()}
    return LayoutOut(id=r["id"], text_id=r["text_id"], kind=r["kind"],
                     src_start_syl_id=r["src_start_syl_id"], src_end_syl_id=r["src_end_syl_id"],
                     anchor_syl_id=r["anchor_syl_id"],
                     # Legacy rows predate the gesture split; their anchor already meant
                     # "before the chunk starting here", which is what 'segment' means.
                     move_mode=r["move_mode"] or "segment",
                     anchor_after=bool(r["anchor_after"]), level=r["level"],
                     lang=r["lang"],
                     disabled=bool(r["disabled"]), position=r["position"], titles=titles)


@router.get("/texts/{text_id}/chunk-layouts", response_model=List[LayoutOut])
def list_layouts(text_id: int):
    """Layout rows applicable to this booklet: its own rows plus GLOBAL rows whose
    anchors/ranges resolve in its stream. A booklet 'move' row shadows a global row
    with the same source range (the booklet-override rule)."""
    conn = get_db()
    try:
        stream_ids = {t["id"] for t in base_tokens(conn, text_id)}
        rows = conn.execute(
            "SELECT * FROM chunk_layouts WHERE text_id = ? OR text_id IS NULL "
            "ORDER BY position, id", (text_id,)).fetchall()
        # The booklet-override shadow is keyed WITHIN a language bucket: a booklet's own move
        # shadows the global move on the same source range AND the same `lang` scope, so a
        # booklet-shared row shadows a global-shared row and a booklet-`fr` row shadows a
        # global-`fr` row — the two dimensions stay orthogonal. The per-language pick (a
        # language-specific row overriding a shared one) is done on the frontend, which knows
        # the current edition; here we return every applicable row with its `lang`.
        own_move_keys = {(r["src_start_syl_id"], r["src_end_syl_id"], r["lang"])
                         for r in rows if r["text_id"] == text_id and r["kind"] == "move"}
        out = []
        for r in rows:
            if r["text_id"] is None and r["kind"] == "move" \
                    and (r["src_start_syl_id"], r["src_end_syl_id"], r["lang"]) in own_move_keys:
                continue  # shadowed by this booklet's own row (same source range + lang scope)
            # Applicability: every referenced syllable must be in the stream.
            refs = [r["src_start_syl_id"], r["src_end_syl_id"], r["anchor_syl_id"]]
            if any(x is not None and x not in stream_ids for x in refs):
                continue
            out.append(_layout_out(conn, r))
        return out
    finally:
        conn.close()


@router.post("/chunk-layouts", response_model=LayoutOut)
def create_layout(payload: LayoutIn):
    if payload.kind not in ("move", "title"):
        raise HTTPException(400, "kind must be 'move' or 'title'")
    if payload.kind == "move" and not (payload.src_start_syl_id and payload.src_end_syl_id):
        raise HTTPException(400, "move requires a source range")
    if payload.move_mode not in ("inline", "segment"):
        raise HTTPException(400, "move_mode must be 'inline' or 'segment'")
    conn = get_db()
    try:
        pos = conn.execute("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM chunk_layouts"
                           ).fetchone()["p"]
        cur = conn.execute(
            "INSERT INTO chunk_layouts (text_id, kind, src_start_syl_id, src_end_syl_id, "
            "anchor_syl_id, move_mode, anchor_after, level, lang, position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (payload.text_id, payload.kind, payload.src_start_syl_id, payload.src_end_syl_id,
             payload.anchor_syl_id, payload.move_mode, int(payload.anchor_after),
             payload.level, payload.lang, pos))
        conn.commit()
        r = conn.execute("SELECT * FROM chunk_layouts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _layout_out(conn, r)
    finally:
        conn.close()


class LayoutPatch(BaseModel):
    anchor_syl_id: Optional[str] = None
    level: Optional[int] = None
    disabled: Optional[bool] = None
    clear_anchor: bool = False      # anchor NULL = end of stream


@router.patch("/chunk-layouts/{layout_id}", response_model=LayoutOut)
def patch_layout(layout_id: int, payload: LayoutPatch):
    conn = get_db()
    try:
        r = conn.execute("SELECT * FROM chunk_layouts WHERE id = ?", (layout_id,)).fetchone()
        if not r:
            raise HTTPException(404, "Layout not found")
        sets, args = [], []
        if payload.clear_anchor:
            sets.append("anchor_syl_id = NULL")
        elif payload.anchor_syl_id is not None:
            sets.append("anchor_syl_id = ?"); args.append(payload.anchor_syl_id)
        if payload.level is not None:
            sets.append("level = ?"); args.append(payload.level)
        if payload.disabled is not None:
            sets.append("disabled = ?"); args.append(int(payload.disabled))
        if sets:
            conn.execute(f"UPDATE chunk_layouts SET {', '.join(sets)} WHERE id = ?",
                         (*args, layout_id))
            conn.commit()
        r = conn.execute("SELECT * FROM chunk_layouts WHERE id = ?", (layout_id,)).fetchone()
        return _layout_out(conn, r)
    finally:
        conn.close()


@router.delete("/chunk-layouts/{layout_id}")
def delete_layout(layout_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM chunk_layouts WHERE id = ?", (layout_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


class TitleBodyIn(BaseModel):
    lang: str
    body: str


@router.put("/chunk-layouts/{layout_id}/title", response_model=LayoutOut)
def put_layout_title(layout_id: int, payload: TitleBodyIn):
    conn = get_db()
    try:
        r = conn.execute("SELECT * FROM chunk_layouts WHERE id = ? AND kind = 'title'",
                         (layout_id,)).fetchone()
        if not r:
            raise HTTPException(404, "Title layout not found")
        conn.execute(
            "INSERT INTO layout_titles (layout_id, lang, body, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(layout_id, lang) DO UPDATE SET body = excluded.body, "
            "updated_at = CURRENT_TIMESTAMP",
            (layout_id, payload.lang, _sanitize_body(payload.body)))
        conn.commit()
        return _layout_out(conn, r)
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
