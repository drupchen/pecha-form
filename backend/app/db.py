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

-- ─── Translation collaboration (Phase T2) ───────────────────────────────────────
-- Booklet-local variant of a canonical translation (style/wording tweaks that stay
-- at the booklet level). `text_id` = the booklet (secondary text; Documents wrap
-- these later). `base_updated_at` snapshots the canonical row's updated_at at fork
-- time — the override is STALE when the canonical has moved past it.
CREATE TABLE IF NOT EXISTS translation_overrides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id         INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    chunk_id        INTEGER NOT NULL REFERENCES translation_chunks(id) ON DELETE CASCADE,
    lang            TEXT NOT NULL REFERENCES languages(code),
    body            TEXT NOT NULL DEFAULT '',
    base_updated_at TEXT,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(text_id, chunk_id, lang)
);

-- Per-booklet acknowledgement watermark: "update available" = the canonical
-- translation's updated_at is newer than what this booklet last acknowledged.
CREATE TABLE IF NOT EXISTS translation_seen (
    text_id         INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    chunk_id        INTEGER NOT NULL REFERENCES translation_chunks(id) ON DELETE CASCADE,
    lang            TEXT NOT NULL,
    seen_updated_at TEXT NOT NULL,
    PRIMARY KEY (text_id, chunk_id, lang)
);

-- Suggest-upstream: a booklet proposes its wording for the CANONICAL translation.
-- Accepting updates the canonical row → ripples to every booklet reusing the chunk.
CREATE TABLE IF NOT EXISTS translation_suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id     INTEGER NOT NULL REFERENCES translation_chunks(id) ON DELETE CASCADE,
    lang         TEXT NOT NULL,
    body         TEXT NOT NULL,
    from_text_id INTEGER REFERENCES texts(id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_translation_suggestions_chunk ON translation_suggestions(chunk_id);

-- Scramble layer: translator-driven DISPLAY arrangement of the chunk stream.
-- kind='move': the small/sapche instruction fragment (src range) displays at
-- anchor_syl_id instead of at its source position. Two intents, `move_mode`:
--   'inline'  — the translator's HAIRLINE: the fragment is integrated INSIDE the
--               destination chunk, right before (anchor_after=0) or right after
--               (anchor_after=1) the anchor syllable. It joins that chunk's
--               translation unit; it gets no translation box of its own.
--   'segment' — the translator's BAR between chunks: the fragment stands as its
--               OWN segment before the chunk starting at anchor_syl_id, with its
--               own translation. anchor_syl_id NULL = end of stream (both modes).
-- kind='title': a synthetic title chunk (no Tibetan) appears before the anchor,
-- with a heading level; its per-language text lives in layout_titles. text_id
-- NULL = GLOBAL default (applies wherever the content appears); non-NULL =
-- booklet-specific. A booklet 'move' row with the same src range shadows the
-- global one; disabled=1 lets a booklet switch a global row off.
CREATE TABLE IF NOT EXISTS chunk_layouts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id          INTEGER REFERENCES texts(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('move', 'title')),
    src_start_syl_id TEXT,
    src_end_syl_id   TEXT,
    anchor_syl_id    TEXT,
    move_mode        TEXT,
    anchor_after     INTEGER NOT NULL DEFAULT 0,
    level            INTEGER,
    disabled         INTEGER NOT NULL DEFAULT 0,
    position         INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS layout_titles (
    layout_id  INTEGER NOT NULL REFERENCES chunk_layouts(id) ON DELETE CASCADE,
    lang       TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (layout_id, lang)
);

-- ─── Phonetics (Phase P; table created at T3 for the legacy import) ─────────────
-- One row per run/line PER LANGUAGE, anchored to origin-text syllables like
-- translations, so phonetics ripple into every booklet reusing the passage.
-- kind: 'bo' = Tibetan phonetics, 'skt' = Sanskrit mantra romanization. lang scopes
-- the body (the booklets ship distinct phonetics per language — e.g. skt fr "Houng"
-- vs en "Hung"), exactly like the translation layer.
CREATE TABLE IF NOT EXISTS phonetics (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
    start_syl_id   TEXT NOT NULL,
    end_syl_id     TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('bo', 'skt')),
    lang           TEXT NOT NULL DEFAULT 'en',
    body           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'edited', 'reviewed')),
    engine         TEXT,
    engine_version TEXT,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(origin_text_id, start_syl_id, end_syl_id, kind, lang)
);
CREATE INDEX IF NOT EXISTS idx_phonetics_text ON phonetics(origin_text_id);

-- ─── Documents (Phase D1): booklets assembled from ordered pages ────────────────
-- A document is a booklet: an ordered sequence of `document_items` (multiple
-- secondary texts + furniture pages), published in a set of `document_languages`
-- that page-align. Pagination + PDF are D2/D3; D1 is the structure only.
CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL CHECK (kind IN
                    ('cover','blank','toc','copyright','text','image_page','backcover')),
    -- Set for kind='text' — the secondary (or primary) text this page renders.
    text_id     INTEGER REFERENCES texts(id) ON DELETE SET NULL,
    -- Furniture params (styled at D2/D3): image caption, cover/copyright text, etc.
    caption     TEXT,
    body        TEXT
);
CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id);

CREATE TABLE IF NOT EXISTS document_languages (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    lang        TEXT NOT NULL REFERENCES languages(code),
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_id, lang)
);

-- ─── Pagination layout (Phase D2): shared page breaks + per-line balancing ──────
-- The booklet's page breaks and balancing live on the DOCUMENT at SHARED,
-- syllable-anchored positions, so all language editions page-align exactly (tuning
-- one lays out all four). kind: 'page_break' (a page boundary at anchor_syl_id,
-- optional char_offset for a mid-line/mid-syllable hairline split), 'line_space'
-- (signed empty-line gap delta), 'line_nospace' (drop the blank line), 'wrap_extend'
-- (push a translation line's right wrap limit rightward). `value` is REAL (mm/px or
-- a signed unit per kind). `lang` NULL = applies to every edition; a language code
-- scopes a translation-only adjustment (e.g. a per-language split of a straddling
-- chunk). Page geometry/type sizes live in documents.layout_config (JSON).
-- `width_*` = a signed per-line-block width in mm: positive overflows that block toward
-- its page's right physical border, negative narrows it so the text wraps. One kind per
-- rendered block (tibetan/phonetics/translation/section) because the UNIQUE key carries
-- the kind, so that is where the target has to live. `wrap_extend` is their superseded,
-- positive-only, translation-only predecessor (legacy rows only).
CREATE TABLE IF NOT EXISTS document_layout (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    item_id      INTEGER NOT NULL REFERENCES document_items(id) ON DELETE CASCADE,
    anchor_syl_id TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN
                     ('page_break','line_space','line_nospace','wrap_extend','hairline','recto_cut',
                      'width_tibetan','width_phonetics','width_translation','width_section')),
    char_offset  INTEGER,
    value        REAL,
    lang         TEXT,
    UNIQUE(document_id, item_id, anchor_syl_id, kind, lang)
);
CREATE INDEX IF NOT EXISTS idx_document_layout_doc ON document_layout(document_id);

-- Per-language authored content for FURNITURE items (cover/title/copyright/image
-- caption). Booklet-specific (NOT a text): e.g. the copyright page's per-language text.
-- The title page's translated title is seeded from the text's own title but can be
-- overridden here. body is the sanitized HTML subset used by the translation layer.
CREATE TABLE IF NOT EXISTS document_furniture (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES document_items(id) ON DELETE CASCADE,
    lang        TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (document_id, item_id, lang)
);

-- The image for an `image_page` furniture item (Phase D3). One image per item, stored
-- inline (booklet images are few and small); shared across language editions.
CREATE TABLE IF NOT EXISTS document_images (
    item_id     INTEGER PRIMARY KEY REFERENCES document_items(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    mime        TEXT NOT NULL,
    data        BLOB NOT NULL,
    width_mm    REAL,             -- display size; NULL = natural (object-fit: contain)
    height_mm   REAL,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Style designer (Phase 4). Booklet typography is data-driven: ORGANIZATION-wide style
-- templates + per-DOCUMENT overrides, resolved default ← org ← document at render.
-- Organizations/users are NOT built yet — this only PREPARES the org dimension; assume
-- org 1 / user 1 for now (a single seeded organization keeps the FK valid).
CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'Default organization',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Org-wide style for a named booklet role (JSON props: font_family/size/weight/italic/
-- color/line_height/align). Missing role or prop → the built-in default.
CREATE TABLE IF NOT EXISTS style_roles (
    org_id INTEGER NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
    role   TEXT NOT NULL,
    props  TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (org_id, role)
);

-- Per-document override of a role's props (partial JSON — only the overridden props).
CREATE TABLE IF NOT EXISTS document_style_overrides (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    props       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (document_id, role)
);

-- Org-uploaded fonts (@font-face), selectable by any role alongside the bundled fonts.
CREATE TABLE IF NOT EXISTS org_fonts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
    family     TEXT NOT NULL,
    weight     INTEGER NOT NULL DEFAULT 400,
    italic     INTEGER NOT NULL DEFAULT 0,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The org's cover ornament (seal/logo) — part of the template, like the fonts. It prints at
-- the ༀ placeholder on EVERY booklet's cover; a booklet that uploads its own cover image
-- (document_images) overrides it, and with neither the ༀ glyph shows. One row per org;
-- width/height in mm (NULL = the image's natural size).
CREATE TABLE IF NOT EXISTS org_seal (
    org_id     INTEGER PRIMARY KEY DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    width_mm   REAL,
    height_mm  REAL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The Style Studio's editable specimen (a JSON list of blocks) — a per-org sample that
-- covers every role, so a style template can be designed/tested in one place.
CREATE TABLE IF NOT EXISTS style_samples (
    org_id  INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT ''
);
"""


# Additive column migrations for pre-existing tables. Each is applied only if
# the column is missing, so existing rows and data are untouched.
_COLUMN_MIGRATIONS = {
    # Image display size (Phase D3 resize) — added to the pre-existing document_images table.
    "document_images": [
        ("width_mm", "REAL"),
        ("height_mm", "REAL"),
    ],
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
                 ("own_segment", "INTEGER NOT NULL DEFAULT 0"),
                 # Passage-local translation overrides (JSON {lang: body}) — a passage
                 # repeats earlier content, so its translation is retrieved from the
                 # source; this holds a per-occurrence edit that leaves the source intact.
                 ("translations", "TEXT")],
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
    # D2: page geometry + type sizes for the booklet layout (JSON; NULL = defaults).
    "documents": [("layout_config", "TEXT")],
    # The two move gestures of the translate bench (see the chunk_layouts CREATE):
    # 'inline' = hairline (integrate inside the anchor's chunk, before/after the anchor
    # syllable), 'segment' = bar (stand as an own segment). NULL = legacy row → 'inline'.
    "chunk_layouts": [("move_mode", "TEXT"),
                      ("anchor_after", "INTEGER NOT NULL DEFAULT 0")],
}


def _add_missing_columns(conn) -> None:
    for table, columns in _COLUMN_MIGRATIONS.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _rebuild_document_layout_kinds(conn) -> None:
    """Widen `document_layout.kind`'s CHECK to include newer kinds ('hairline', then
    'recto_cut', then the per-block 'width_*' set). SQLite can't alter a CHECK in place, so
    rebuild the table when an older one predates the newest kind. The sentinel is the LAST
    kind added — bump it whenever the CHECK grows. No-op on fresh DBs (SCHEMA lists them).
    `document_layout` is a leaf (nothing references it), so the drop/rename is safe."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='document_layout'"
    ).fetchone()
    if not row or "'width_section'" in row["sql"]:
        return
    conn.execute("""
        CREATE TABLE document_layout_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            item_id      INTEGER NOT NULL REFERENCES document_items(id) ON DELETE CASCADE,
            anchor_syl_id TEXT NOT NULL,
            kind         TEXT NOT NULL CHECK (kind IN
                             ('page_break','line_space','line_nospace','wrap_extend','hairline','recto_cut',
                              'width_tibetan','width_phonetics','width_translation','width_section')),
            char_offset  INTEGER,
            value        REAL,
            lang         TEXT,
            UNIQUE(document_id, item_id, anchor_syl_id, kind, lang)
        )""")
    conn.execute("""
        INSERT INTO document_layout_new
            (id, document_id, item_id, anchor_syl_id, kind, char_offset, value, lang)
        SELECT id, document_id, item_id, anchor_syl_id, kind, char_offset, value, lang
        FROM document_layout""")
    conn.execute("DROP TABLE document_layout")
    conn.execute("ALTER TABLE document_layout_new RENAME TO document_layout")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_document_layout_doc ON document_layout(document_id)")


def _rebuild_phonetics_lang(conn) -> None:
    """Add the `lang` dimension to a pre-existing `phonetics` table. SQLite can't
    alter a UNIQUE constraint in place, so rebuild: the legacy-import rows were
    single-language and are re-imported PER language (scripts/import_legacy_
    translations.py), so they are dropped here; any user-authored rows are kept as
    lang='en'. No-op once `lang` exists (incl. fresh DBs created from SCHEMA)."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(phonetics)")}
    if not cols or "lang" in cols:
        return
    conn.execute("""
        CREATE TABLE phonetics_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            origin_text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
            start_syl_id   TEXT NOT NULL,
            end_syl_id     TEXT NOT NULL,
            kind           TEXT NOT NULL CHECK (kind IN ('bo', 'skt')),
            lang           TEXT NOT NULL DEFAULT 'en',
            body           TEXT NOT NULL DEFAULT '',
            status         TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'edited', 'reviewed')),
            engine         TEXT,
            engine_version TEXT,
            updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(origin_text_id, start_syl_id, end_syl_id, kind, lang)
        )""")
    # Keep only user-authored rows (legacy-import is superseded by the per-lang
    # re-import); label them 'en'.
    conn.execute("""
        INSERT INTO phonetics_new
            (id, origin_text_id, start_syl_id, end_syl_id, kind, lang, body, status,
             engine, engine_version, updated_at)
        SELECT id, origin_text_id, start_syl_id, end_syl_id, kind, 'en', body, status,
             engine, engine_version, updated_at
        FROM phonetics
        WHERE engine IS NULL OR engine <> 'legacy-import'""")
    conn.execute("DROP TABLE phonetics")
    conn.execute("ALTER TABLE phonetics_new RENAME TO phonetics")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_phonetics_text ON phonetics(origin_text_id)")


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
    # The NEW booklet entity (Phase D1) is also named `documents`, with child tables
    # `document_items`/`document_languages` that own a real `document_id`. Only the
    # LEGACY `documents` table (the former `texts`) carries text columns like
    # `raw_text`; distinguish them so this historical rename never touches the booklets.
    NEW_BOOKLET_TABLES = {"document_items", "document_languages", "document_layout",
                          "document_furniture", "document_images", "document_style_overrides"}
    documents_is_legacy = "documents" in tables and "raw_text" in {
        r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
    if documents_is_legacy:
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
        if t in NEW_BOOKLET_TABLES:
            continue  # their `document_id` legitimately references the booklet entity
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
    # legacy_alter_table: without it, `RENAME TO tags__old` REWRITES the FK clauses of every
    # child table to reference `tags__old` — so the children end up pointing at the scratch
    # table instead of the rebuilt `tags` (see _repair_tag_fks, which repairs DBs where this
    # already happened). Legacy mode leaves child DDL alone, which is what a rebuild wants.
    conn.execute("PRAGMA legacy_alter_table = ON")
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
        conn.execute("PRAGMA legacy_alter_table = OFF")
        conn.execute("PRAGMA foreign_keys = ON")


# Repair for DBs rebuilt by an earlier (non-legacy_alter_table) run of the tags rebuild: the
# RENAME rewrote every child's FK to `tags__old`, and that scratch table survived, still owning
# the pre-share `text_id` values. The children therefore CASCADE off the scratch table, so
# deleting the text that once owned the tags would wipe every span/portion in the DB. Repoint
# each child's FK back at `tags` (table rebuild — SQLite can't alter an FK in place) and drop
# the scratch table. Idempotent: does nothing once `tags__old` is gone. Must run OUTSIDE a
# transaction (it toggles PRAGMAs), like the migrations above.
def _repair_tag_fks(conn) -> None:
    stale = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tags__old'"
    ).fetchone()
    if not stale:
        return
    children = [
        (r["name"], r["sql"]) for r in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' "
            "AND name <> 'tags__old' AND sql LIKE '%tags__old%'")
    ]
    counts = {n: conn.execute(f"SELECT COUNT(*) AS c FROM {n}").fetchone()["c"]
              for n, _ in children}
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA legacy_alter_table = ON")
    try:
        with conn:
            for name, sql in children:
                indexes = [r["sql"] for r in conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? "
                    "AND sql IS NOT NULL", (name,))]
                fixed = sql.replace('"tags__old"', "tags").replace("tags__old", "tags")
                conn.execute(fixed.replace(f'"{name}"', f'"{name}__new"', 1)
                             if f'"{name}"' in fixed else
                             fixed.replace(name, f"{name}__new", 1))
                conn.execute(f"INSERT INTO {name}__new SELECT * FROM {name}")
                conn.execute(f"DROP TABLE {name}")
                conn.execute(f"ALTER TABLE {name}__new RENAME TO {name}")
                for ddl in indexes:
                    conn.execute(ddl)
                after = conn.execute(f"SELECT COUNT(*) AS c FROM {name}").fetchone()["c"]
                if after != counts[name]:
                    raise RuntimeError(
                        f"{name} rebuild changed row count: {counts[name]} -> {after}")
            conn.execute("DROP TABLE tags__old")
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(f"Foreign-key violations after tag-FK repair: {violations[:5]}")
    finally:
        conn.execute("PRAGMA legacy_alter_table = OFF")
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
        _rebuild_document_layout_kinds(conn)
        _rebuild_phonetics_lang(conn)
        # Seed the four working languages (idempotent; more are added via the API).
        conn.executemany(
            "INSERT OR IGNORE INTO languages (code, name) VALUES (?, ?)",
            [("en", "English"), ("fr", "Français"), ("de", "Deutsch"), ("pt", "Português")],
        )
        # Seed the single default organization (org/user management is not built yet).
        conn.execute("INSERT OR IGNORE INTO organizations (id, name) VALUES (1, 'Default organization')")
    # Offset-column drop runs after the additive schema, on its own (non-nested)
    # transaction with foreign_keys OFF — see _drop_offset_columns.
    _drop_offset_columns(conn)
    # Part 8: make tags.text_id nullable (shared tags). Runs after the offset drop so
    # `tags` already has its final column set; own foreign_keys-OFF transaction.
    _make_tags_text_id_nullable(conn)
    # …then repair DBs whose earlier tags rebuild left the children FK-ing `tags__old`.
    _repair_tag_fks(conn)
    conn.close()
