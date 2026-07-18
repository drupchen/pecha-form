"""Phonetics layer (Phase P): line-level romanization, rippling like translations.

A phonetics row is a source-syllable RANGE (one recitation line) anchored at the
text that owns those syllables, so it ripples: any booklet whose composed stream
contains the range sees it live, exactly like translation chunks and inherited tag
spans. ``kind`` is ``bo`` (Tibetan verse/prose phonetics) or ``skt`` (Sanskrit
mantra romanization). Generation is client-side (``tibetan-ewts-converter``); this
router only stores/serves the reviewed text.

Anchoring rule (find-or-create), identical to ``translations._find_or_create_chunk``:
canonicalize at the OWNER text when both endpoints belong to it and the range
resolves there (maximum reuse); else anchor at the booklet (context text).
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import get_db
from ..derivation import base_tokens
from ..manifest import syllable_ids_between
from .spans import _span_source_texts

router = APIRouter(prefix="/api", tags=["phonetics"])


# ─── Schemas ────────────────────────────────────────────────────────────────────

class PhoneticOut(BaseModel):
    id: int
    origin_text_id: int
    start_syl_id: str
    end_syl_id: str
    kind: str
    lang: str
    body: str
    status: str
    # The line's full Tibetan text resolved from its origin — so a booklet that
    # includes the line only PARTIALLY can still display the whole unit.
    text: str
    updated_at: str


class PhoneticIn(BaseModel):
    # The booklet the reviewer is working in (anchoring fallback + validation).
    context_text_id: int
    start_syl_id: str
    end_syl_id: str
    kind: str = "bo"
    lang: str = "en"
    body: str = ""
    status: str = "auto"


class PhoneticDeleteIn(BaseModel):
    context_text_id: int
    start_syl_id: str
    end_syl_id: str
    kind: str = "bo"
    lang: str = "en"


# ─── Anchoring ──────────────────────────────────────────────────────────────────

def _owner_text(conn, syl_id: str):
    row = conn.execute("SELECT text_id FROM syllables WHERE id = ?", (syl_id,)).fetchone()
    return row["text_id"] if row else None


def _resolve_range(conn, text_id: int, start_syl_id: str, end_syl_id: str):
    return syllable_ids_between(base_tokens(conn, text_id), start_syl_id, end_syl_id)


def _origin_for(conn, context_text_id: int, start_syl_id: str, end_syl_id: str) -> int:
    """Canonicalize at the OWNER text when both endpoints share one and the range
    resolves there; otherwise anchor at the booklet (context text)."""
    owner_s, owner_e = _owner_text(conn, start_syl_id), _owner_text(conn, end_syl_id)
    if owner_s is not None and owner_s == owner_e \
            and _resolve_range(conn, owner_s, start_syl_id, end_syl_id):
        return owner_s
    if _resolve_range(conn, context_text_id, start_syl_id, end_syl_id):
        return context_text_id
    raise HTTPException(400, "Phonetics endpoints must be tokens of the text, in order")


def _phonetic_out(conn, row, origin: int) -> PhoneticOut:
    toks = base_tokens(conn, origin)
    by_id = {t["id"]: t for t in toks}
    ids = syllable_ids_between(toks, row["start_syl_id"], row["end_syl_id"])
    return PhoneticOut(
        id=row["id"], origin_text_id=origin,
        start_syl_id=row["start_syl_id"], end_syl_id=row["end_syl_id"],
        kind=row["kind"], lang=row["lang"], body=row["body"], status=row["status"],
        text="".join(by_id[i]["text"] for i in ids if i in by_id),
        updated_at=str(row["updated_at"]),
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/texts/{text_id}/phonetics", response_model=List[PhoneticOut])
def list_text_phonetics(text_id: int, lang: Optional[str] = None):
    """Every phonetics row applicable to this text's stream — its own plus those of
    every ancestor/transclusion source (the same graph tag inheritance walks). A row
    applies when ANY of its member syllables appears in the stream; the response
    carries the row's FULL text so partial inclusion still shows the whole line.
    ``lang`` filters to one language (omit for all languages)."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        if not cursor.execute("SELECT 1 FROM texts WHERE id = ?", (text_id,)).fetchone():
            raise HTTPException(404, "Text not found")
        compose_cache: dict = {}
        stream_ids = {t["id"] for t in base_tokens(conn, text_id, cache=compose_cache)}
        origins = [text_id] + _span_source_texts(cursor, text_id)
        out: List[PhoneticOut] = []
        for origin in origins:
            if lang is not None:
                rows = cursor.execute(
                    "SELECT * FROM phonetics WHERE origin_text_id = ? AND lang = ?",
                    (origin, lang)).fetchall()
            else:
                rows = cursor.execute(
                    "SELECT * FROM phonetics WHERE origin_text_id = ?", (origin,)).fetchall()
            if not rows:
                continue
            toks = base_tokens(conn, origin, cache=compose_cache)
            by_id = {t["id"]: t for t in toks}
            tok_pos = {t["id"]: i for i, t in enumerate(toks)}
            for r in rows:
                ids = syllable_ids_between(toks, r["start_syl_id"], r["end_syl_id"], pos=tok_pos)
                if not ids or not any(i in stream_ids for i in ids):
                    continue
                out.append(PhoneticOut(
                    id=r["id"], origin_text_id=origin,
                    start_syl_id=r["start_syl_id"], end_syl_id=r["end_syl_id"],
                    kind=r["kind"], lang=r["lang"], body=r["body"], status=r["status"],
                    text="".join(by_id[i]["text"] for i in ids),
                    updated_at=str(r["updated_at"]),
                ))
        return out
    finally:
        conn.close()


@router.put("/phonetics", response_model=PhoneticOut)
def upsert_phonetic(payload: PhoneticIn):
    if payload.kind not in ("bo", "skt"):
        raise HTTPException(400, "kind must be 'bo' or 'skt'")
    if payload.status not in ("auto", "edited", "reviewed"):
        raise HTTPException(400, "status must be 'auto', 'edited', or 'reviewed'")
    conn = get_db()
    try:
        origin = _origin_for(conn, payload.context_text_id,
                             payload.start_syl_id, payload.end_syl_id)
        conn.execute(
            "INSERT INTO phonetics (origin_text_id, start_syl_id, end_syl_id, kind, "
            "lang, body, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(origin_text_id, start_syl_id, end_syl_id, kind, lang) DO UPDATE SET "
            "body = excluded.body, status = excluded.status, updated_at = CURRENT_TIMESTAMP",
            (origin, payload.start_syl_id, payload.end_syl_id, payload.kind,
             payload.lang, payload.body, payload.status),
        )
        conn.commit()
        r = conn.execute(
            "SELECT * FROM phonetics WHERE origin_text_id = ? AND start_syl_id = ? "
            "AND end_syl_id = ? AND kind = ? AND lang = ?",
            (origin, payload.start_syl_id, payload.end_syl_id, payload.kind,
             payload.lang)).fetchone()
        return _phonetic_out(conn, r, origin)
    finally:
        conn.close()


@router.delete("/phonetics")
def delete_phonetic(payload: PhoneticDeleteIn):
    conn = get_db()
    try:
        origin = _origin_for(conn, payload.context_text_id,
                             payload.start_syl_id, payload.end_syl_id)
        conn.execute(
            "DELETE FROM phonetics WHERE origin_text_id = ? AND start_syl_id = ? "
            "AND end_syl_id = ? AND kind = ? AND lang = ?",
            (origin, payload.start_syl_id, payload.end_syl_id, payload.kind, payload.lang))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
