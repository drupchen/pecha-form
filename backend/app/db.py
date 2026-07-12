import sqlite3
import os
import re

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "sapche.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS texts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    title         TEXT NOT NULL,
    -- Optional user-assigned collection label for organizing the texts list.
    -- NULL == ungrouped. Free-form; orthogonal to primary/secondary relations.
    text_group    TEXT,
    source_text   TEXT NOT NULL,
    raw_text      TEXT NOT NULL,
    -- 'primary' = a text constituted of its own syllables (may host passages).
    -- 'secondary' = derived from parent_text_id; its content is composed from the
    -- parent's syllables plus derivation_ops, so raw_text is empty ''.
    text_type      TEXT NOT NULL DEFAULT 'primary',
    parent_text_id INTEGER REFERENCES texts(id) ON DELETE CASCADE,
    -- Set on a text produced by "duplicate (bake edits)": the original it was cloned
    -- from. ON DELETE SET NULL so deleting the original leaves the duplicate standing
    -- as an ordinary text (its "duplicate of …" badge just disappears).
    cloned_from_text_id INTEGER REFERENCES texts(id) ON DELETE SET NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Part 12: a registry of known group paths so an *empty* group (created via the
-- texts-list "+" buttons) persists even with no text in it. Rows are normalized
-- "/"-paths; the texts tree is built from the union of these and texts.text_group.
CREATE TABLE IF NOT EXISTS text_groups (
    path TEXT PRIMARY KEY,
    -- Part 13: manual per-parent sibling order. NULL == unordered (sorts after
    -- positioned siblings, alphabetically); assigned lazily on the first reorder.
    position INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Part 8: a NULL text_id means the tag is *shared* — it appears in every
    -- text's palette. A non-NULL text_id means it is *private* to that text.
    -- Deleting a text CASCADE-drops its private tags; shared (NULL) tags survive.
    -- Only regular tags are ever shared (session tags carry per-text anchors).
    text_id     INTEGER REFERENCES texts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#6366f1',
    tag_kind        TEXT NOT NULL DEFAULT 'regular',
    UNIQUE(text_id, name)
);

CREATE TABLE IF NOT EXISTS spans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    start_syl_id TEXT,
    end_syl_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_spans_text ON spans(text_id);

CREATE TABLE IF NOT EXISTS markers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    syl_id       TEXT,
    UNIQUE(text_id, syl_id)
);
CREATE INDEX IF NOT EXISTS idx_markers_text ON markers(text_id);

-- Display-only line-break overrides (the ¶ mode): `count` newlines render after the
-- token `syl_id` while the mode is on, overriding the automatic verse/sapche/real-
-- newline behavior at that position. 0 = suppress. The text data itself never changes.
CREATE TABLE IF NOT EXISTS display_breaks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    syl_id   TEXT NOT NULL,
    count    INTEGER NOT NULL CHECK (count IN (0, 1, 2)),
    UNIQUE(text_id, syl_id)
);
CREATE INDEX IF NOT EXISTS idx_display_breaks_text ON display_breaks(text_id);

CREATE TABLE IF NOT EXISTS tree_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id     INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    parent_id       INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    title           TEXT,
    segment_start_syl_id TEXT,
    transparent     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK ((title IS NOT NULL) OR (segment_start_syl_id IS NOT NULL)),
    UNIQUE(parent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_text ON tree_nodes(text_id);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent   ON tree_nodes(parent_id);

CREATE TABLE IF NOT EXISTS suggestions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    suggested_text TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suggestions_text ON suggestions(text_id);

CREATE TABLE IF NOT EXISTS note_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    UNIQUE(text_id, name)
);
CREATE INDEX IF NOT EXISTS idx_note_categories_text ON note_categories(text_id);

CREATE TABLE IF NOT EXISTS notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    category_id  INTEGER REFERENCES note_categories(id) ON DELETE SET NULL,
    body         TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notes_text ON notes(text_id);

CREATE TABLE IF NOT EXISTS note_sessions (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_note_sessions_tag ON note_sessions(tag_id);

-- ---------------------------------------------------------------------------
-- Publishing layer (absorbed from prepare_data). All additive: these tables
-- live alongside the annotation tables above and never modify their rows.
-- ---------------------------------------------------------------------------

-- The syllable base layer = the published manifest. One row per syllable, with
-- a stable uuid5 id (see app/manifest.py) and exact char offsets into
-- texts.raw_text so existing offset-based annotations map by lookup.
CREATE TABLE IF NOT EXISTS syllables (
    id           TEXT NOT NULL,            -- uuid5(instance_id, idx, text)
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,         -- 1-based manifest index
    start_offset INTEGER NOT NULL,         -- inclusive offset into raw_text
    end_offset   INTEGER NOT NULL,         -- exclusive offset into raw_text
    text         TEXT NOT NULL,
    nature       TEXT NOT NULL,            -- TEXT / PUNCT / SPACE / LATIN / ...
    PRIMARY KEY (text_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_syllables_text ON syllables(text_id);
CREATE INDEX IF NOT EXISTS idx_syllables_offsets  ON syllables(text_id, start_offset);
CREATE INDEX IF NOT EXISTS idx_syllables_sylid    ON syllables(id);

-- Imported SRT transcript segments, grouped by the session tag they belong to.
CREATE TABLE IF NOT EXISTS srt_segments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    session_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    seg_id         INTEGER NOT NULL,       -- 1-based index within the SRT file
    start_tc       TEXT NOT NULL,          -- HH:MM:SS,mmm
    end_tc         TEXT NOT NULL,
    text           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_srt_segments_session ON srt_segments(session_tag_id);

-- A contiguous, syllable-bounded portion of a session's tagged text that the
-- user attributes one or more SRT segments to.
CREATE TABLE IF NOT EXISTS text_portions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    session_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,  -- order within the session
    start_syl_id   TEXT,
    end_syl_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_text_portions_session ON text_portions(session_tag_id);

-- Ordered many-to-many: which SRT segments are attributed to a portion.
CREATE TABLE IF NOT EXISTS portion_segments (
    portion_id     INTEGER NOT NULL REFERENCES text_portions(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (portion_id, srt_segment_id)
);
CREATE INDEX IF NOT EXISTS idx_portion_segments_seg ON portion_segments(srt_segment_id);

-- The transcription token layer: srt_segments.text tokenised into syllables, the
-- transcript-side analogue of the `syllables` table (see app/transcript_manifest.py).
-- One row per token, with a stable uuid5 id and exact offsets into the *segment*
-- text. Rebuilt from srt_segments whenever transcript text changes.
CREATE TABLE IF NOT EXISTS transcript_syllables (
    id             TEXT NOT NULL,            -- uuid5(instance, session, seg_id, idx, text)
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    idx            INTEGER NOT NULL,         -- 1-based index within the segment
    start_offset   INTEGER NOT NULL,         -- inclusive offset into the segment text
    end_offset     INTEGER NOT NULL,         -- exclusive offset into the segment text
    text           TEXT NOT NULL,
    nature         TEXT NOT NULL,
    PRIMARY KEY (srt_segment_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_transcript_syllables_text ON transcript_syllables(text_id);
CREATE INDEX IF NOT EXISTS idx_transcript_syllables_segment  ON transcript_syllables(srt_segment_id);
CREATE INDEX IF NOT EXISTS idx_transcript_syllables_sylid    ON transcript_syllables(id);

-- Per-syllable annotation primitives for the transcription layer, mirroring the
-- root text's `spans` and `suggestions` but keyed by srt_segment_id with offsets
-- into the *segment* text. Tags are reused from the `tags` table (tag_kind
-- 'regular'), shared with the root text.
CREATE TABLE IF NOT EXISTS transcript_spans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    tag_id         INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    start_syl_id   TEXT,
    end_syl_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcript_spans_segment  ON transcript_spans(srt_segment_id);
CREATE INDEX IF NOT EXISTS idx_transcript_spans_text ON transcript_spans(text_id);

CREATE TABLE IF NOT EXISTS transcript_suggestions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    suggested_text TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    start_syl_id   TEXT,
    end_syl_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcript_suggestions_segment
    ON transcript_suggestions(srt_segment_id);

-- Notes on the transcription layer — the transcript-side analogue of `notes`,
-- keyed by srt_segment_id with offsets into the *segment* text. Categories are
-- the shared, text-scoped `note_categories` (reused from the root text).
CREATE TABLE IF NOT EXISTS transcript_notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    category_id    INTEGER REFERENCES note_categories(id) ON DELETE SET NULL,
    body           TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    start_syl_id   TEXT,
    end_syl_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcript_notes_segment  ON transcript_notes(srt_segment_id);
CREATE INDEX IF NOT EXISTS idx_transcript_notes_text ON transcript_notes(text_id);

-- Snapshot of each layer's syllable identity + order AS OF the last successful
-- publish. Diffed against the current layer at publish time to emit the
-- machine-readable id_migrations.json (which UUIDs changed since last publish, so
-- the webapp ingest can remap/drop references and never orphan). Purely uuid +
-- order based — no char offsets. `group_key` is the session name for transcript
-- scope (the alignment unit; also present in the published transcription_manifest),
-- NULL for root.
CREATE TABLE IF NOT EXISTS published_syllables (
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL CHECK (scope IN ('root','transcript')),
    group_key    TEXT,
    idx          INTEGER NOT NULL,
    uuid         TEXT NOT NULL,
    text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_published_syllables_doc_scope
    ON published_syllables(text_id, scope);

-- One row per text: when its layers were last snapshotted (last publish).
-- Feeds the `previous_publish` field of id_migrations.json.
CREATE TABLE IF NOT EXISTS publish_state (
    text_id      INTEGER PRIMARY KEY REFERENCES texts(id) ON DELETE CASCADE,
    last_published_at TEXT
);

-- ---------------------------------------------------------------------------
-- Passages (primary-text inline transclusion). A passage is an ordered
-- sequence of syllable-range LINKS drawn from OTHER parts of the SAME text,
-- placed at a position (anchor_syl_id) and rendered inline in a distinct
-- colour. Syllable-native: only syl_id (uuid) links — no char offsets, and no
-- syllables are copied. The linked syllables live in the `syllables` table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id       INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    anchor_syl_id TEXT,          -- syllable this passage renders BEFORE; NULL = at end
    position      INTEGER NOT NULL DEFAULT 0,  -- order among passages at the same anchor
    color         TEXT           -- optional per-passage colour; NULL = default class
);
CREATE INDEX IF NOT EXISTS idx_passages_text ON passages(text_id);

-- Ordered runs of source syllables that make up a passage. Each member is a
-- contiguous run of existing syllables in the same text, resolved by idx
-- between the two (inclusive) syllable uuids.
CREATE TABLE IF NOT EXISTS passage_members (
    passage_id       INTEGER NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,       -- order of this run within the passage
    src_start_syl_id TEXT NOT NULL,          -- inclusive first source syllable
    src_end_syl_id   TEXT NOT NULL,          -- inclusive last source syllable
    PRIMARY KEY (passage_id, position)
);

-- ---------------------------------------------------------------------------
-- Secondary-text derivation ops. A secondary text = parent_text_id + a sparse
-- op list. Unchanged parent syllables are never stored (they stay links);
-- only changed/added/transcluded content is stored. Syllable-native — anchors
-- and refs are syl_id (uuid), never char offsets. Hosted (override/insert)
-- syllables are real rows in `syllables` with text_id = the secondary text,
-- ordered per op by derivation_op_syllables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derivation_ops (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id       INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,  -- secondary
    op_kind       TEXT NOT NULL CHECK (op_kind IN
                     ('override','insert','delete','transclude')),
    -- parent syllable: the one changed/deleted (override/delete), or the one to
    -- place content BEFORE (insert/transclude); NULL = append at end.
    anchor_syl_id TEXT,
    position      INTEGER NOT NULL DEFAULT 0,   -- order among ops at the same anchor
    -- transclude only: a range LINK into another text (no copy).
    src_text_id      INTEGER REFERENCES texts(id) ON DELETE CASCADE,
    src_start_syl_id TEXT,
    src_end_syl_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_derivation_ops_text ON derivation_ops(text_id);

-- Ordered hosted syllables produced by an override/insert op. Each syl_id is a
-- real row in `syllables` (text_id = the secondary text).
CREATE TABLE IF NOT EXISTS derivation_op_syllables (
    op_id    INTEGER NOT NULL REFERENCES derivation_ops(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    syl_id   TEXT NOT NULL,
    PRIMARY KEY (op_id, position)
);

-- Per-user last-viewed position in a text: the syllable that begins the segment the
-- user was last looking at, so reopening a text scrolls back there. `user_id` is the
-- multi-user piping — until real accounts exist it is a single local user (see
-- app/auth.py `current_user_id`). PK (user_id, text_id) = one position per user & text.
CREATE TABLE IF NOT EXISTS reading_positions (
    user_id    INTEGER NOT NULL DEFAULT 1,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    syl_id     TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, text_id)
);

-- ─── Translation layer (Phase T1) ──────────────────────────────────────────────
-- Target languages for translations. Seeded by init_db; extendable via the API.
CREATE TABLE IF NOT EXISTS languages (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

-- The unit of translation: a "chunk" — the stretch between two empty lines (or
-- segment boundaries) of a booklet's stream, persisted as a SOURCE-syllable range
-- anchored at the text that OWNS those syllables (its origin). Like spans, this
-- makes translations ripple: any booklet whose composed stream includes the range
-- (via transclusion/parent links) sees the chunk's translations live.
CREATE TABLE IF NOT EXISTS translation_chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    start_syl_id   TEXT NOT NULL,
    end_syl_id     TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'title')),
    -- Title level for heading chunks (sapche/title): 1..n, NULL = not a heading.
    -- Language-independent (structural) — feeds TOC + PDF heading styles.
    level          INTEGER,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(origin_text_id, start_syl_id, end_syl_id)
);
CREATE INDEX IF NOT EXISTS idx_translation_chunks_text ON translation_chunks(origin_text_id);

-- ONE canonical translation per chunk × language ("translate once, ripple
-- everywhere"). `translated_from` = the language the translator worked from
-- (NULL = the Tibetan). Booklet-level overrides and upstream suggestions are
-- Phase T2 tables.
CREATE TABLE IF NOT EXISTS translations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id        INTEGER NOT NULL REFERENCES translation_chunks(id) ON DELETE CASCADE,
    lang            TEXT NOT NULL REFERENCES languages(code),
    body            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
    translated_from TEXT,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_translations_chunk ON translations(chunk_id);
"""


# Additive column migrations for pre-existing tables. Each is applied only if
# the column is missing, so existing rows and data are untouched.
_COLUMN_MIGRATIONS = {
    "texts": [
        ("instance_id", "TEXT"),
        ("teaching_id", "TEXT"),
        ("title_bo", "TEXT"),
        ("access_level", "INTEGER"),
        # Optional user-assigned collection label for the texts list; NULL == ungrouped.
        ("text_group", "TEXT"),
        # Primary/secondary text typing (see the texts CREATE above).
        ("text_type", "TEXT NOT NULL DEFAULT 'primary'"),
        ("parent_text_id", "INTEGER REFERENCES texts(id) ON DELETE CASCADE"),
        # "Duplicate (bake edits)" provenance; NULLed when the original is deleted.
        ("cloned_from_text_id", "INTEGER REFERENCES texts(id) ON DELETE SET NULL"),
        # Base folder where this text's main-text/audio-sync SRTs live; each
        # session's file is found inside it by its catalog srt_filename. Lets the
        # alignment tab reparse from disk instead of a manual per-file upload.
        ("main_text_srt_dir", "TEXT"),
        # Base folder where this text's per-session WAV audio lives, for in-tool
        # segment playback in the Transcriptions tab (proofreading aid). Resolved
        # per session by filename; independent of the SRT/alignment flow.
        ("audio_dir", "TEXT"),
    ],
    "tags": [
        ("audio_original_url", "TEXT"),
        ("audio_restored_url", "TEXT"),
        ("srt_filename", "TEXT"),
        # Phase 3 syllable-UUID anchors (parallel to open/close_position): the
        # syllable whose start == open_position and whose end == close_position.
        ("open_syl_id", "TEXT"),
        ("close_syl_id", "TEXT"),
    ],
    # attach_prev: attachment side for a passage anchored at a segment boundary.
    # 1 = render at the END of the previous segment's card ("stays on the same
    # segment"); 0 = head the anchor's segment.
    # own_segment: the marker-free "manual split" — render as a standalone card
    # (its own segment) instead of inline. Node-linked passages are standalone too.
    "passages": [("attach_prev", "INTEGER NOT NULL DEFAULT 0"),
                 ("own_segment", "INTEGER NOT NULL DEFAULT 0")],
    # level: title level for heading chunks (sapche/title), NULL = not a heading.
    "translation_chunks": [("level", "INTEGER")],
    "text_portions": [
        ("color", "TEXT"),
        # Base "listen to this passage" audio timing, set by main-text SRT
        # alignment (main_text_align). When present, the portion is a base
        # segment in the compiled_sessions export.
        ("start_tc", "TEXT"),
        ("end_tc", "TEXT"),
        ("start_syl_id", "TEXT"),
        ("end_syl_id", "TEXT"),
    ],
    # Phase 3: syllable-UUID anchors added in parallel to char offsets (the
    # syllable layer becomes the sole anchor; offsets stay as a safety net until
    # they are dropped). For ranges, start_syl_id = syllable whose start_offset
    # == row.start_offset (inclusive first syllable) and end_syl_id = syllable
    # whose end_offset == row.end_offset (inclusive last syllable). For a
    # zero-width insertion suggestion (start==end), end_syl_id is NULL and
    # start_syl_id is the syllable the text is inserted *before*. Single-boundary
    # anchors (markers.position, tree_nodes.segment_start) reference the syllable
    # that STARTS at that offset. Transcript tables reference transcript_syllables.
    "spans": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    # extracted_text_id: set when this delete-suggestion was created by /extract; links
    # the text the range was moved into so the UI can label it "extracted → <title>".
    # Plain INTEGER (no FK: ALTER ADD can't add one) — a dangling id degrades to "removed".
    # status/origin_text_id: upstream review flow. 'applied' (default, incl. legacy rows)
    # = a live correction (splices into the corrected view, bakes/ripples). 'pending' = an
    # incoming suggestion from a DERIVED text (origin_text_id) awaiting review here — the
    # level where the syllable first appears; it has no effect until accepted.
    "suggestions": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT"),
                    ("extracted_text_id", "INTEGER"),
                    ("status", "TEXT NOT NULL DEFAULT 'applied'"),
                    ("origin_text_id", "INTEGER")],
    # passage_id: a note ON a passage occurrence (renders only inside that passage run,
    # never at the source occurrence of the shared syllables). NULL = a normal note on
    # the host text. Plain INTEGER (ALTER can't add an FK); dangling id = never renders.
    "notes": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT"), ("passage_id", "INTEGER")],
    "markers": [("syl_id", "TEXT")],
    # passage_id: the sapche section IS that passage occurrence (a zero-host-width
    # "segment" between two boundaries). Mutually exclusive with segment_start_syl_id.
    "tree_nodes": [("segment_start_syl_id", "TEXT"), ("passage_id", "INTEGER")],
    "transcript_spans": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "transcript_suggestions": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "transcript_notes": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    # Part 13: manual per-parent order for the registry (see the text_groups CREATE).
    "text_groups": [("position", "INTEGER")],
}


def _add_missing_columns(conn) -> None:
    for table, columns in _COLUMN_MIGRATIONS.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


# Suggestions are auto-applied on creation — there is no accept/reject lifecycle, so the
# `status` column (and its status-keyed index) is vestigial. Drop it from pre-existing
# DBs. Idempotent: only runs while the column is still present. The status-keyed index
# must be dropped before the column (SQLite refuses to drop an indexed column); the
# replacement index is created by the SCHEMA's `CREATE INDEX IF NOT EXISTS`.
_DROP_STATUS = {
    "suggestions": "idx_suggestions_doc_status",
    "transcript_suggestions": "idx_transcript_suggestions_seg_status",
}


def _drop_status_columns(conn) -> None:
    for table, old_index in _DROP_STATUS.items():
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if "status" in cols:
            conn.execute(f"DROP INDEX IF EXISTS {old_index}")
            conn.execute(f"ALTER TABLE {table} DROP COLUMN status")


# One-time rename of the former `documents` entity to `texts` (and every
# `document_id` FK column to `text_id`). Idempotent: guarded by existence checks so
# it is a no-op on already-migrated and on fresh databases. Must run BEFORE
# executescript(SCHEMA), otherwise `CREATE TABLE IF NOT EXISTS texts` would create a
# fresh empty table and pre-empt the rename of the populated `documents` table.
# SQLite (>=3.26, legacy_alter_table off by default) rewrites child FK references
# and index definitions to the new names automatically.
def _rename_documents_to_texts(conn) -> None:
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if "documents" in tables:
        doc_rows = conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"]
        texts_rows = (
            conn.execute("SELECT COUNT(*) c FROM texts").fetchone()["c"]
            if "texts" in tables else None
        )
        if "texts" not in tables:
            # Clean rename: no `texts` table yet.
            conn.execute("ALTER TABLE documents RENAME TO texts")
        elif texts_rows == 0:
            # A prior SCHEMA run (before this migration existed) created an EMPTY
            # `texts` shell, so the guarded rename never fired and the real rows were
            # stranded in `documents` while the app read the empty `texts`. Drop the
            # shell and promote `documents` — the RENAME rewrites child FK targets
            # (spans/syllables/…: `document_id` → `text_id` still referencing
            # `documents(id)`) onto `texts(id)` automatically.
            conn.execute("DROP TABLE texts")
            conn.execute("ALTER TABLE documents RENAME TO texts")
        elif doc_rows == 0:
            # Already migrated (data lives in `texts`); drop the vestigial empty shell.
            conn.execute("DROP TABLE documents")
        else:
            # Both tables hold rows — an ambiguous state we won't auto-merge (not
            # expected in practice); leave them for manual resolution.
            raise RuntimeError(
                "Both `documents` and `texts` tables hold rows; refusing to auto-merge."
            )
        tables.discard("documents")
        tables.add("texts")
    for t in tables:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({t})")}
        if "document_id" in cols and "text_id" not in cols:
            conn.execute(f"ALTER TABLE {t} RENAME COLUMN document_id TO text_id")


# Part 6, Phase 3 — drop the char-offset columns. The `syllables` table is now the
# sole tokenization/identity source and every annotation is anchored by syllable UUID;
# char offsets are derived on read for the frontend only, never stored as an anchor.
# `syllables.start_offset/end_offset` are KEPT as a derived render cache. Two shapes:
#   * a plain column bound by no CHECK/UNIQUE/index → `ALTER TABLE ... DROP COLUMN`;
#   * a column inside a CHECK/UNIQUE/index → SQLite rebuild-table (create `<t>__new`,
#     copy the surviving columns, drop the old table, rename) because DROP COLUMN
#     refuses those. The rebuild DDLs already include the parallel `*_syl_id` anchor
#     columns, so this yields the same shape a fresh SCHEMA + _add_missing_columns does.
# Idempotent: each step runs only while its target column is still present, so it is a
# no-op on fresh and already-migrated DBs.

# (table, column) — droppable directly (not referenced by any CHECK/UNIQUE/index).
_OFFSET_DROP_SIMPLE = [
    ("texts", "units_json"),
    ("tags", "open_position"),
    ("tags", "close_position"),
]

# (table, sentinel_offset_col, create_new_ddl, surviving_cols, [index_ddl, ...]).
# The rebuild runs only while `sentinel_offset_col` is still present.
_OFFSET_DROP_REBUILD = [
    ("spans", "start_offset",
     "CREATE TABLE spans__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "tag_id", "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_spans_text ON spans(text_id)"]),
    ("markers", "position",
     "CREATE TABLE markers__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " syl_id TEXT, UNIQUE(text_id, syl_id))",
     ["id", "text_id", "syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_markers_text ON markers(text_id)"]),
    ("tree_nodes", "segment_start",
     "CREATE TABLE tree_nodes__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " parent_id INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,"
     " position INTEGER NOT NULL, title TEXT, segment_start_syl_id TEXT,"
     " transparent INTEGER NOT NULL DEFAULT 0,"
     " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " CHECK ((title IS NOT NULL) OR (segment_start_syl_id IS NOT NULL)),"
     " UNIQUE(parent_id, position))",
     ["id", "text_id", "parent_id", "position", "title", "segment_start_syl_id",
      "transparent", "created_at", "updated_at"],
     ["CREATE INDEX IF NOT EXISTS idx_tree_nodes_text ON tree_nodes(text_id)",
      "CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent ON tree_nodes(parent_id)"]),
    ("suggestions", "start_offset",
     "CREATE TABLE suggestions__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " suggested_text TEXT NOT NULL,"
     " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "suggested_text", "created_at", "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_suggestions_text ON suggestions(text_id)"]),
    ("notes", "start_offset",
     "CREATE TABLE notes__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " category_id INTEGER REFERENCES note_categories(id) ON DELETE SET NULL,"
     " body TEXT NOT NULL DEFAULT '',"
     " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "category_id", "body", "created_at", "updated_at",
      "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_notes_text ON notes(text_id)"]),
    ("text_portions", "start_offset",
     "CREATE TABLE text_portions__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " session_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,"
     " position INTEGER NOT NULL DEFAULT 0, color TEXT, start_tc TEXT, end_tc TEXT,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "session_tag_id", "position", "color", "start_tc", "end_tc",
      "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_text_portions_session ON text_portions(session_tag_id)"]),
    ("transcript_spans", "start_offset",
     "CREATE TABLE transcript_spans__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,"
     " tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "srt_segment_id", "tag_id", "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_transcript_spans_segment ON transcript_spans(srt_segment_id)",
      "CREATE INDEX IF NOT EXISTS idx_transcript_spans_text ON transcript_spans(text_id)"]),
    ("transcript_suggestions", "start_offset",
     "CREATE TABLE transcript_suggestions__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,"
     " suggested_text TEXT NOT NULL,"
     " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "srt_segment_id", "suggested_text", "created_at",
      "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_transcript_suggestions_segment"
      " ON transcript_suggestions(srt_segment_id)"]),
    ("transcript_notes", "start_offset",
     "CREATE TABLE transcript_notes__new ("
     " id INTEGER PRIMARY KEY AUTOINCREMENT,"
     " text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,"
     " srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,"
     " category_id INTEGER REFERENCES note_categories(id) ON DELETE SET NULL,"
     " body TEXT NOT NULL DEFAULT '',"
     " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
     " start_syl_id TEXT, end_syl_id TEXT)",
     ["id", "text_id", "srt_segment_id", "category_id", "body", "created_at",
      "updated_at", "start_syl_id", "end_syl_id"],
     ["CREATE INDEX IF NOT EXISTS idx_transcript_notes_segment ON transcript_notes(srt_segment_id)",
      "CREATE INDEX IF NOT EXISTS idx_transcript_notes_text ON transcript_notes(text_id)"]),
]

# Pre-flight: rows that would become underivable once offsets are gone (an offset
# column still present but its syllable anchor NULL). `markers.syl_id` NULL is the
# legitimate end-of-text sentinel, so it is intentionally not asserted.
_ANCHOR_PREFLIGHT = [
    ("spans", "start_offset", "start_syl_id IS NULL OR end_syl_id IS NULL", "span"),
    ("suggestions", "start_offset", "start_syl_id IS NULL", "suggestion"),
    ("notes", "start_offset", "start_syl_id IS NULL OR end_syl_id IS NULL", "note"),
    ("text_portions", "start_offset",
     "start_syl_id IS NULL OR end_syl_id IS NULL", "text_portion"),
    ("tree_nodes", "segment_start",
     "segment_start IS NOT NULL AND segment_start_syl_id IS NULL", "tree_node"),
    ("tags", "open_position",
     "(open_position IS NOT NULL AND open_syl_id IS NULL)"
     " OR (close_position IS NOT NULL AND close_syl_id IS NULL)", "session tag"),
    ("transcript_spans", "start_offset",
     "start_syl_id IS NULL OR end_syl_id IS NULL", "transcript_span"),
    ("transcript_suggestions", "start_offset", "start_syl_id IS NULL",
     "transcript_suggestion"),
    ("transcript_notes", "start_offset",
     "start_syl_id IS NULL OR end_syl_id IS NULL", "transcript_note"),
]


def _needs_offset_drop(conn) -> bool:
    targets = _OFFSET_DROP_SIMPLE + [(t, c) for (t, c, *_ ) in _OFFSET_DROP_REBUILD]
    for table, col in targets:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col in cols:
            return True
    return False


def _assert_anchors_present(conn) -> None:
    for table, sentinel, bad, label in _ANCHOR_PREFLIGHT:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if sentinel not in cols:
            continue  # already migrated — nothing to assert
        n = conn.execute(
            f"SELECT COUNT(*) c FROM {table} WHERE {bad}"
        ).fetchone()["c"]
        if n:
            raise RuntimeError(
                f"Refusing offset-column drop: {n} {label} row(s) lack a syllable "
                f"anchor and would become underivable. Backfill anchors first."
            )


def _drop_offset_columns(conn) -> None:
    """Drop the retired char-offset columns (rebuild-table where required).

    Must be called OUTSIDE a transaction: it toggles `PRAGMA foreign_keys` (which
    cannot change mid-transaction) so the table rebuilds don't cascade-delete child
    rows when an old parent table is dropped.
    """
    if not _needs_offset_drop(conn):
        return
    _assert_anchors_present(conn)
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        with conn:
            for table, col in _OFFSET_DROP_SIMPLE:
                cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
                if col in cols:
                    conn.execute(f"ALTER TABLE {table} DROP COLUMN {col}")
            for table, sentinel, create_ddl, surviving, indexes in _OFFSET_DROP_REBUILD:
                cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
                if sentinel not in cols:
                    continue
                conn.execute(create_ddl)
                collist = ", ".join(surviving)
                conn.execute(
                    f"INSERT INTO {table}__new ({collist}) SELECT {collist} FROM {table}"
                )
                conn.execute(f"DROP TABLE {table}")
                conn.execute(f"ALTER TABLE {table}__new RENAME TO {table}")
                for ddl in indexes:
                    conn.execute(ddl)
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(
                    f"Foreign-key violations after offset-column drop: {violations[:5]}"
                )
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


# Part 8 — allow `tags.text_id` to be NULL (a NULL owner == a *shared* tag, shown in
# every text's palette). SQLite can't drop a NOT NULL constraint in place, so rebuild
# the table (create `tags__new`, copy, drop, rename). `tags` is a parent table
# (spans/text_portions/transcript_spans/note_sessions FK it), so run with foreign_keys
# OFF on its own (non-nested) transaction, like `_drop_offset_columns`. Idempotent:
# runs only while `text_id` is still declared NOT NULL. Columns are copied dynamically
# so it is robust to whatever earlier migrations left on the table.
def _make_tags_text_id_nullable(conn) -> None:
    info = {r["name"]: r for r in conn.execute("PRAGMA table_info(tags)")}
    if "text_id" not in info or info["text_id"]["notnull"] == 0:
        return  # fresh (already nullable) or missing — nothing to do
    # Rebuild from the table's own stored DDL (preserves every column — including the
    # ALTER-added audio_*/srt_filename/*_syl_id ones — plus AUTOINCREMENT, defaults, the
    # FK and UNIQUE), dropping only the NOT NULL on text_id.
    sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tags'"
    ).fetchone()["sql"]
    new_sql = re.sub(
        r"(\btext_id\b\s+INTEGER)\s+NOT\s+NULL", r"\1", sql, count=1, flags=re.IGNORECASE
    )
    if new_sql == sql:  # DDL didn't match the expected shape — bail rather than guess
        raise RuntimeError("Could not strip NOT NULL from tags.text_id; DDL unexpected")
    before = conn.execute("SELECT COUNT(*) AS n FROM tags").fetchone()["n"]
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        with conn:
            conn.execute("ALTER TABLE tags RENAME TO tags__old")
            conn.execute(new_sql)  # recreates `tags` with text_id nullable
            conn.execute("INSERT INTO tags SELECT * FROM tags__old")
            conn.execute("DROP TABLE tags__old")
            # Row-count guard: a rebuild must never lose tags. If the copy dropped any
            # row, raise so the `with conn:` block rolls the whole rebuild back rather
            # than committing an empty/short table.
            after = conn.execute("SELECT COUNT(*) AS n FROM tags").fetchone()["n"]
            if after != before:
                raise RuntimeError(
                    f"tags rebuild changed row count: {before} -> {after}; rolling back"
                )
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(
                    f"Foreign-key violations after tags rebuild: {violations[:5]}"
                )
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    with conn:
        _rename_documents_to_texts(conn)
        _drop_status_columns(conn)
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)
        # Seed the four working languages (idempotent; more are added via the API).
        conn.executemany(
            "INSERT OR IGNORE INTO languages (code, name) VALUES (?, ?)",
            [("en", "English"), ("fr", "Français"), ("de", "Deutsch"), ("pt", "Português")],
        )
    # Offset-column drop runs after the additive schema, on its own (non-nested)
    # transaction with foreign_keys OFF — see _drop_offset_columns.
    _drop_offset_columns(conn)
    # Part 8: make tags.text_id nullable (shared tags). Runs after the offset drop so
    # `tags` already has its final column set; own foreign_keys-OFF transaction.
    _make_tags_text_id_nullable(conn)
    conn.close()
