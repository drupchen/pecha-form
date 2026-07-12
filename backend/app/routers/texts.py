from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends, Body
from typing import List, Any, Dict
import os
import sqlite3
from typing import Optional

from ..db import get_db
from ..schemas import TextOut, TextDetailOut, ExtractIn, CloneIn, TextMetaUpdate
from .text_groups import normalize_group_path
from ..tokenizer import prepare_and_tokenize
from ..manifest import (
    persist_syllables, default_instance_id, corrected_root_units, load_syllables,
    syllable_ids_between, _text_corrected, units_from_syllables,
    offset_to_syllable_index,
)

router = APIRouter(prefix="/api/texts", tags=["texts"])


def _units_for(conn, text_id: int):
    """The text's units, DERIVED from its token sequence (Part 6: units are a
    projection, not a stored ``units_json`` column). Primaries project their syllable
    partition; secondaries project their COMPOSED sequence (parent refs + ops), which
    carries the same cumulative offsets. A frontend render/selection aid."""
    row = conn.execute("SELECT text_type FROM texts WHERE id = ?", (text_id,)).fetchone()
    if row and row["text_type"] == "secondary":
        from ..derivation import compose_secondary
        return units_from_syllables(compose_secondary(conn, text_id))
    return units_from_syllables(load_syllables(conn, text_id))


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
    # The fallback slug is suffixed with the text id: syllable uuids are minted from
    # (instance_id, idx, text), so instance ids MUST be unique per text or two texts
    # sharing (idx, syllable) mint the SAME uuid — Tibetan titles all slug to
    # "instance", which broke global uuid uniqueness (the title-bleed bug).
    instance_id = (instance_id or "").strip() \
        or f"{default_instance_id(fallback_title)}_t{doc_id}"
    conn.execute(
        "UPDATE texts SET instance_id = ?, teaching_id = COALESCE(?, teaching_id), "
        "title_bo = COALESCE(?, title_bo), access_level = COALESCE(?, access_level) "
        "WHERE id = ?",
        (instance_id, teaching_id, title_bo, access_level, doc_id),
    )
    # Part 6, Phase 3: the syllables table is the sole tokenisation. Units are derived
    # from it on read (_units_for); annotations are anchored by syllable UUID, so there
    # are no cached offsets to heal when the syllable layer is (re)built.
    persist_syllables(conn, doc_id, instance_id, raw_text)
    return instance_id


def _create_primary_text(conn, filename: str, title: str, source_text: str,
                         cloned_from_text_id: Optional[int] = None) -> int:
    """Create a fresh, independent primary text from a raw string, building its own
    syllable layer (fresh instance_id + uuids). Shared by /extract and /clone. Mirrors
    the tokenize→insert→persist_syllables path of upload_text."""
    raw_text, _units = prepare_and_tokenize(source_text)
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, cloned_from_text_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (filename, title, source_text, raw_text, cloned_from_text_id),
    )
    new_id = cur.lastrowid
    _apply_instance_metadata(conn, new_id, raw_text, None, fallback_title=title)
    return new_id


def _extract_title(text: str) -> str:
    """A short default title from the extracted text (first ~30 chars, one line)."""
    flat = " ".join((text or "").split())
    return (flat[:30].rstrip() or "extract")


def _insert_delete_suggestion(conn, text_id: int, start_off: int, end_off: int,
                              start_syl_id: str, end_syl_id: str,
                              extracted_text_id: Optional[int] = None) -> None:
    """Reversibly remove a raw-text range by recording a delete-suggestion (empty
    replacement). Non-destructive: raw_text/syllables are untouched; deleting the row
    restores the range. Offsets here are the existing frontend-facing suggestion aid.

    ``extracted_text_id`` (set by /extract) labels this delete as an *extraction* and
    links the text the range was moved into, so the UI can show "extracted → <title>"
    (and offer to open it) rather than a plain "removed".

    Guards against overlapping an existing suggestion the same way the normal
    delete-section path does: extracting two overlapping ranges must not create
    overlapping delete-suggestions (which would otherwise make one of them unplaceable
    on read). If the range overlaps an existing suggestion it is already (partly)
    covered, so we skip creating a redundant/overlapping row."""
    if end_off <= start_off:
        return
    from fastapi import HTTPException
    from ..syllable_anchors import _syl_offset_maps
    from .suggestions import _existing_suggestions, _check_overlap
    id2start, id2end = _syl_offset_maps(conn, text_id)
    try:
        _check_overlap(_existing_suggestions(conn, text_id, id2start, id2end),
                       start_off, end_off)
    except HTTPException:
        return  # overlaps an existing suggestion — don't create an overlapping row
    conn.execute(
        "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id, "
        "extracted_text_id) VALUES (?, '', ?, ?, ?)",
        (text_id, start_syl_id, end_syl_id, extracted_text_id),
    )


def _snap_refs_after_bake(conn, text_id: int, old_ordered_ids: list[str]) -> None:
    """Re-anchor every syllable-uuid reference that pointed at content this bake
    deleted, snapping to the nearest surviving syllable so nothing silently vanishes.

    Baking keeps uuids for surviving syllables, but a deleted syllable's uuid drops
    from the layer — and a transclusion/span/note whose RANGE ENDPOINT died would
    otherwise lose its whole run (`syllable_ids_between` can't resolve). Uuids are
    globally unique, so deleted ids are matched across ALL texts' rows (descendants'
    ops/annotations anchor this text's syllables directly).

    Rules: range starts snap FORWARD and ends snap BACKWARD along the old order
    (rows whose range has nothing surviving are left untouched — the dangling-skip
    behavior remains the graceful floor); "before this syllable" anchors snap forward
    or become NULL (= end of text); MARKERS and display-breaks whose anchor died are
    DELETED (a boundary/break whose syllable was rewritten should die, not wander to
    the next survivor — a wandered boundary silently mis-splits descendants); reading
    positions snap forward, else backward; tree segment links snap forward or stay
    dangling. Snapped ranges that reverse in the NEW order are left dangling."""
    new_ordered = [s["id"] for s in load_syllables(conn, text_id)]
    new_ids = set(new_ordered)
    new_pos = {sid: i for i, sid in enumerate(new_ordered)}
    deleted = [sid for sid in old_ordered_ids if sid not in new_ids]
    if not deleted:
        return
    # For each old position: the nearest surviving id at-or-after / at-or-before it.
    n = len(old_ordered_ids)
    nxt: list = [None] * n
    prv: list = [None] * n
    run = None
    for i in range(n - 1, -1, -1):
        if old_ordered_ids[i] in new_ids:
            run = old_ordered_ids[i]
        nxt[i] = run
    run = None
    for i in range(n):
        if old_ordered_ids[i] in new_ids:
            run = old_ordered_ids[i]
        prv[i] = run
    pos = {sid: i for i, sid in enumerate(old_ordered_ids)}
    dead = set(deleted)

    def snap_fwd(sid):  # None = nothing survives at-or-after sid
        return nxt[pos[sid]]

    def snap_back(sid):
        return prv[pos[sid]]

    def q(ids):
        return ",".join("?" * len(ids))

    # Ranges: (table, start_col, end_col, extra WHERE). Includes the translation
    # layer (T1–T3) so translations/phonetics/moves anchored on deleted syllables
    # snap with everything else rather than silently orphaning.
    for table, s_col, e_col, extra in (
        ("derivation_ops", "src_start_syl_id", "src_end_syl_id", "op_kind = 'transclude'"),
        ("passage_members", "src_start_syl_id", "src_end_syl_id", "1=1"),
        ("spans", "start_syl_id", "end_syl_id", "1=1"),
        ("notes", "start_syl_id", "end_syl_id", "1=1"),
        ("suggestions", "start_syl_id", "end_syl_id", "1=1"),
        ("translation_chunks", "start_syl_id", "end_syl_id", "1=1"),
        ("phonetics", "start_syl_id", "end_syl_id", "1=1"),
        ("chunk_layouts", "src_start_syl_id", "src_end_syl_id", "kind = 'move'"),
    ):
        rows = conn.execute(
            f"SELECT rowid AS rid, {s_col} AS s, {e_col} AS e FROM {table} "
            f"WHERE {extra} AND ({s_col} IN ({q(deleted)}) OR {e_col} IN ({q(deleted)}))",
            (*deleted, *deleted),
        ).fetchall()
        for r in rows:
            new_s = snap_fwd(r["s"]) if r["s"] in dead else r["s"]
            new_e = snap_back(r["e"]) if r["e"] in dead else r["e"]
            # Leave untouched when nothing survives inside the range (start/end
            # crossed or vanished) — the row stays dangling and is skipped on read.
            if new_s is None or new_e is None:
                continue
            # Reversed in the NEW order (a snapped pair can invert even when the
            # old order was consistent) — leave dangling, skipped on read.
            if new_s in new_pos and new_e in new_pos and new_pos[new_s] > new_pos[new_e]:
                continue
            try:
                conn.execute(
                    f"UPDATE {table} SET {s_col} = ?, {e_col} = ? WHERE rowid = ?",
                    (new_s, new_e, r["rid"]),
                )
            except sqlite3.IntegrityError:
                # UNIQUE collision (translation_chunks/phonetics share
                # (origin, start, end[, kind])) — leave the row dangling rather
                # than merge two distinct anchors into one.
                pass

    # "Before this syllable" anchors: forward, else NULL (= end of text).
    for table, col in (("derivation_ops", "anchor_syl_id"), ("passages", "anchor_syl_id"),
                       ("chunk_layouts", "anchor_syl_id")):
        rows = conn.execute(
            f"SELECT rowid AS rid, {col} AS a FROM {table} WHERE {col} IN ({q(deleted)})",
            deleted,
        ).fetchall()
        for r in rows:
            conn.execute(f"UPDATE {table} SET {col} = ? WHERE rowid = ?",
                         (snap_fwd(r["a"]), r["rid"]))

    # Markers: a segment boundary whose anchor syllable was deleted is DELETED, not
    # snapped forward — the segmentation there was rewritten, so a boundary wandering
    # to the next survivor would silently mis-split this text and its descendants
    # (the copied-marker-on-a-child bug). Same for display breaks: a break has no
    # home once its syllable is gone.
    conn.execute(f"DELETE FROM markers WHERE syl_id IN ({q(deleted)})", deleted)
    conn.execute(f"DELETE FROM display_breaks WHERE syl_id IN ({q(deleted)})", deleted)

    # Reading positions: forward, else backward.
    for r in conn.execute(
            f"SELECT rowid AS rid, syl_id AS a FROM reading_positions "
            f"WHERE syl_id IN ({q(deleted)})", deleted).fetchall():
        tgt = snap_fwd(r["a"]) or snap_back(r["a"])
        if tgt is not None:
            conn.execute("UPDATE reading_positions SET syl_id = ? WHERE rowid = ?",
                         (tgt, r["rid"]))

    # Tree segment links: forward; if nothing follows, leave dangling (existing
    # tree behavior for unresolvable links).
    for r in conn.execute(
            f"SELECT rowid AS rid, segment_start_syl_id AS a FROM tree_nodes "
            f"WHERE segment_start_syl_id IN ({q(deleted)})", deleted).fetchall():
        tgt = snap_fwd(r["a"])
        if tgt is not None:
            conn.execute("UPDATE tree_nodes SET segment_start_syl_id = ? WHERE rowid = ?",
                         (tgt, r["rid"]))


def _apply_corrections_core(conn, text_id: int) -> bool:
    """Bake the text's staged suggestions into its base layer — the ripple mechanism.

    ``raw_text`` becomes the corrected text and the syllable layer is re-persisted with
    stable-id reconciliation (``id_reconcile`` via ``persist_syllables``: an *edited*
    syllable KEEPS its uuid, an inserted one is minted, a deleted one drops). Because
    every downstream reference — derivation ops, spans, markers, tree links, notes,
    reading positions, and descendants' parent-links — anchors by syllable uuid, a
    correction baked here ripples through all texts based on this one, any depth.
    References to content the bake deleted are snapped to the nearest surviving
    syllable (``_snap_refs_after_bake``); only ranges with nothing surviving inside
    are left dangling and skipped on read.

    The consumed suggestions are deleted (they are now part of the base). Only APPLIED
    suggestions bake — 'pending' rows (incoming from derived texts, awaiting review)
    survive untouched, their uuid anchors intact. Returns True if anything was baked,
    False for a no-op (no applied suggestions)."""
    n = conn.execute(
        "SELECT COUNT(*) FROM suggestions WHERE text_id = ? AND status = 'applied'",
        (text_id,),
    ).fetchone()[0]
    if n == 0:
        return False
    got = _text_corrected(conn, text_id)
    if got is None:
        return False
    instance_id, corrected_text, _segments = got
    old_ordered_ids = [s["id"] for s in load_syllables(conn, text_id)]
    # Same normalization as upload/clone so the base layer stays canonical.
    raw_text, _units = prepare_and_tokenize(corrected_text)
    row = conn.execute("SELECT title, filename FROM texts WHERE id = ?", (text_id,)).fetchone()
    instance = (instance_id or "").strip() \
        or f"{default_instance_id(row['title'] or row['filename'] or '')}_t{text_id}"
    conn.execute(
        "UPDATE texts SET raw_text = ?, instance_id = ? WHERE id = ?",
        (raw_text, instance, text_id),
    )
    persist_syllables(conn, text_id, instance, raw_text)
    conn.execute("DELETE FROM suggestions WHERE text_id = ? AND status = 'applied'", (text_id,))
    _snap_refs_after_bake(conn, text_id, old_ordered_ids)
    return True


def _apply_one_suggestion_core(conn, suggestion_id: int) -> bool:
    """Bake ONE suggestion into its text's base layer and delete it — the
    "accept & ripple" path for an incoming upstream suggestion.

    Same stable-id mechanics as ``_apply_corrections_core`` (an edited syllable keeps
    its uuid, so every derived text picks the fix up immediately), but splicing only
    this row: the owner's other staged corrections remain staged and un-baked, their
    anchors intact."""
    from ..suggestion_applier import splice_suggestions, segments_text

    row = conn.execute(
        "SELECT * FROM suggestions WHERE id = ?", (suggestion_id,)
    ).fetchone()
    if row is None:
        return False
    text_id = row["text_id"]
    txt = conn.execute(
        "SELECT title, filename, instance_id FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    raw_syllables = load_syllables(conn, text_id)
    old_ordered_ids = [s["id"] for s in raw_syllables]
    segments = splice_suggestions(raw_syllables, [dict(row)])
    raw_text, _units = prepare_and_tokenize(segments_text(segments))
    instance = (txt["instance_id"] or "").strip() \
        or f"{default_instance_id(txt['title'] or txt['filename'] or '')}_t{text_id}"
    conn.execute(
        "UPDATE texts SET raw_text = ?, instance_id = ? WHERE id = ?",
        (raw_text, instance, text_id),
    )
    persist_syllables(conn, text_id, instance, raw_text)
    conn.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
    _snap_refs_after_bake(conn, text_id, old_ordered_ids)
    return True


@router.post("/{id}/apply-corrections", response_model=TextDetailOut)
def apply_corrections(id: int):
    """Bake all staged suggestions into the primary's base layer so they ripple to
    every text derived from it (see ``_apply_corrections_core``). Primaries only —
    a secondary's edits are derivation ops, not suggestions."""
    conn = get_db()
    cursor = conn.cursor()
    src = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not src:
        conn.close()
        raise HTTPException(404, "Text not found")
    if src["text_type"] != "primary":
        conn.close()
        raise HTTPException(400, "Only a primary text's corrections can be applied to its base.")
    _apply_corrections_core(conn, id)
    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone())
    units = _units_for(conn, id)
    span_count = cursor.execute(
        "SELECT COUNT(*) FROM spans WHERE text_id = ?", (id,)).fetchone()[0]
    tag_count = cursor.execute(
        "SELECT COUNT(*) FROM tags WHERE text_id = ?", (id,)).fetchone()[0]
    conn.close()
    return {**row, "units": units, "span_count": span_count, "tag_count": tag_count}


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

    raw_text, _units = prepare_and_tokenize(source_text)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO texts (filename, title, source_text, raw_text)
        VALUES (?, ?, ?, ?)
        """,
        (file.filename, doc_title, source_text, raw_text)
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
    res["units"] = _units_for(conn, id)
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

@router.patch("/{id}", response_model=TextOut)
def update_text_meta(id: int, patch: TextMetaUpdate):
    """Edit a text's list-view metadata: its title (inline rename) and/or its group
    (collection label; empty string clears it to NULL == ungrouped). Only provided
    fields change. Does not bump updated_at, so a rename/regroup won't reorder the list."""
    provided = patch.model_dump(exclude_unset=True)
    conn = get_db()
    cursor = conn.cursor()
    if not cursor.execute("SELECT id FROM texts WHERE id = ?", (id,)).fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    sets, params = [], []
    if "title" in provided:
        title = (patch.title or "").strip()
        if not title:
            conn.close()
            raise HTTPException(400, "Title cannot be empty")
        sets.append("title = ?")
        params.append(title)
    if "text_group" in provided:
        # A group is a "/"-separated path (arbitrary-depth sub-groups); normalize it the
        # same way the text-groups router does (all-empty → NULL == ungrouped).
        sets.append("text_group = ?")
        params.append(normalize_group_path(patch.text_group))

    if sets:
        params.append(id)
        cursor.execute(f"UPDATE texts SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()

    row = cursor.execute("""
        SELECT d.*,
               (SELECT COUNT(*) FROM spans WHERE text_id = d.id) as span_count,
               (SELECT COUNT(*) FROM tags WHERE text_id = d.id) as tag_count,
               EXISTS(SELECT 1 FROM texts c WHERE c.cloned_from_text_id = d.id) as has_clone
        FROM texts d WHERE d.id = ?
    """, (id,)).fetchone()
    conn.close()
    return dict(row)

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
    if not row:
        conn.close()
        raise HTTPException(404, "Text not found")

    res = dict(row)
    res["units"] = _units_for(conn, id)
    conn.close()
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
    """Create a new *secondary* text derived from text ``id`` — primary OR secondary,
    so derivation chains of any depth work. The secondary stores no base text of its
    own; it composes on read from its parent's sequence plus its own derivation ops,
    which is what makes corrections baked into the root primary ripple into every
    descendant automatically.

    Deriving from a primary first BAKES the parent's staged corrections into its base
    (``_apply_corrections_core``), so the child starts from the corrected view and both
    share the stable base uuids. The parent's current annotations (tags/spans, markers,
    notes, passages) and TOC are then copied onto the child — an identity remap, since a
    parent-link token IS the parent's syllable — after which the two annotation sets are
    fully independent."""
    conn = get_db()
    cursor = conn.cursor()
    parent = cursor.execute("SELECT * FROM texts WHERE id = ?", (id,)).fetchone()
    if not parent:
        conn.close()
        raise HTTPException(404, "Text not found")

    # Freeze the corrected view as the shared base (primaries only — a secondary's
    # edits are already ops over its parent).
    if parent["text_type"] == "primary":
        _apply_corrections_core(conn, id)

    title = (payload or {}).get("title") or f"{parent['title']} (secondary)"
    cursor.execute(
        """
        INSERT INTO texts (filename, title, source_text, raw_text,
                           text_type, parent_text_id)
        VALUES (?, ?, '', '', 'secondary', ?)
        """,
        (parent["filename"], title, id),
    )
    new_id = cursor.lastrowid

    # A secondary COPIES nothing structural — it inherits the parent chain's spans,
    # markers, notes, passages AND tree LIVE on read (app/inherit.source_texts), so
    # every later change on the parent mirrors here. (extract/clone still snapshot,
    # since those make independent texts.)
    from ..derivation import base_tokens
    src_tokens = base_tokens(conn, id)
    remap = {t["id"]: t["id"] for t in src_tokens}
    _copy_annotations(conn, id, new_id, remap, src_tokens, copy_tree=False,
                      copy_spans=False, copy_markers=False, copy_notes=False,
                      copy_passages=False)

    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    units = _units_for(conn, new_id)
    # Inherited from the parent chain on read — report what the child will display.
    span_count = cursor.execute(
        "SELECT COUNT(*) FROM spans WHERE text_id = ?", (id,)).fetchone()[0]
    tag_count = cursor.execute(
        "SELECT COUNT(*) FROM tags WHERE text_id = ?", (new_id,)).fetchone()[0]
    conn.close()
    return {**row, "units": units, "span_count": span_count, "tag_count": tag_count}


def _copy_annotations(conn, src_id: int, new_id: int, remap: dict, src_syls: list,
                      *, copy_tree: bool = False, copy_spans: bool = True,
                      copy_markers: bool = True, copy_notes: bool = True,
                      copy_passages: bool = True) -> None:
    """Copy the source's syllable-anchored annotations onto ``new_id``, re-anchoring every
    id through ``remap`` (source_syl_id -> new_syl_id). Anchors absent from ``remap`` (an
    out-of-range syllable for /extract, or one baked away by /clone) are dropped, and a
    span straddling them is clamped to its surviving syllables.

    Copies regular-tag **spans** (+ tag defs: shared reused, private recreated, session
    re-anchored), segment **markers**, **notes** (+ categories, + session links), fully
    -contained **passages**, and — when ``copy_tree`` — the whole **tree (TOC)** preserving
    hierarchy. Idempotent via unique constraints + ``INSERT OR IGNORE``. Shared by /extract
    (relative-offset remap) and /clone (suggestion-bake remap). ``src_syls`` is the source's
    ordered syllable list (used to resolve each span's run).

    ``copy_spans=False`` for /derive: a secondary INHERITS ancestor spans live on read
    (``spans._span_source_texts``) — copying them would freeze the tagging at derive
    time instead of mirroring later changes."""
    if not remap:
        return
    pos_of = {s["id"]: i for i, s in enumerate(src_syls)}

    # --- Tags: shared (NULL owner) reused as-is; private recreated privately on new_id.
    tag_remap: dict = {}  # source tag id -> a tag id valid on new_id (or None if unmappable)

    def _resolve_tag(old_tag_id):
        if old_tag_id in tag_remap:
            return tag_remap[old_tag_id]
        row = conn.execute(
            "SELECT id, text_id, name, color, tag_kind, open_syl_id, close_syl_id "
            "FROM tags WHERE id = ?", (old_tag_id,),
        ).fetchone()
        if row is None:
            tag_remap[old_tag_id] = None
            return None
        if row["text_id"] is None:  # shared tag — every text sees it already
            tag_remap[old_tag_id] = row["id"]
            return row["id"]
        open_syl = close_syl = None
        if row["tag_kind"] == "session":  # per-text anchors: only if fully in-range
            if row["open_syl_id"] not in remap or row["close_syl_id"] not in remap:
                tag_remap[old_tag_id] = None
                return None
            open_syl, close_syl = remap[row["open_syl_id"]], remap[row["close_syl_id"]]
        conn.execute(
            "INSERT OR IGNORE INTO tags "
            "(text_id, name, color, tag_kind, open_syl_id, close_syl_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (new_id, row["name"], row["color"], row["tag_kind"], open_syl, close_syl),
        )
        got = conn.execute(
            "SELECT id FROM tags WHERE text_id = ? AND name = ?", (new_id, row["name"]),
        ).fetchone()
        tag_remap[old_tag_id] = got["id"] if got else None
        return tag_remap[old_tag_id]

    # --- Spans: map each source span's syllable run through remap; write the surviving
    # sub-run (this naturally clamps a span that straddles dropped/baked-away syllables).
    for sp in (conn.execute(
        "SELECT tag_id, start_syl_id, end_syl_id FROM spans WHERE text_id = ?", (src_id,),
    ).fetchall() if copy_spans else []):
        i, j = pos_of.get(sp["start_syl_id"]), pos_of.get(sp["end_syl_id"])
        if i is None or j is None or i > j:
            continue
        survivors = [remap[src_syls[k]["id"]] for k in range(i, j + 1) if src_syls[k]["id"] in remap]
        if not survivors:
            continue
        new_tag = _resolve_tag(sp["tag_id"])
        if new_tag is None:
            continue
        conn.execute(
            "INSERT INTO spans (text_id, tag_id, start_syl_id, end_syl_id) VALUES (?, ?, ?, ?)",
            (new_id, new_tag, survivors[0], survivors[-1]),
        )

    # --- Markers: single-boundary; skip the NULL end-of-text sentinel and out-of-range.
    # A DERIVE inherits boundaries live (copy_markers=False, like copy_spans); only an
    # independent copy (extract/clone) snapshots them.
    if copy_markers:
        for mk in conn.execute(
            "SELECT syl_id FROM markers WHERE text_id = ?", (src_id,),
        ).fetchall():
            nid = remap.get(mk["syl_id"])
            if nid is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO markers (text_id, syl_id) VALUES (?, ?)",
                    (new_id, nid),
                )

    # --- Notes: range fully in-range; recreate category by name; copy session links.
    cat_remap: dict = {}

    def _resolve_category(old_cat_id):
        if old_cat_id is None:
            return None
        if old_cat_id in cat_remap:
            return cat_remap[old_cat_id]
        row = conn.execute(
            "SELECT name FROM note_categories WHERE id = ?", (old_cat_id,),
        ).fetchone()
        if row is None:
            cat_remap[old_cat_id] = None
            return None
        conn.execute(
            "INSERT OR IGNORE INTO note_categories (text_id, name) VALUES (?, ?)",
            (new_id, row["name"]),
        )
        got = conn.execute(
            "SELECT id FROM note_categories WHERE text_id = ? AND name = ?",
            (new_id, row["name"]),
        ).fetchone()
        cat_remap[old_cat_id] = got["id"] if got else None
        return cat_remap[old_cat_id]

    for nt in (conn.execute(
        "SELECT id, category_id, body, start_syl_id, end_syl_id FROM notes WHERE text_id = ?",
        (src_id,),
    ).fetchall() if copy_notes else []):
        if nt["start_syl_id"] not in remap or nt["end_syl_id"] not in remap:
            continue
        cur = conn.execute(
            "INSERT INTO notes (text_id, category_id, body, start_syl_id, end_syl_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (new_id, _resolve_category(nt["category_id"]), nt["body"],
             remap[nt["start_syl_id"]], remap[nt["end_syl_id"]]),
        )
        new_note_id = cur.lastrowid
        for ns in conn.execute(
            "SELECT tag_id FROM note_sessions WHERE note_id = ?", (nt["id"],),
        ).fetchall():
            new_tag = _resolve_tag(ns["tag_id"])
            if new_tag is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO note_sessions (note_id, tag_id) VALUES (?, ?)",
                    (new_note_id, new_tag),
                )

    # --- Passages: copy only if the anchor AND every member run are fully in-range
    # (a transclusion source outside the extracted range cannot be linked).
    for pg in (conn.execute(
        "SELECT id, anchor_syl_id, position, color FROM passages WHERE text_id = ?",
        (src_id,),
    ).fetchall() if copy_passages else []):
        anchor = pg["anchor_syl_id"]
        if anchor is not None and anchor not in remap:
            continue
        members = conn.execute(
            "SELECT position, src_start_syl_id, src_end_syl_id FROM passage_members "
            "WHERE passage_id = ? ORDER BY position", (pg["id"],),
        ).fetchall()
        if not members or any(
            m["src_start_syl_id"] not in remap or m["src_end_syl_id"] not in remap
            for m in members
        ):
            continue
        cur = conn.execute(
            "INSERT INTO passages (text_id, anchor_syl_id, position, color) VALUES (?, ?, ?, ?)",
            (new_id, remap.get(anchor), pg["position"], pg["color"]),
        )
        new_pg_id = cur.lastrowid
        for m in members:
            conn.execute(
                "INSERT INTO passage_members "
                "(passage_id, position, src_start_syl_id, src_end_syl_id) VALUES (?, ?, ?, ?)",
                (new_pg_id, m["position"], remap[m["src_start_syl_id"]], remap[m["src_end_syl_id"]]),
            )

    # --- Tree (clone only): duplicate the whole TOC, preserving hierarchy. A node's
    # segment link is re-anchored through remap (NULL when its segment start was baked
    # away); a node left with neither title nor link gets a placeholder to satisfy the
    # CHECK constraint. Two passes so parent ids can be remapped after all rows exist.
    if copy_tree:
        rows = conn.execute(
            "SELECT id, parent_id, position, title, segment_start_syl_id, transparent "
            "FROM tree_nodes WHERE text_id = ? ORDER BY id", (src_id,),
        ).fetchall()
        node_id_map: dict = {}
        for r in rows:
            seg = remap.get(r["segment_start_syl_id"]) if r["segment_start_syl_id"] is not None else None
            title = r["title"]
            if title is None and seg is None:
                title = "(section)"
            cur = conn.execute(
                "INSERT INTO tree_nodes (text_id, parent_id, position, title, "
                "segment_start_syl_id, transparent) VALUES (?, NULL, ?, ?, ?, ?)",
                (new_id, r["position"], title, seg, r["transparent"]),
            )
            node_id_map[r["id"]] = cur.lastrowid
        for r in rows:
            if r["parent_id"] is not None and r["parent_id"] in node_id_map:
                conn.execute(
                    "UPDATE tree_nodes SET parent_id = ? WHERE id = ?",
                    (node_id_map[r["parent_id"]], node_id_map[r["id"]]),
                )


def _copy_range_annotations(conn, src_id: int, new_id: int, ids: list,
                            start_off: int, end_off: int, by_id: dict) -> None:
    """/extract: build a relative-offset remap (source syllable -> new syllable at the same
    offset from the extraction start) for the extracted range and copy its in-range
    annotations (no tree). Delegates to ``_copy_annotations``."""
    new_syls = load_syllables(conn, new_id)
    newstart2id = {s["start_offset"]: s["id"] for s in new_syls}
    remap: dict = {}
    for sid in ids:
        rel = by_id[sid]["start_offset"] - start_off
        nid = newstart2id.get(rel)
        if nid is None:  # tokenisation shifted (e.g. a trimmed leading space): fall back
            k = offset_to_syllable_index(new_syls, rel)
            nid = new_syls[k]["id"] if k is not None else None
        if nid is not None:
            remap[sid] = nid
    _copy_annotations(conn, src_id, new_id, remap, load_syllables(conn, src_id), copy_tree=False)


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
    # Carry the section's tags/markers/notes/passages into the new text (remapped to
    # its fresh syllable ids) so extraction preserves the annotations, not just the text.
    _copy_range_annotations(conn, id, new_id, ids, start_off, end_off, by_id)
    _insert_delete_suggestion(conn, id, start_off, end_off, ids[0], ids[-1],
                              extracted_text_id=new_id)
    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    units = _units_for(conn, new_id)
    span_count = cursor.execute(
        "SELECT COUNT(*) FROM spans WHERE text_id = ?", (new_id,)).fetchone()[0]
    tag_count = cursor.execute(
        "SELECT COUNT(*) FROM tags WHERE text_id = ?", (new_id,)).fetchone()[0]
    conn.close()
    return {**row, "units": units, "span_count": span_count, "tag_count": tag_count}


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

    # Carry the source's annotations + TOC into the flattened duplicate, re-anchored through
    # the bake: map each *kept* source syllable to the clone syllable at the same offset in
    # the corrected text (replaced/inserted content is baked in; deleted content is gone, so
    # annotations sitting on it are dropped / spans clamped).
    segments = got[2] if got else []
    clone_syls = load_syllables(conn, new_id)
    clonestart2id = {s["start_offset"]: s["id"] for s in clone_syls}
    remap: dict = {}
    pos = 0
    for seg in segments:
        if seg["kind"] == "keep":
            syl = seg["syl"]
            cid = clonestart2id.get(pos)
            if cid is None:  # re-tokenisation shifted a boundary — fall back to containment
                k = offset_to_syllable_index(clone_syls, pos)
                cid = clone_syls[k]["id"] if k is not None else None
            if cid is not None:
                remap[syl["id"]] = cid
            pos += len(syl["text"])
        else:  # 'edit' — baked replacement/insertion text, no source-syllable provenance
            pos += len(seg["text"])
    _copy_annotations(conn, id, new_id, remap, load_syllables(conn, id), copy_tree=True)

    conn.commit()
    row = dict(cursor.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone())
    units = _units_for(conn, new_id)
    span_count = cursor.execute(
        "SELECT COUNT(*) FROM spans WHERE text_id = ?", (new_id,)).fetchone()[0]
    tag_count = cursor.execute(
        "SELECT COUNT(*) FROM tags WHERE text_id = ?", (new_id,)).fetchone()[0]
    conn.close()
    return {**row, "units": units, "span_count": span_count, "tag_count": tag_count}


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
    res["units"] = _units_for(conn, id)
    conn.close()
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
    res["units"] = _units_for(conn, id)
    conn.close()
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
    raw_text, _units = prepare_and_tokenize(old_raw)
    if len(raw_text) != len(old_raw):
        conn.close()
        raise HTTPException(500, "re-normalization changed text length; offsets would shift")

    cursor.execute("UPDATE texts SET raw_text = ? WHERE id = ?", (raw_text, id))
    # Part 6, Phase 3: rebuild the (single) syllable partition. Annotations are anchored
    # by syllable UUID and the move-stable reconciler carries TEXT syllable ids across the
    # merge, so every derived offset (markers, tree-node segment starts, portions) follows
    # its anchor automatically — no offset re-snapping pass is needed anymore.
    persist_syllables(conn, id,
                      row["instance_id"] or f"{default_instance_id(row['title'])}_t{id}",
                      raw_text)
    conn.commit()

    units = _units_for(conn, id)
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
