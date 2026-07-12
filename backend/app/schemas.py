from pydantic import BaseModel, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime

# ─── Texts ────────────────────────────────────────────────────────────────

class TextBase(BaseModel):
    title: str

class TextCreate(TextBase):
    pass

class TextMetaUpdate(BaseModel):
    """Editable text metadata (inline rename / regroup in the texts list). Only the
    provided fields change; an empty `text_group` clears the group (NULL == ungrouped)."""
    title: Optional[str] = None
    text_group: Optional[str] = None

class TextGroupCreate(BaseModel):
    """Register a (possibly empty) group path so it persists with no texts in it (Part 12)."""
    path: str

class TextGroupMove(BaseModel):
    """Reorganize a group: nest `src_path` under `dest_path` ("" == top level)."""
    src_path: str
    dest_path: str = ""

class TextGroupDelete(BaseModel):
    """Delete an empty group (and any empty registry descendants)."""
    path: str

class TextGroupReorder(BaseModel):
    """Place `src_path` under `parent_path` ("" == root), immediately before the sibling
    `before_path` (or at the end if empty). Reorders root columns and promotes a sub-group
    to an independent root group (Part 13)."""
    src_path: str
    parent_path: str = ""
    before_path: str = ""

class TextOut(TextBase):
    id: int
    filename: str
    # Optional user-assigned collection label; NULL == ungrouped (Part 10).
    text_group: Optional[str] = None
    text_type: str = 'primary'
    parent_text_id: Optional[int] = None
    # Set on a text created by "duplicate (bake edits)" → the id of the original it was
    # cloned from. NULLed automatically (FK ON DELETE SET NULL) when the original is
    # deleted, so the duplicate then reads as an ordinary text. `has_clone` (computed)
    # marks the reverse: a text that some duplicate points back to.
    cloned_from_text_id: Optional[int] = None
    has_clone: bool = False
    created_at: datetime
    updated_at: datetime
    span_count: int = 0
    tag_count: int = 0
    model_config = ConfigDict(from_attributes=True)

class TextDetailOut(TextOut):
    raw_text: str
    units: List[list]  # [start, end, text]
    instance_id: Optional[str] = None
    main_text_srt_dir: Optional[str] = None
    audio_dir: Optional[str] = None

class ExtractIn(BaseModel):
    """Extract a syllable range of a primary text into a new independent primary text
    (and reversibly remove the range from the source via a delete-suggestion)."""
    start_syl_id: str
    end_syl_id: str
    title: Optional[str] = None

class CloneIn(BaseModel):
    """Duplicate a primary text with its edits/deletions physically baked into raw_text."""
    title: Optional[str] = None

# ─── Passages (primary-text inline syllable-link transclusion) ─────────────────

class PassageMemberIn(BaseModel):
    src_start_syl_id: str
    src_end_syl_id: str

class PassageMemberSyllable(BaseModel):
    syl_id: str
    idx: int
    text: str
    nature: str

class PassageMemberOut(BaseModel):
    position: int
    src_start_syl_id: str
    src_end_syl_id: str
    syllables: List[PassageMemberSyllable] = []

class PassageCreate(BaseModel):
    anchor_syl_id: Optional[str] = None
    position: int = 0
    color: Optional[str] = None
    # Attachment side at a segment boundary: True = render at the END of the previous
    # segment ("stays on the same segment"); False = head the anchor's segment.
    attach_prev: bool = False
    members: List[PassageMemberIn] = []

class PassageUpdate(BaseModel):
    anchor_syl_id: Optional[str] = None
    position: Optional[int] = None
    color: Optional[str] = None
    # The marker-free split boundary: True = a segment boundary starts right BEFORE this
    # passage (it begins a new standalone segment; following non-flagged passages at the
    # same anchor flow into that same segment).
    own_segment: Optional[bool] = None
    members: Optional[List[PassageMemberIn]] = None  # None = leave members alone

class PassageSplitIn(BaseModel):
    """Divide a passage in two after `after_syl_id` (must be strictly interior to the
    passage's flattened run) — the "split inside a passage" gesture. The second half
    becomes a new passage right after the original; per-occurrence notes whose anchors
    fall in the second half move with it."""
    after_syl_id: str
    # True when the split starts a new segment (trailing-at-segment-end / standalone-card
    # cases) — set on the second half.
    second_own_segment: bool = False
    # Attachment sides after the split (mid-segment case: first True, second False, plus
    # a marker at the anchor offset). None = keep the original's value.
    first_attach_prev: Optional[bool] = None
    second_attach_prev: Optional[bool] = None

class PassageOut(BaseModel):
    id: int
    text_id: int
    anchor_syl_id: Optional[str] = None
    position: int
    color: Optional[str] = None
    attach_prev: bool = False
    own_segment: bool = False
    # True when INHERITED from a source text — read-only here (edit on the owner).
    inherited: bool = False
    members: List[PassageMemberOut] = []

class PassageSplitOut(BaseModel):
    first: PassageOut
    second: PassageOut

# ─── Secondary-text derivation (links + overrides, syllable-native) ────────────

class ComposedToken(BaseModel):
    idx: int
    id: str                         # syllable uuid (parent link, transcluded, or hosted)
    text: str
    nature: str
    inserted: bool = False          # kept for EditorToken shape compatibility (always False here)
    start_offset: int               # cumulative offset over the COMPOSED text (frontend aid only)
    end_offset: int
    source: str                     # 'parent-link' | 'transclusion' | 'override' | 'added'
    parent_syl_id: Optional[str] = None   # provenance for overrides
    src_text_id: Optional[int] = None     # provenance for transclusions
    original: Optional[str] = None        # parent text an override replaced
    # The derivation op that emitted this token (transclusion/hosted). Disambiguates
    # OCCURRENCES: the same source transcluded twice repeats the same uuids.
    op_id: Optional[int] = None

class ComposedOut(BaseModel):
    tokens: List[ComposedToken] = []
    raw_text: str = ''              # concatenation of composed token texts (frontend aid)

class EditRangeIn(BaseModel):
    start_syl_id: str               # inclusive first PARENT syllable of the edited run
    end_syl_id: str                 # inclusive last PARENT syllable of the edited run
    new_text: str                   # the free-text replacement for that run

class TranscludeIn(BaseModel):
    anchor_syl_id: Optional[str] = None   # composed token to splice BEFORE; None = append
    src_text_id: int
    # Inclusive source range. BOTH omitted = transclude the source's WHOLE sequence
    # (the backend resolves first/last tokens itself).
    src_start_syl_id: Optional[str] = None
    src_end_syl_id: Optional[str] = None
    # The op that emitted the anchor token (ComposedToken.op_id) — names the
    # OCCURRENCE when the same source is transcluded several times.
    anchor_op_id: Optional[int] = None

class InsertBreakIn(BaseModel):
    # Manual line break: hosted "\n" inserted BEFORE this composed token; None = at end.
    before_syl_id: Optional[str] = None
    anchor_op_id: Optional[int] = None    # occurrence hint, see TranscludeIn

# ─── Tags ─────────────────────────────────────────────────────────────────────

class TagBase(BaseModel):
    name: str
    color: Optional[str] = '#6366f1'
    tag_kind: Literal['regular', 'session'] = 'regular'
    open_position: Optional[int] = None
    close_position: Optional[int] = None

class TagCreate(TagBase):
    # Part 6: syllable-native session boundaries (preferred). When present the
    # server derives open/close offsets from the syllables table.
    open_syl_id: Optional[str] = None
    close_syl_id: Optional[str] = None

class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    # Part 8: share toggle. is_shared=True → the tag becomes global (text_id NULL);
    # is_shared=False → private, owned by `text_id` (the currently-open text, required
    # when un-sharing). Both ignored when is_shared is not supplied.
    is_shared: Optional[bool] = None
    text_id: Optional[int] = None
    # `__unset__` is the sentinel for "leave alone"; explicit None on the wire
    # for these two fields clears the marker.
    open_position: Optional[int] = None
    close_position: Optional[int] = None
    # Part 6: syllable-native boundaries (preferred). When present the server
    # derives open/close offsets from the syllables table.
    open_syl_id: Optional[str] = None
    close_syl_id: Optional[str] = None

class TagOut(TagBase):
    id: int
    # Part 8: NULL text_id == a shared tag (shown in every text's palette).
    text_id: Optional[int] = None
    is_shared: bool = False
    model_config = ConfigDict(from_attributes=True)

# ─── Spans ────────────────────────────────────────────────────────────────────

class SpanBase(BaseModel):
    tag_id: int
    start_offset: int
    end_offset: int

class SpanCreate(BaseModel):
    tag_id: int
    # Part 6: syllable-native anchors (preferred). When present the server derives
    # the char offsets from the syllables table, so the selection the frontend
    # rendered is authoritative — no second tokenisation to disagree with.
    start_syl_id: Optional[str] = None
    end_syl_id: Optional[str] = None
    # Legacy offset path — still accepted, ignored when syl ids are present.
    start_offset: Optional[int] = None
    end_offset: Optional[int] = None

class SpanUpdate(BaseModel):
    tag_id: Optional[int] = None

class SpanOut(SpanBase):
    id: int
    text_id: int
    tag: Optional[TagOut] = None
    # Part 6: return the syllable anchors so the client can replay (e.g. undo) by
    # syllable id rather than by the drift-prone char offsets.
    start_syl_id: Optional[str] = None
    end_syl_id: Optional[str] = None
    # True for a SOURCE text's span shown inside transcluded content (read-only here —
    # its home is the source text; changing it means changing the source's tags).
    inherited: bool = False
    model_config = ConfigDict(from_attributes=True)

# ─── Markers ──────────────────────────────────────────────────────────────────

class MarkerOut(BaseModel):
    id: int
    text_id: int
    position: int
    # Part 6: the syllable that starts at the boundary, so the client can replay
    # (undo) a separator by syllable id rather than by offset.
    syl_id: Optional[str] = None
    # True when this boundary is INHERITED from a source text (parent/transclusion)
    # — read-only here; edit it on its owning text. See app/inherit.py.
    inherited: bool = False
    model_config = ConfigDict(from_attributes=True)

class MarkerCreate(BaseModel):
    # Part 6: syllable-native boundary (preferred) — the syllable that starts at
    # the marker. `position` is the legacy offset path, ignored when syl_id is set.
    syl_id: Optional[str] = None
    position: Optional[int] = None

# ─── Tree nodes ───────────────────────────────────────────────────────────────

class TreeNodeBase(BaseModel):
    title: Optional[str] = None
    segment_start: Optional[int] = None
    transparent: bool = False

class TreeNodeCreate(TreeNodeBase):
    parent_id: Optional[int] = None
    position: Optional[int] = None  # None = append to end
    # Part 6: syllable-native boundary (preferred) — the syllable the segment
    # starts at. Derives `segment_start` server-side.
    segment_start_syl_id: Optional[str] = None

class TreeNodeUpdate(BaseModel):
    title: Optional[str] = None
    transparent: Optional[bool] = None
    segment_start: Optional[int] = None  # explicit null unlinks; absent leaves alone
    # Part 6: syllable-native boundary (preferred). When present, derives
    # `segment_start`; explicit null still unlinks via `segment_start`.
    segment_start_syl_id: Optional[str] = None
    # Link the node to a PASSAGE occurrence instead of a segment (mutually exclusive:
    # setting one clears the other). Explicit null unlinks; absent leaves alone.
    passage_id: Optional[int] = None

class TreeNodeMove(BaseModel):
    new_parent_id: Optional[int] = None
    new_position: int

class TreeNodeReorder(BaseModel):
    parent_id: Optional[int] = None
    ordered_ids: List[int]

class TreeNodeOut(TreeNodeBase):
    id: int
    text_id: int
    parent_id: Optional[int] = None
    position: int
    # Set when this sapche section IS a passage occurrence (mutually exclusive with
    # segment_start).
    passage_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    # True when INHERITED from a source text — read-only here (edit on the owner).
    inherited: bool = False
    model_config = ConfigDict(from_attributes=True)

# ─── Suggestions ──────────────────────────────────────────────────────────────

class SuggestionBase(BaseModel):
    start_offset: int
    end_offset: int
    suggested_text: str

class SuggestionCreate(BaseModel):
    suggested_text: str
    # Part 6: syllable-native anchors (preferred). Range = (start_syl_id,
    # end_syl_id). Zero-width insertion = start_syl_id set, end_syl_id null
    # (insert *before* start_syl_id). Offsets are derived server-side.
    start_syl_id: Optional[str] = None
    end_syl_id: Optional[str] = None
    # Legacy offset path — still accepted, ignored when start_syl_id is present.
    start_offset: Optional[int] = None
    end_offset: Optional[int] = None

class SuggestionOut(SuggestionBase):
    id: int
    text_id: int
    created_at: datetime
    # Part 6: syllable anchors so the client can replay (undo) by syllable id.
    start_syl_id: Optional[str] = None
    end_syl_id: Optional[str] = None
    # Set when this delete-suggestion came from /extract; the text the range moved into
    # (so the UI can label "extracted → <title>" and offer to open it).
    extracted_text_id: Optional[int] = None
    # Upstream review flow: 'applied' = live correction; 'pending' = incoming from a
    # derived text (origin_*), awaiting review here — no effect until accepted.
    status: str = 'applied'
    origin_text_id: Optional[int] = None
    origin_title: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class SuggestUpstreamIn(BaseModel):
    """A correction proposed FROM a derived text, routed to the text where the selected
    syllables first appear (their owner). Anchors are composed-token ids — which ARE the
    owner's syllable uuids. end_syl_id None = zero-width insertion before start_syl_id;
    empty suggested_text = proposed deletion."""
    start_syl_id: str
    end_syl_id: Optional[str] = None
    suggested_text: str

class SuggestUpstreamOut(BaseModel):
    suggestion_id: int
    routed_to_text_id: int
    routed_to_title: str

class SuggestionAcceptIn(BaseModel):
    # 'stage' = join the owner's staged corrections (ripples at the next Apply-all);
    # 'ripple' = bake just this suggestion into the base now (derived texts update
    # immediately; other staged corrections stay staged).
    mode: Literal['stage', 'ripple'] = 'stage'

# ─── Transcript spans (per-syllable tags on the transcription) ─────────────────

class TranscriptSpanCreate(BaseModel):
    tag_id: int
    start_offset: int
    end_offset: int

class TranscriptSpanUpdate(BaseModel):
    tag_id: Optional[int] = None

class TranscriptSpanOut(BaseModel):
    id: int
    text_id: int
    srt_segment_id: int
    tag_id: int
    start_offset: int
    end_offset: int
    tag: Optional[TagOut] = None
    model_config = ConfigDict(from_attributes=True)

# ─── Transcript suggestions (per-syllable corrections on the transcription) ─────

class TranscriptSuggestionCreate(BaseModel):
    start_offset: int
    end_offset: int
    suggested_text: str

class TranscriptSuggestionOut(BaseModel):
    id: int
    text_id: int
    srt_segment_id: int
    start_offset: int
    end_offset: int
    suggested_text: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

# ─── Transcript notes (notes on the transcription, keyed by SRT segment) ────────

class TranscriptNoteCreate(BaseModel):
    category_id: Optional[int] = None
    start_offset: int
    end_offset: int
    body: str = ''

class TranscriptNoteUpdate(BaseModel):
    category_id: Optional[int] = None
    body: Optional[str] = None

class TranscriptNoteOut(BaseModel):
    id: int
    text_id: int
    srt_segment_id: int
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    start_offset: int
    end_offset: int
    body: str
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

# ─── Transcript search (cross-session syllable search) ─────────────────────────

class SearchSyllable(BaseModel):
    text: str
    nature: str
    start: int          # offset into corrected_text
    end: int
    raw_start: Optional[int] = None  # offset into srt_segments.text (None if from a correction)
    raw_end: Optional[int] = None

class SearchMatch(BaseModel):
    start: int          # offset into corrected_text
    end: int

class SearchResult(BaseModel):
    text_id: int
    text_title: str
    instance_id: Optional[str] = None
    session_tag_id: int
    session_name: str
    srt_segment_id: int
    seg_id: int
    corrected_text: str
    syllables: List[SearchSyllable]
    matches: List[SearchMatch]
    suggestions: List[TranscriptSuggestionOut]

# ─── Notes ────────────────────────────────────────────────────────────────────

class NoteCategoryCreate(BaseModel):
    name: str

class NoteCategoryOut(BaseModel):
    id: int
    text_id: int
    name: str
    model_config = ConfigDict(from_attributes=True)

class NoteCreate(BaseModel):
    category_id: Optional[int] = None
    start_offset: int
    end_offset: int
    body: str = ''
    session_tag_ids: List[int] = []
    # A note ON a passage occurrence: renders only inside that passage run, never at
    # the source occurrence of the shared syllables. NULL = normal host-text note.
    passage_id: Optional[int] = None

class NoteUpdate(BaseModel):
    category_id: Optional[int] = None
    body: Optional[str] = None
    # Absent = leave links alone. Empty list = unlink all sessions.
    session_tag_ids: Optional[List[int]] = None

class NoteOut(BaseModel):
    id: int
    text_id: int
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    start_offset: int
    end_offset: int
    body: str
    created_at: datetime
    updated_at: datetime
    session_tag_ids: List[int] = []
    session_tag_names: List[str] = []
    passage_id: Optional[int] = None
    # True when INHERITED from a source text — read-only here (edit on the owner).
    inherited: bool = False
    model_config = ConfigDict(from_attributes=True)

# ─── Display-only line-break overrides (the ¶ mode) ─────────────────────────────

class DisplayBreakIn(BaseModel):
    # Newlines rendered after the anchor token while ¶ mode is on: 0 = suppress the
    # automatic break there, 1 = one line, 2 = an empty line. Display-only.
    count: int

class DisplayBreakOut(BaseModel):
    syl_id: str
    count: int

# ─── Reading position (last-viewed segment per user & text) ─────────────────────

class ReadingPositionIn(BaseModel):
    # The syllable that begins the segment the user was last looking at.
    syl_id: Optional[str] = None

class ReadingPositionOut(BaseModel):
    text_id: int
    syl_id: Optional[str] = None
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

# ─── Documents (Phase D1: booklets assembled from ordered pages) ────────────────

DocumentItemKind = Literal['cover', 'blank', 'toc', 'copyright', 'text', 'image_page', 'backcover']

class DocumentCreate(BaseModel):
    title: str

class DocumentUpdate(BaseModel):
    title: str

class DocumentItemIn(BaseModel):
    kind: DocumentItemKind
    text_id: Optional[int] = None      # required iff kind == 'text'
    caption: Optional[str] = None
    body: Optional[str] = None

class DocumentItemPatch(BaseModel):
    text_id: Optional[int] = None
    caption: Optional[str] = None
    body: Optional[str] = None

class DocumentItemOut(BaseModel):
    id: int
    document_id: int
    position: int
    kind: str
    text_id: Optional[int] = None
    # Resolved title of the linked text (kind='text'), for display; None otherwise.
    text_title: Optional[str] = None
    caption: Optional[str] = None
    body: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

class DocumentOut(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime
    item_count: int = 0
    languages: List[str] = []          # ordered language codes
    model_config = ConfigDict(from_attributes=True)

class DocumentDetailOut(DocumentOut):
    items: List[DocumentItemOut] = []

class DocumentReorderIn(BaseModel):
    ordered_ids: List[int]

class DocumentLanguagesIn(BaseModel):
    # The ordered set of language codes this document is published in.
    langs: List[str]

# TOC: for each text page, its title and its top-level sections (no page numbers
# yet — pagination lands them in D2).
class TocSection(BaseModel):
    title: Optional[str] = None
    level: Optional[int] = None
    children: List['TocSection'] = []

class TocEntry(BaseModel):
    item_id: int
    text_id: int
    text_title: str
    sections: List[TocSection] = []

# ─── Pagination layout (Phase D2) ───────────────────────────────────────────────

DocumentLayoutKind = Literal['page_break', 'line_space', 'line_nospace', 'wrap_extend']

class DocumentLayoutRow(BaseModel):
    id: int
    document_id: int
    item_id: int
    anchor_syl_id: str
    kind: str
    char_offset: Optional[int] = None
    value: Optional[float] = None
    lang: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

class DocumentLayoutIn(BaseModel):
    item_id: int
    anchor_syl_id: str
    kind: DocumentLayoutKind
    char_offset: Optional[int] = None
    value: Optional[float] = None
    lang: Optional[str] = None

class DocumentLayoutDeleteIn(BaseModel):
    item_id: int
    anchor_syl_id: str
    kind: DocumentLayoutKind
    lang: Optional[str] = None

class DocumentLayoutConfigIn(BaseModel):
    # Partial page-geometry/type overrides merged onto the built-in defaults.
    config: dict

class DocumentLayoutOut(BaseModel):
    config: dict                       # effective geometry (defaults + overrides)
    rows: List[DocumentLayoutRow] = []
