"""Compose a secondary text from its parent primary text + a sparse op list.

A *secondary* text (``texts.text_type == 'secondary'``) has ``parent_text_id`` and
no ``raw_text``/syllables of its own except the syllables it *hosts* (real rows in
``syllables`` produced by ``override``/``insert`` ops). Its content is COMPUTED on
read by walking the parent's syllables in ``idx`` order and applying the
``derivation_ops`` anchored by syllable uuid:

- ``parent-link``  — an unchanged parent syllable, emitted as a link (its own uuid).
- ``override``     — a parent syllable replaced in place by hosted syllable(s); the
                     hosted syllable carries ``parent_syl_id`` + ``original``.
- ``delete``       — an anchored parent syllable omitted from the composition.
- ``insert``       — hosted syllable(s) spliced BEFORE an anchor (``source='added'``).
- ``transclude``   — a range LINK from another text spliced BEFORE an anchor.

Syllable-native throughout: every anchor/ref is a ``syl_id`` (uuid); ordering is by
``idx``/``position``. The ``start_offset``/``end_offset`` on the returned tokens are
cumulative offsets over the composed text — a pure frontend rendering/selection aid,
not a stored anchor (mirrors ``manifest.attach_cumulative_offsets``).

The editing side (``edit_range``) drives the existing move-aware token aligner
(``token_align.align_tokens``) at the syllable-uuid-sequence level, bypassing the
char-offset ``suggestion_applier`` path entirely.
"""

from collections import defaultdict

from fastapi import HTTPException

from .manifest import load_syllables, syllable_ids_between, generate_syllables, syllable_id
from .token_align import align_tokens


def _secondary_instance_id(text_id: int) -> str:
    """Stable instance_id used to mint hosted-syllable uuids for this secondary."""
    return f"secondary_{text_id}"


def _hosted_syllables(conn, op_id: int, by_id: dict) -> list[dict]:
    """The ordered hosted syllables (real ``syllables`` rows) produced by an op."""
    rows = conn.execute(
        "SELECT syl_id FROM derivation_op_syllables WHERE op_id = ? ORDER BY position",
        (op_id,),
    ).fetchall()
    return [by_id[r["syl_id"]] for r in rows if r["syl_id"] in by_id]


def base_tokens(conn, text_id: int, _visited=None) -> list[dict]:
    """The ordered token sequence a text exposes to composition and anchoring.

    A primary exposes its own syllable rows; a secondary exposes its *composed*
    sequence (recursion — its parent may itself be a secondary, any depth). This is
    the single definition of "the text's tokens" that derivation, transclusion, and
    the annotation anchor maps all share, so a correction baked into a root primary
    ripples through every descendant automatically."""
    row = conn.execute(
        "SELECT text_type, parent_text_id FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    if row is None:
        return []
    if row["text_type"] == "secondary" and row["parent_text_id"]:
        return compose_secondary(conn, text_id, _visited)
    return load_syllables(conn, text_id)


def compose_secondary(conn, text_id: int, _visited=None) -> list[dict]:
    """Compute the derived syllable sequence for a secondary text.

    The base is the PARENT'S composed sequence (``base_tokens`` — recursive, so
    chains of secondaries work), over which this text's ops are applied. An op whose
    anchor no longer resolves in the base (e.g. the parent baked a deletion of that
    syllable) is silently moot — skipped, never an error, so one dangling anchor can
    never blank a document.

    Returns ordered token dicts ``{idx, id, text, nature, inserted, start_offset,
    end_offset, source, parent_syl_id?, src_text_id?, original?}``. Offsets are
    cumulative over the composed text (frontend aid only)."""
    _visited = set() if _visited is None else _visited
    if text_id in _visited:  # defensive cycle guard (parent chains are acyclic by construction)
        return []
    _visited = _visited | {text_id}

    row = conn.execute("SELECT parent_text_id FROM texts WHERE id = ?", (text_id,)).fetchone()
    parent_id = row["parent_text_id"] if row else None
    if not parent_id:
        return []

    parent_syls = base_tokens(conn, parent_id, _visited)
    hosted_by_id = {s["id"]: s for s in load_syllables(conn, text_id)}

    ops = conn.execute(
        "SELECT * FROM derivation_ops WHERE text_id = ? ORDER BY position, id", (text_id,)
    ).fetchall()
    before: dict[str, list] = defaultdict(list)  # anchor syl_id -> insert/transclude ops
    at: dict = {}                                 # anchor syl_id -> override/delete op
    at_end: list = []                             # anchor NULL -> insert/transclude ops
    for op in ops:
        if op["op_kind"] in ("insert", "transclude"):
            (at_end if op["anchor_syl_id"] is None else before[op["anchor_syl_id"]]).append(op)
        else:  # override / delete — one per anchored parent syllable
            at[op["anchor_syl_id"]] = op

    out: list[dict] = []

    def emit_hosted(op, source: str, parent_syl_id=None, original=None) -> None:
        for s in _hosted_syllables(conn, op["id"], hosted_by_id):
            out.append({
                "id": s["id"], "text": s["text"], "nature": s["nature"],
                "source": source, "parent_syl_id": parent_syl_id, "original": original,
            })

    def emit_transclude(op) -> None:
        # Source ranges resolve through the source's COMPOSED sequence (base_tokens),
        # so transcluding from a secondary works and upstream corrections ripple in.
        src_syls = base_tokens(conn, op["src_text_id"], _visited)
        by = {s["id"]: s for s in src_syls}
        for sid in syllable_ids_between(src_syls, op["src_start_syl_id"], op["src_end_syl_id"]):
            s = by[sid]
            out.append({
                "id": s["id"], "text": s["text"], "nature": s["nature"],
                "source": "transclusion", "src_text_id": op["src_text_id"],
            })

    def emit_spliced(op) -> None:
        if op["op_kind"] == "insert":
            emit_hosted(op, "added")
        else:
            emit_transclude(op)

    for p in parent_syls:
        for op in before.get(p["id"], []):
            emit_spliced(op)
        a = at.get(p["id"])
        if a is not None and a["op_kind"] == "delete":
            continue
        if a is not None and a["op_kind"] == "override":
            emit_hosted(a, "override", parent_syl_id=p["id"], original=p["text"])
        else:
            out.append({
                "id": p["id"], "text": p["text"], "nature": p["nature"],
                "source": "parent-link",
            })
    for op in at_end:
        emit_spliced(op)

    # Attach idx + cumulative offsets over the composed text (frontend rendering aid).
    cursor = 0
    for i, t in enumerate(out):
        t["idx"] = i + 1
        t["inserted"] = False
        t["start_offset"] = cursor
        cursor += len(t["text"])
        t["end_offset"] = cursor
    return out


def composed_raw_text(tokens: list[dict]) -> str:
    return "".join(t["text"] for t in tokens)


def _require_secondary(conn, text_id: int):
    row = conn.execute(
        "SELECT id, text_type, parent_text_id FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Text not found")
    if row["text_type"] != "secondary" or not row["parent_text_id"]:
        raise HTTPException(400, "Not a secondary text.")
    return row


def _next_position(conn, text_id: int) -> int:
    r = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM derivation_ops WHERE text_id = ?",
        (text_id,),
    ).fetchone()
    return r["p"]


def _host_syllable(conn, text_id: int, instance_id: str, next_idx: list, text: str, nature: str) -> str:
    """Create a real hosted ``syllables`` row for a secondary text and return its uuid.

    ``next_idx`` is a one-element list used as a monotonic counter so minted uuids and
    the (text_id, idx) primary key stay unique across repeated edits. The stored
    offsets are placeholders (0) — offsets for a secondary are derived on compose and
    are frontend-only, never an anchor (per the syllable-native directive)."""
    next_idx[0] += 1
    idx = next_idx[0]
    sid = syllable_id(instance_id, idx, text)
    conn.execute(
        "INSERT INTO syllables (id, text_id, idx, start_offset, end_offset, text, nature) "
        "VALUES (?, ?, ?, 0, 0, ?, ?)",
        (sid, text_id, idx, text, nature),
    )
    return sid


def _resolve_to_base_anchor(conn, text_id: int, syl_id: str, base_pos: dict):
    """Map a composed-token endpoint onto the BASE it anchors in. A base token maps to
    itself; a hosted token (override/insert from a previous edit) maps to its op's
    anchor base token (NULL-anchored end-inserts map to None → clamped by the caller).
    Returns the base syl id, or a marker of failure (raises)."""
    if syl_id in base_pos:
        return syl_id
    row = conn.execute(
        "SELECT o.anchor_syl_id FROM derivation_op_syllables s "
        "JOIN derivation_ops o ON o.id = s.op_id "
        "WHERE o.text_id = ? AND s.syl_id = ?",
        (text_id, syl_id),
    ).fetchone()
    if row is None:
        raise HTTPException(400, "Edited range endpoints must be tokens of this text, in order")
    return row["anchor_syl_id"]  # may be None (end-anchored insert)


def edit_range(conn, text_id: int, start_syl_id: str, end_syl_id: str, new_text: str) -> None:
    """Reconcile a free-text edit of a run into derivation ops.

    ``start_syl_id``/``end_syl_id`` bound an inclusive run of the secondary's composed
    sequence. Endpoints on the BASE (the parent's composed sequence — recursive, so
    chains work) are used directly; endpoints on hosted tokens from a previous edit
    resolve to their op's base anchor (re-editing edited content replaces its ops).
    The new text is tokenised and aligned (move-aware) against the base run; alignment
    ops map onto derivation ops: ``replace``→override (hosted, provenance kept),
    ``insert``→insert (hosted), ``delete``→delete, ``equal``/``move``→link (nothing
    stored)."""
    sec = _require_secondary(conn, text_id)
    parent_id = sec["parent_text_id"]
    parent_syls = base_tokens(conn, parent_id)
    by_id = {s["id"]: s for s in parent_syls}
    base_pos = {s["id"]: i for i, s in enumerate(parent_syls)}

    start_base = _resolve_to_base_anchor(conn, text_id, start_syl_id, base_pos)
    end_base = _resolve_to_base_anchor(conn, text_id, end_syl_id, base_pos)
    # A NULL resolution (end-anchored insert) clamps to the last base token.
    if start_base is None:
        start_base = parent_syls[-1]["id"] if parent_syls else None
    if end_base is None:
        end_base = parent_syls[-1]["id"] if parent_syls else None

    run_ids = syllable_ids_between(parent_syls, start_base, end_base) if start_base and end_base else []
    if not run_ids:
        raise HTTPException(400, "Edited range endpoints must be tokens of this text, in order")
    run = [by_id[sid] for sid in run_ids]
    run_id_set = set(run_ids)

    # The base token after the run — anchor for inserts at the run's tail.
    i_after = base_pos[run_ids[-1]] + 1
    after_anchor = parent_syls[i_after]["id"] if i_after < len(parent_syls) else None

    # Re-editing a run replaces its ops. Drop ops anchored inside the run (override/
    # delete and inserts/transcludes placed before a run syllable) and free their
    # hosted syllables.
    old_ops = conn.execute(
        "SELECT id FROM derivation_ops WHERE text_id = ? AND anchor_syl_id IN "
        f"({','.join('?' * len(run_id_set))})",
        (text_id, *run_id_set),
    ).fetchall()
    for op in old_ops:
        _delete_op(conn, op["id"])

    instance_id = _secondary_instance_id(text_id)
    next_idx = [conn.execute(
        "SELECT COALESCE(MAX(idx), 0) AS m FROM syllables WHERE text_id = ?", (text_id,)
    ).fetchone()["m"]]
    pos = [_next_position(conn, text_id)]

    new_syls = generate_syllables(new_text, instance_id)
    old_texts = [s["text"] for s in run]
    new_texts = [s["text"] for s in new_syls]
    ops = align_tokens(old_texts, new_texts, detect_moves=True)

    pending_inserts: list[dict] = []

    def new_op(kind: str, anchor):
        pos[0] += 1
        cur = conn.execute(
            "INSERT INTO derivation_ops (text_id, op_kind, anchor_syl_id, position) "
            "VALUES (?, ?, ?, ?)",
            (text_id, kind, anchor, pos[0]),
        )
        return cur.lastrowid

    def flush_inserts(anchor):
        for ns in pending_inserts:
            op_id = new_op("insert", anchor)
            sid = _host_syllable(conn, text_id, instance_id, next_idx, ns["text"], ns["nature"])
            conn.execute(
                "INSERT INTO derivation_op_syllables (op_id, position, syl_id) VALUES (?, 0, ?)",
                (op_id, sid),
            )
        pending_inserts.clear()

    for op in ops:
        if op.kind in ("equal", "move"):
            flush_inserts(run[op.old]["id"])  # link — nothing stored
        elif op.kind == "replace":
            anchor = run[op.old]["id"]
            flush_inserts(anchor)
            op_id = new_op("override", anchor)
            ns = new_syls[op.new]
            sid = _host_syllable(conn, text_id, instance_id, next_idx, ns["text"], ns["nature"])
            conn.execute(
                "INSERT INTO derivation_op_syllables (op_id, position, syl_id) VALUES (?, 0, ?)",
                (op_id, sid),
            )
        elif op.kind == "delete":
            anchor = run[op.old]["id"]
            flush_inserts(anchor)
            new_op("delete", anchor)
        elif op.kind == "insert":
            pending_inserts.append(new_syls[op.new])
    flush_inserts(after_anchor)


def insert_break(conn, text_id: int, before_syl_id) -> None:
    """Insert a manual line break: an ``insert`` op hosting a real ``"\\n"`` syllable
    (nature SPACE) before ``before_syl_id`` (None = at the end of the text).

    Being a real hosted token it composes into the text like any other syllable —
    it renders as a line break (the tagger body is ``whitespace-pre-wrap``), inherits
    down derivation chains, and is undone by deleting the op."""
    sec = _require_secondary(conn, text_id)
    anchor = None
    if before_syl_id is not None:
        base = base_tokens(conn, sec["parent_text_id"])
        base_pos = {s["id"]: i for i, s in enumerate(base)}
        anchor = _resolve_to_base_anchor(conn, text_id, before_syl_id, base_pos)
    instance_id = _secondary_instance_id(text_id)
    next_idx = [conn.execute(
        "SELECT COALESCE(MAX(idx), 0) AS m FROM syllables WHERE text_id = ?", (text_id,)
    ).fetchone()["m"]]
    pos = _next_position(conn, text_id)
    cur = conn.execute(
        "INSERT INTO derivation_ops (text_id, op_kind, anchor_syl_id, position) "
        "VALUES (?, 'insert', ?, ?)",
        (text_id, anchor, pos),
    )
    sid = _host_syllable(conn, text_id, instance_id, next_idx, "\n", "SPACE")
    conn.execute(
        "INSERT INTO derivation_op_syllables (op_id, position, syl_id) VALUES (?, 0, ?)",
        (cur.lastrowid, sid),
    )


def transclude(conn, text_id: int, anchor_syl_id, src_text_id: int,
               src_start_syl_id: str, src_end_syl_id: str) -> None:
    """Splice a range LINK from another text into a secondary text (no copy). The
    source range resolves through the source's composed sequence, so a secondary can
    transclude from primaries or other secondaries and upstream corrections ripple."""
    _require_secondary(conn, text_id)
    if not conn.execute("SELECT 1 FROM texts WHERE id = ?", (src_text_id,)).fetchone():
        raise HTTPException(404, "Source text not found")
    src_syls = base_tokens(conn, src_text_id)
    if not syllable_ids_between(src_syls, src_start_syl_id, src_end_syl_id):
        raise HTTPException(400, "Transclusion range endpoints must be source syllables, in order")
    pos = _next_position(conn, text_id)
    conn.execute(
        "INSERT INTO derivation_ops (text_id, op_kind, anchor_syl_id, position, "
        "src_text_id, src_start_syl_id, src_end_syl_id) "
        "VALUES (?, 'transclude', ?, ?, ?, ?, ?)",
        (text_id, anchor_syl_id, pos, src_text_id, src_start_syl_id, src_end_syl_id),
    )


def _delete_op(conn, op_id: int) -> None:
    """Delete a derivation op, its hosted syllables (real rows) and link rows."""
    hosted = conn.execute(
        "SELECT syl_id FROM derivation_op_syllables WHERE op_id = ?", (op_id,)
    ).fetchall()
    row = conn.execute("SELECT text_id FROM derivation_ops WHERE id = ?", (op_id,)).fetchone()
    if row is not None:
        for h in hosted:
            conn.execute(
                "DELETE FROM syllables WHERE text_id = ? AND id = ?",
                (row["text_id"], h["syl_id"]),
            )
    # derivation_op_syllables rows cascade on the op delete.
    conn.execute("DELETE FROM derivation_ops WHERE id = ?", (op_id,))


def delete_op(conn, op_id: int) -> bool:
    if not conn.execute("SELECT 1 FROM derivation_ops WHERE id = ?", (op_id,)).fetchone():
        return False
    _delete_op(conn, op_id)
    return True
