import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "sapche.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS texts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    title         TEXT NOT NULL,
    source_text   TEXT NOT NULL,
    raw_text      TEXT NOT NULL,
    units_json    TEXT NOT NULL,
    -- 'primary' = a text constituted of its own syllables (may host passages).
    -- 'secondary' = derived from parent_text_id; its content is composed from the
    -- parent's syllables plus derivation_ops, so raw_text/units_json are empty ''.
    text_type      TEXT NOT NULL DEFAULT 'primary',
    parent_text_id INTEGER REFERENCES texts(id) ON DELETE CASCADE,
    -- Set on a text produced by "duplicate (bake edits)": the original it was cloned
    -- from. ON DELETE SET NULL so deleting the original leaves the duplicate standing
    -- as an ordinary text (its "duplicate of …" badge just disappears).
    cloned_from_text_id INTEGER REFERENCES texts(id) ON DELETE SET NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id     INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#6366f1',
    tag_kind        TEXT NOT NULL DEFAULT 'regular',
    open_position   INTEGER,
    close_position  INTEGER,
    UNIQUE(text_id, name)
);

CREATE TABLE IF NOT EXISTS spans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER NOT NULL,
    CHECK (start_offset < end_offset)
);

CREATE INDEX IF NOT EXISTS idx_spans_text ON spans(text_id);
CREATE INDEX IF NOT EXISTS idx_spans_offsets  ON spans(text_id, start_offset);

CREATE TABLE IF NOT EXISTS markers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id  INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    UNIQUE(text_id, position)
);
CREATE INDEX IF NOT EXISTS idx_markers_text ON markers(text_id);

CREATE TABLE IF NOT EXISTS tree_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id     INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    parent_id       INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    title           TEXT,
    segment_start   INTEGER,
    transparent     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK ((title IS NOT NULL) OR (segment_start IS NOT NULL)),
    UNIQUE(parent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_text ON tree_nodes(text_id);
CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent   ON tree_nodes(parent_id);

CREATE TABLE IF NOT EXISTS suggestions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    start_offset   INTEGER NOT NULL,
    end_offset     INTEGER NOT NULL,
    suggested_text TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset <= end_offset)
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
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset < end_offset)
);
CREATE INDEX IF NOT EXISTS idx_notes_text ON notes(text_id);
CREATE INDEX IF NOT EXISTS idx_notes_offsets  ON notes(text_id, start_offset);

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
    start_offset   INTEGER NOT NULL,
    end_offset     INTEGER NOT NULL,
    position       INTEGER NOT NULL DEFAULT 0,  -- order within the session
    CHECK (start_offset < end_offset)
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
    start_offset   INTEGER NOT NULL,         -- offset into srt_segments.text
    end_offset     INTEGER NOT NULL,
    CHECK (start_offset < end_offset)
);
CREATE INDEX IF NOT EXISTS idx_transcript_spans_segment  ON transcript_spans(srt_segment_id);
CREATE INDEX IF NOT EXISTS idx_transcript_spans_text ON transcript_spans(text_id);

CREATE TABLE IF NOT EXISTS transcript_suggestions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id    INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    srt_segment_id INTEGER NOT NULL REFERENCES srt_segments(id) ON DELETE CASCADE,
    start_offset   INTEGER NOT NULL,         -- offset into srt_segments.text
    end_offset     INTEGER NOT NULL,
    suggested_text TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset <= end_offset)
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
    start_offset   INTEGER NOT NULL,         -- offset into srt_segments.text
    end_offset     INTEGER NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset < end_offset)
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
"""


# Additive column migrations for pre-existing tables. Each is applied only if
# the column is missing, so existing rows and data are untouched.
_COLUMN_MIGRATIONS = {
    "texts": [
        ("instance_id", "TEXT"),
        ("teaching_id", "TEXT"),
        ("title_bo", "TEXT"),
        ("access_level", "INTEGER"),
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
    "suggestions": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "notes": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "markers": [("syl_id", "TEXT")],
    "tree_nodes": [("segment_start_syl_id", "TEXT")],
    "transcript_spans": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "transcript_suggestions": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
    "transcript_notes": [("start_syl_id", "TEXT"), ("end_syl_id", "TEXT")],
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
    conn.close()
