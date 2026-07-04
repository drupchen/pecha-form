from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends, Body
from typing import List, Any, Dict
import json
import os
import sqlite3
from typing import Optional

from ..db import get_db
from ..schemas import TextOut, TextDetailOut, ExtractIn, CloneIn
from ..tokenizer import prepare_and_tokenize
from ..cherrytree_importer import import_cherrytree
from ..exporters.json_exporter import SCHEMA_VERSION as JSON_SCHEMA_VERSION
from ..manifest import (
    persist_syllables, default_instance_id, corrected_root_units, load_syllables,
    syllable_ids_between, _text_corrected,
)
from ..main_text_align import snap_portions_to_syllables, snap_section_boundary

router = APIRouter(prefix="/api/texts", tags=["texts"])


def _apply_instance_metadata(
    conn,
    doc_id: int,
    raw_text: str,
    instance_id: Optional[str],
    teaching_id: Optional[str] = None,
    title_bo: Optional[str] = None,
    access_level: Optional[int] = None,
    fallback_title: str = "",
) -> str:
    """Store catalog metadata on the text and (re)build its syllable layer.

    Additive: only the text's own catalog columns and the syllables table
    are written; annotation tables are untouched. Returns the instance_id used.
    """
    instance_id = (instance_id or "").strip() or default_instance_id(fallback_title)
    conn.execute(
        "UPDATE texts SET instance_id = ?, teaching_id = COALESCE(?, teaching_id), "
        "title_bo = COALESCE(?, title_bo), access_level = COALESCE(?, access_level) "
        "WHERE id = ?",
        (instance_id, teaching_id, title_bo, access_level, doc_id),
    )
    persist_syllables(conn, doc_id, instance_id, raw_text)
    return instance_id


def _create_primary_text(conn, filename: str, title: str, source_text: str,
                         cloned_from_text_id: Optional[int] = None) -> int:
    """Create a fresh, independent primary text from a raw string, building its own
    syllable layer (fresh instance_id + uuids). Shared by /extract and /clone. Mirrors
    the tokenize→insert→persist_syllables path of upload_text."""
    raw_text, units = prepare_and_tokenize(source_text)
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, units_json, "
        "cloned_from_text_id) VALUES (?, ?, ?, ?, ?, ?)",
        (filename, title, source_text, raw_text, json.dumps(units, ensure_ascii=False),
         cloned_from_text_id),
    )
    new_id = cur.lastrowid
    _apply_instance_metadata(conn, new_id, raw_text, None, fallback_title=title)
    return new_id


def _extract_title(text: str) -> str:
    """A short default title from the extracted text (first ~30 chars, one line)."""
    flat = " ".join((text or "").split())
    return (flat[:30].rstrip() or "extract")


def _insert_delete_suggestion(conn, text_id: int, start_off: int, end_off: int,
                              start_syl_id: str, end_syl_id: str) -> None:
    """Reversibly remove a raw-text range by recording a delete-suggestion (empty
    replacement). Non-destructive: raw_text/syllables are untouched; deleting the row
    restores the range. Offsets here are the existing frontend-facing suggestion aid."""
    if end_off <= start_off:
        return
    conn.execute(
        "INSERT INTO suggestions (text_id, start_offset, end_offset, suggested_text, "
        "start_syl_id, end_syl_id) VALUES (?, ?, ?, '', ?, ?)",
        (text_id, start_off, end_off, start_syl_id, end_syl_id),
    )


@router.post("/import-cherrytree", response_model=TextDetailOut)
async def import_cherrytree_endpoint(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    instance_id: Optional[str] = Form(None),
    teaching_id: Optional[str] = Form(None),
    title_bo: Optional[str] = Form(None),
    access_level: Optional[int] = Form(None),
):
    """Import a CherryTree .ctd XML file as a new text.

    Creates: text, tags (per format used), spans, and tree_nodes mirroring
    the CherryTree node hierarchy. See cherrytree_importer.py for the mapping.
    Also builds the syllable base layer for publishing.
    """
    if not (file.filename or '').lower().endswith('.ctd'):
        raise HTTPException(400, "Only .ctd files are supported by this endpoint.")
    contents = await file.read()
    try:
        doc_id = import_cherrytree(contents, file.filename, title)
    except ValueError as e:
        raise HTTPException(400, str(e))

    conn = get_db()
    cursor = conn.cursor()
    _doc = cursor.execute("SELECT raw_text, title FROM texts WHERE id = ?", (doc_id,)).fetchone()
    _apply_instance_metadata(
        conn, doc_id, _doc["raw_text"], instance_id, teaching_id, title_bo,
        access_level, fallback_title=_doc["title"],
    )
    conn.commit()
    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags  WHERE text_id = d.id) as tag_count
        FROM texts d
        WHERE d.id = ?
    """, (doc_id,))
    row = dict(cursor.fetchone())
    units = json.loads(row["units_json"])
    conn.close()
    return {**row, "units": units}


@router.post("/import-json", response_model=TextDetailOut)
def import_json_endpoint(payload: Dict[str, Any] = Body(...)):
    """Recreate a text from a JSON dump produced by GET /export/json.

    Old IDs in the payload are remapped to fresh autoincrement IDs as the rows
    are inserted (tags first → spans next, using the tag-id map; tree_nodes
    are inserted parent-before-child via the parent-NULL-first ordering and a
    parallel node-id map; spans/markers/suggestions are straightforward).
    """
    if not isinstance(payload, dict):
        raise HTTPException(400, "Body must be a JSON object")
    if payload.get("schema_version") != JSON_SCHEMA_VERSION:
        raise HTTPException(
            400,
            f"Unsupported schema_version (got {payload.get('schema_version')!r}, "
            f"expected {JSON_SCHEMA_VERSION})",
        )
    doc = payload.get("text") or {}
    for required in ("filename", "title", "source_text", "raw_text", "units"):
        if required not in doc:
            raise HTTPException(400, f"text.{required} is required")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO texts (filename, title, source_text, raw_text, units_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                doc["filename"], doc["title"], doc["source_text"], doc["raw_text"],
                json.dumps(doc["units"], ensure_ascii=False),
            ),
        )
        doc_id = cursor.lastrowid

        # Tags — track old → new id mapping.
        tag_id_map: Dict[int, int] = {}
        for t in payload.get("tags", []):
            cursor.execute(
                "INSERT INTO tags (text_id, name, color, tag_kind, open_position, close_position) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    doc_id, t["name"], t["color"], t.get("tag_kind", "regular"),
                    t.get("open_position"), t.get("close_position"),
                ),
            )
            tag_id_map[t["id"]] = cursor.lastrowid

        # Spans — remap tag_id.
        for s in payload.get("spans", []):
            new_tag_id = tag_id_map.get(s["tag_id"])
            if new_tag_id is None:
                raise HTTPException(400, f"Span references unknown tag id {s['tag_id']}")
            cursor.execute(
                "INSERT INTO spans (text_id, tag_id, start_offset, end_offset) VALUES (?, ?, ?, ?)",
                (doc_id, new_tag_id, s["start_offset"], s["end_offset"]),
            )

        # Markers.
        for m in payload.get("markers", []):
            cursor.execute(
                "INSERT INTO markers (text_id, position) VALUES (?, ?)",
                (doc_id, m["position"]),
            )

        # Tree nodes — payload is dumped parent-NULL-first, so for each row the
        # mapped parent already exists in the node_id_map.
        node_id_map: Dict[int, int] = {}
        for n in payload.get("tree_nodes", []):
            old_parent = n["parent_id"]
            new_parent = node_id_map.get(old_parent) if old_parent is not None else None
            if old_parent is not None and new_parent is None:
                raise HTTPException(400, f"Tree node parent {old_parent} missing from payload (out-of-order rows)")
            cursor.execute(
                "INSERT INTO tree_nodes (text_id, parent_id, position, title, segment_start, transparent) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (doc_id, new_parent, n["position"], n.get("title"), n.get("segment_start"), int(bool(n.get("transparent", False)))),
            )
            node_id_map[n["id"]] = cursor.lastrowid

        # Suggestions.
        for sg in payload.get("suggestions", []):
            cursor.execute(
                "INSERT INTO suggestions (text_id, start_offset, end_offset, suggested_text, status) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    doc_id, sg["start_offset"], sg["end_offset"],
                    sg["suggested_text"], sg.get("status", "pending"),
                ),
            )

        conn.commit()
    except HTTPException:
        conn.rollback()
        conn.close()
        raise
    except sqlite3.Error as e:
        conn.rollback()
        conn.close()
        raise HTTPException(400, f"Import failed: {e}")

    cursor.execute(
        """
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count
        FROM texts d
        WHERE d.id = ?
        """,
        (doc_id,),
    )
    row = dict(cursor.fetchone())
    units = json.loads(row["units_json"])
    conn.close()
    return {**row, "units": units}


@router.post("", response_model=TextDetailOut)
async def upload_text(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    instance_id: Optional[str] = Form(None),
    teaching_id: Optional[str] = Form(None),
    title_bo: Optional[str] = Form(None),
    access_level: Optional[int] = Form(None),
):
    if not file.filename.endswith(".txt"):
        raise HTTPException(400, "Only .txt files are supported.")

    contents = await file.read()
    source_text = contents.decode("utf-8")
    doc_title = title or file.filename.rsplit(".", 1)[0]

    raw_text, units = prepare_and_tokenize(source_text)
    units_json = json.dumps(units, ensure_ascii=False)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO texts (filename, title, source_text, raw_text, units_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (file.filename, doc_title, source_text, raw_text, units_json)
    )
    doc_id = cursor.lastrowid
    _apply_instance_metadata(
        conn, doc_id, raw_text, instance_id, teaching_id, title_bo, access_level,
        fallback_title=doc_title,
    )
    conn.commit()

    cursor.execute("SELECT * FROM texts WHERE id = ?", (doc_id,))
    row = dict(cursor.fetchone())
    conn.close()

    return {
        **row,
        "units": units,
        "span_count": 0,
        "tag_count": 0
    }


@router.post("/{id}/build-manifest", response_model=TextDetailOut)
def build_manifest(
    id: int,
    instance_id: Optional[str] = Form(None),
    teaching_id: Optional[str] = Form(None),
    title_bo: Optional[str] = Form(None),
    access_level: Optional[int] = Form(None),
):
    """(Re)build the syllable base layer for an existing text and set its
    catalog metadata. Additive backfill — annotation tables are untouched. This
    is how the pre-existing drime_shalung text gets its instance_id and
    syllables.
    """
    conn = get_db()
    cursor = conn.cursor()
    row = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Text not found")

    effective_instance = (instance_id or row["instance_id"] or "").strip()
    if not effective_instance:
        conn.close()
        raise HTTPException(400, "instance_id is required (none stored yet)")

    used = _apply_instance_metadata(
        conn, id, row["raw_text"], effective_instance, teaching_id, title_bo,
        access_level, fallback_title=row["title"],
    )
    syl_count = cursor.execute(
        "SELECT COUNT(*) c FROM syllables WHERE text_id = ?", (id,)
    ).fetchone()["c"]
    conn.commit()

    detail = cursor.execute(
        """
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count
        FROM texts d WHERE d.id = ?
        """,
        (id,),
    ).fetchone()
    res = dict(detail)
    res["units"] = json.loads(res["units_json"])
    conn.close()
    res["instance_id"] = used
    res["syllable_count"] = syl_count
    return res

@router.get("", response_model=List[TextOut])
def list_texts():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count,
               EXISTS(SELECT 1 FROM texts c WHERE c.cloned_from_text_id = d.id) as has_clone
        FROM texts d
        ORDER BY d.updated_at DESC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

@router.get("/{id}", response_model=TextDetailOut)
def get_text(id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count,
               EXISTS(SELECT 1 FROM texts c WHERE c.cloned_from_text_id = d.id) as has_clone
        FROM texts d WHERE d.id = ?
    """, (id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(404, "Text not found")

    res = dict(row)
    res["units"] = json.loads(res["units_json"])
    # A secondary text has no raw_text of its own — project its composed content so
    # the workspace (which builds segments from raw_text) renders the derived text.
    if res.get("text_type") == "secondary":
        from ..derivation import compose_secondary, composed_raw_text
        conn2 = get_db()
        try:
            res["raw_text"] = composed_raw_text(compose_secondary(conn2, id))
        finally:
            conn2.close()
    return res


@router.post("/{id}/derive", response_model=TextDetailOut)
def derive_secondary_text(id: int, payload: Dict[str, Any] = Body(default={})):
    """Create a new *secondary* text derived from primary text ``id``. The secondary
    text has no syllables/raw_text of its own (stored empty); its content is composed
    from the parent's syllables plus derivation_ops (Part 4). Only a primary text may
    be a parent."""
    conn = get_db()
    cursor = conn.cursor()
    parent = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not parent:
        conn.close()
        raise HTTPException(404, "Text not found")
    if parent["text_type"] != "primary":
        conn.close()
        raise HTTPException(400, "Only a primary text can be derived from.")

    title = (payload or {}).get("title") or f"{parent['title']} (secondary)"
    cursor.execute(
        """
        INSERT INTO texts (filename, title, source_text, raw_text, units_json,
                           text_type, parent_text_id)
        VALUES (?, ?, '', '', '[]', 'secondary', ?)
        """,
        (parent["filename"], title, id),
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    conn.close()
    return {**row, "units": [], "span_count": 0, "tag_count": 0}


@router.post("/{id}/extract", response_model=TextDetailOut)
def extract_text(id: int, payload: ExtractIn):
    """Extract a syllable range ``[start_syl_id..end_syl_id]`` of a primary text into a new,
    independent primary text, and reversibly remove that range from the source (a
    delete-suggestion). Syllable-native: the range is addressed by uuid, not offsets."""
    conn = get_db()
    cursor = conn.cursor()
    src = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not src:
        conn.close()
        raise HTTPException(404, "Text not found")
    if src["text_type"] != "primary":
        conn.close()
        raise HTTPException(400, "Only a primary text can be extracted from.")

    syls = load_syllables(conn, id)
    by_id = {s["id"]: s for s in syls}
    ids = syllable_ids_between(syls, payload.start_syl_id, payload.end_syl_id)
    if not ids:
        conn.close()
        raise HTTPException(400, "Selection endpoints must be syllables of this text, in order")

    extracted = "".join(by_id[sid]["text"] for sid in ids)
    # Derived offsets (frontend-facing aid) bound the reversible delete on the source.
    start_off = by_id[ids[0]]["start_offset"]
    end_off = by_id[ids[-1]]["end_offset"]

    title = (payload.title or "").strip() or _extract_title(extracted)
    new_id = _create_primary_text(conn, src["filename"], title, extracted)
    _insert_delete_suggestion(conn, id, start_off, end_off, ids[0], ids[-1])
    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    conn.close()
    return {**row, "units": json.loads(row["units_json"]), "span_count": 0, "tag_count": 0}


@router.post("/{id}/clone", response_model=TextDetailOut)
def clone_text(id: int, payload: CloneIn = Body(default=CloneIn())):
    """Duplicate a primary text with its edits baked in: the new text's raw_text is the
    source's *corrected* text (all suggestions, incl. section deletions, applied). The
    duplicate records ``cloned_from_text_id`` so the text list can badge original vs
    duplicate; deleting the original NULLs that pointer (FK ON DELETE SET NULL)."""
    conn = get_db()
    cursor = conn.cursor()
    src = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not src:
        conn.close()
        raise HTTPException(404, "Text not found")
    if src["text_type"] != "primary":
        conn.close()
        raise HTTPException(400, "Only a primary text can be duplicated.")

    got = _text_corrected(conn, id)
    corrected_text = got[1] if got else (src["raw_text"] or "")
    # Keep the same title — the list badges disambiguate, so no rename is needed.
    title = (payload.title or "").strip() if payload else ""
    title = title or src["title"]
    new_id = _create_primary_text(conn, src["filename"], title, corrected_text,
                                  cloned_from_text_id=id)
    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    conn.close()
    return {**row, "units": json.loads(row["units_json"]), "span_count": 0, "tag_count": 0}


@router.put("/{id}/main-text-srt-dir", response_model=TextDetailOut)
def set_main_text_srt_dir(id: int, payload: Dict[str, Any] = Body(...)):
    """Store the base folder where this text's main-text/audio-sync SRTs live, so the
    alignment tab can reparse a session from disk (folder + the session's catalog
    ``srt_filename``) instead of a manual per-file upload. Empty string clears it.
    The path is validated to exist (a directory) when non-empty."""
    raw = payload.get("main_text_srt_dir")
    path = (raw or "").strip() or None
    if path is not None and not os.path.isdir(path):
        raise HTTPException(400, f"Not a folder (or not reachable): {path}")
    conn = get_db()
    cursor = conn.cursor()
    if not cursor.execute("SELECT 1 FROM texts WHERE id = ?", (id,)).fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")
    cursor.execute("UPDATE texts SET main_text_srt_dir = ? WHERE id = ?", (path, id))
    conn.commit()
    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count
        FROM texts d WHERE d.id = ?
    """, (id,))
    res = dict(cursor.fetchone())
    conn.close()
    res["units"] = json.loads(res["units_json"])
    return res


@router.put("/{id}/audio-dir", response_model=TextDetailOut)
def set_audio_dir(id: int, payload: Dict[str, Any] = Body(...)):
    """Store the local folder where this text's per-session WAV audio lives, so the
    Transcriptions tab can play each segment's audio for proofreading. Empty string
    clears it. The path is validated to exist (a directory) when non-empty. This is
    a playback aid only — it does not touch the SRT/alignment flow."""
    raw = payload.get("audio_dir")
    path = (raw or "").strip() or None
    if path is not None and not os.path.isdir(path):
        raise HTTPException(400, f"Not a folder (or not reachable): {path}")
    conn = get_db()
    cursor = conn.cursor()
    if not cursor.execute("SELECT 1 FROM texts WHERE id = ?", (id,)).fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")
    cursor.execute("UPDATE texts SET audio_dir = ? WHERE id = ?", (path, id))
    conn.commit()
    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count
        FROM texts d WHERE d.id = ?
    """, (id,))
    res = dict(cursor.fetchone())
    conn.close()
    res["units"] = json.loads(res["units_json"])
    return res


@router.get("/{id}/corrected-units")
def get_corrected_units(id: int):
    """Root display units with accepted root suggestions applied to the *text* but
    raw offsets preserved. Read-only; used by the Alignment tab's main-text column so
    accepted corrections show there. The default `GET /{id}` units stay raw (the
    workspace editor edits/creates suggestions against raw offsets)."""
    conn = get_db()
    exists = conn.execute("SELECT 1 FROM texts WHERE id = ?", (id,)).fetchone()
    if not exists:
        conn.close()
        raise HTTPException(404, "Text not found")
    units = corrected_root_units(conn, id)
    conn.close()
    return {"units": units}

@router.get("/{id}/editor-tokens")
def get_editor_tokens(id: int):
    """The corrected root syllable layer for the workspace tagger (Phase 3 E1):
    one entry per syllable `{idx, id, text, nature, inserted, start_offset,
    end_offset}`, corrected text with accepted suggestions applied. The frontend
    renders this as the live selectable text and derives both syllable-UUID anchors
    and raw offsets from it. Read-only."""
    from ..exporters.manifest_exporter import build_editor_tokens
    from ..derivation import compose_secondary
    conn = get_db()
    try:
        row = conn.execute("SELECT text_type FROM texts WHERE id = ?", (id,)).fetchone()
        if not row:
            raise HTTPException(404, "Text not found")
        # A secondary text's editor tokens are its composed derivation (parent links +
        # overrides + added/transcluded), tagged with `source` provenance.
        if row["text_type"] == "secondary":
            return {"tokens": compose_secondary(conn, id)}
        return {"tokens": build_editor_tokens(conn, id)}
    finally:
        conn.close()


@router.post("/{id}/retokenize", response_model=TextDetailOut)
def retokenize_text(id: int):
    """Re-fold spaces and re-run the tokenizer on the stored raw_text, then rebuild
    the syllable layer. Use this after a tokenizer / space-folding upgrade to bring an
    already-imported text up to date (e.g. older imports whose raw_text still holds
    NO-BREAK SPACE U+00A0 that splits a ``། །`` punctuation cluster into three tokens).

    Space-folding is length-preserving (``normalize_spaces`` maps each space-like char
    to one char), so every character offset — and thus every offset-based annotation
    (spans, suggestions, notes, portions) — is unaffected. The syllable layer is
    rebuilt through the move-stable reconciler (``persist_syllables``), so TEXT syllable
    UUIDs are carried across the merge; only the collapsed punctuation token's identity
    changes.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM texts WHERE id = ?", (id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Text not found")

    old_raw = row["raw_text"]
    raw_text, units = prepare_and_tokenize(old_raw)
    if len(raw_text) != len(old_raw):
        conn.close()
        raise HTTPException(500, "re-normalization changed text length; offsets would shift")
    units_json = json.dumps(units, ensure_ascii=False)

    cursor.execute(
        "UPDATE texts SET raw_text = ?, units_json = ? WHERE id = ?",
        (raw_text, units_json, id)
    )
    persist_syllables(conn, id, row["instance_id"] or default_instance_id(row["title"]), raw_text)

    # Re-tile every session's portions onto the rebuilt syllable grid: collapsing a
    # cluster (e.g. ``།␣།``) merges two tokens, so an old portion boundary can now fall
    # inside the merged token, leaving it partially covered. Snapping fixes this without
    # re-uploading each session's SRT. Offsets are otherwise unchanged.
    syllables = load_syllables(conn, id)
    sessions = cursor.execute(
        "SELECT id FROM tags WHERE text_id = ? AND open_position IS NOT NULL", (id,)
    ).fetchall()
    resnapped = 0
    for sess in sessions:
        portions = [
            dict(p) for p in cursor.execute(
                "SELECT id, start_offset, end_offset FROM text_portions WHERE session_tag_id = ?",
                (sess["id"],),
            )
        ]
        if snap_portions_to_syllables(portions, syllables):
            for p in portions:
                conn.execute(
                    "UPDATE text_portions SET start_offset = ?, end_offset = ? WHERE id = ?",
                    (p["start_offset"], p["end_offset"], p["id"]),
                )
            resnapped += 1

    # Snap section boundaries (sapche-section markers + tree-node segment_starts) onto the
    # rebuilt syllable grid too, so a merged punctuation cluster is never split across two
    # sections — it joins the preceding section (yig-mgo → following).
    syls_sorted = sorted(syllables, key=lambda s: s["start_offset"])
    starts = [s["start_offset"] for s in syls_sorted]
    moved_markers = 0
    for mk in cursor.execute(
        "SELECT id, position FROM markers WHERE text_id = ?", (id,)
    ).fetchall():
        np = snap_section_boundary(mk["position"], syls_sorted, starts)
        if np == mk["position"]:
            continue
        clash = cursor.execute(
            "SELECT 1 FROM markers WHERE text_id = ? AND position = ? AND id != ?",
            (id, np, mk["id"]),
        ).fetchone()
        if clash:  # another marker already sits there → this one collapses into it
            conn.execute("DELETE FROM markers WHERE id = ?", (mk["id"],))
        else:
            conn.execute("UPDATE markers SET position = ? WHERE id = ?", (np, mk["id"]))
        moved_markers += 1
    moved_nodes = 0
    for tn in cursor.execute(
        "SELECT id, segment_start FROM tree_nodes "
        "WHERE text_id = ? AND segment_start IS NOT NULL", (id,)
    ).fetchall():
        np = snap_section_boundary(tn["segment_start"], syls_sorted, starts)
        if np != tn["segment_start"]:
            conn.execute("UPDATE tree_nodes SET segment_start = ? WHERE id = ?", (np, tn["id"]))
            moved_nodes += 1
    conn.commit()

    cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count
        FROM texts d WHERE d.id = ?
    """, (id,))
    res = dict(cursor.fetchone())
    conn.close()

    res["units"] = units
    return res


@router.delete("/{id}")
def delete_text(id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM texts WHERE id = ?", (id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Text not found")
    return {"status": "ok"}
