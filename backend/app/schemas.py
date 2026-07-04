from pydantic import BaseModel, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime

# ─── Texts ────────────────────────────────────────────────────────────────

class TextBase(BaseModel):
    title: str

class TextCreate(TextBase):
    pass

class TextOut(TextBase):
    id: int
    filename: str
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
    members: List[PassageMemberIn] = []

class PassageUpdate(BaseModel):
    anchor_syl_id: Optional[str] = None
    position: Optional[int] = None
    color: Optional[str] = None
    members: Optional[List[PassageMemberIn]] = None  # None = leave members alone

class PassageOut(BaseModel):
    id: int
    text_id: int
    anchor_syl_id: Optional[str] = None
    position: int
    color: Optional[str] = None
    members: List[PassageMemberOut] = []

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

class ComposedOut(BaseModel):
    tokens: List[ComposedToken] = []
    raw_text: str = ''              # concatenation of composed token texts (frontend aid)

class EditRangeIn(BaseModel):
    start_syl_id: str               # inclusive first PARENT syllable of the edited run
    end_syl_id: str                 # inclusive last PARENT syllable of the edited run
    new_text: str                   # the free-text replacement for that run

class TranscludeIn(BaseModel):
    anchor_syl_id: Optional[str] = None   # parent syllable to splice BEFORE; None = append
    src_text_id: int
    src_start_syl_id: str
    src_end_syl_id: str

# ─── Tags ─────────────────────────────────────────────────────────────────────

class TagBase(BaseModel):
    name: str
    color: Optional[str] = '#6366f1'
    tag_kind: Literal['regular', 'session'] = 'regular'
    open_position: Optional[int] = None
    close_position: Optional[int] = None

class TagCreate(TagBase):
    pass

class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    # `__unset__` is the sentinel for "leave alone"; explicit None on the wire
    # for these two fields clears the marker.
    open_position: Optional[int] = None
    close_position: Optional[int] = None

class TagOut(TagBase):
    id: int
    text_id: int
    model_config = ConfigDict(from_attributes=True)

# ─── Spans ────────────────────────────────────────────────────────────────────

class SpanBase(BaseModel):
    tag_id: int
    start_offset: int
    end_offset: int

class SpanCreate(SpanBase):
    pass

class SpanUpdate(BaseModel):
    tag_id: Optional[int] = None

class SpanOut(SpanBase):
    id: int
    text_id: int
    tag: Optional[TagOut] = None
    model_config = ConfigDict(from_attributes=True)

# ─── Markers ──────────────────────────────────────────────────────────────────

class MarkerOut(BaseModel):
    id: int
    text_id: int
    position: int
    model_config = ConfigDict(from_attributes=True)

class MarkerCreate(BaseModel):
    position: int

# ─── Tree nodes ───────────────────────────────────────────────────────────────

class TreeNodeBase(BaseModel):
    title: Optional[str] = None
    segment_start: Optional[int] = None
    transparent: bool = False

class TreeNodeCreate(TreeNodeBase):
    parent_id: Optional[int] = None
    position: Optional[int] = None  # None = append to end

class TreeNodeUpdate(BaseModel):
    title: Optional[str] = None
    transparent: Optional[bool] = None
    segment_start: Optional[int] = None  # explicit null unlinks; absent leaves alone

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
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

# ─── Suggestions ──────────────────────────────────────────────────────────────

class SuggestionBase(BaseModel):
    start_offset: int
    end_offset: int
    suggested_text: str

class SuggestionCreate(SuggestionBase):
    pass

class SuggestionOut(SuggestionBase):
    id: int
    text_id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

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
    model_config = ConfigDict(from_attributes=True)
