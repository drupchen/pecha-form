import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Segment } from './segments';
import { hasAdjacentNewline } from './segments';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore, selectRegularTags, selectSessionTags } from '../../store/useTagStore';
import { useUIStore } from '../../store/useUIStore';
import { useSuggestionStore } from '../../store/useSuggestionStore';
import { useNoteStore } from '../../store/useNoteStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { usePassageStore } from '../../store/usePassageStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import type { Passage } from '../../api/client';
import { editRange, suggestUpstream, transclude } from '../../api/client';
import { colorForSessionTag, SESSION_TAG_NAME_RE } from '../../lib/sessionTagColor';
import { Tag as TagIcon, Edit3, Scissors, X, Mic, StickyNote, Copy, Trash2, Link2, FileOutput, BookPlus, FileText } from 'lucide-react';

const COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#22c55e', '#06b6d4', '#3b82f6', '#6366f1',
  '#8b5cf6', '#d946ef', '#f43f5e', '#64748b',
];

interface Props {
  segment: Segment;
  selection: {
    start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect;
    /** Set when the selection lies inside a passage run — notes attach to that
     *  occurrence only; tags stay shared with the source. */
    passageId?: number;
  };
  /** Inline passages rendered at the END of this card. When the selection reaches
   *  segment.end, "Split here" starts a new segment at the boundary: the FIRST
   *  trailing passage becomes a starter and the rest flow into its segment. */
  trailingPassages?: Passage[];
  /** Split dispatch for selections INSIDE a passage run, supplied by the host card
   *  (which knows the anchor context) — passages split exactly like ordinary text. */
  passageSplit?: { canSplit: boolean; onSplit: () => Promise<void> };
  onClose: () => void;
}

type Mode = 'tag' | 'suggest' | 'note' | 'insert-text';

export const SegmentTagPopover: React.FC<Props> = ({ segment, selection, trailingPassages = [], passageSplit, onClose }) => {
  const { currentText, extractSelection, loadText, texts } = useTextStore();
  const tagStore = useTagStore();
  const { createTag, createSpan } = tagStore;
  const { createSuggestion } = useSuggestionStore();
  const { categories: noteCategories, createCategory, createNote } = useNoteStore();
  const createMarker = useMarkerStore(s => s.createMarker);
  const editPassage = usePassageStore(s => s.editPassage);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const setPendingPassageSource = useUIStore(s => s.setPendingPassageSource);
  const lineBreaksOn = useUIStore(s => s.lineBreaksOn);
  const toggleLineBreaks = useUIStore(s => s.toggleLineBreaks);
  const setDisplayBreak = useDisplayBreakStore(s => s.setBreak);
  // THE newline gesture — a display-only break after the selection's last syllable.
  // Works identically everywhere (host text, transcluded runs, passage runs) and
  // stays at this text's level. Turns ¶ mode on so the break is immediately visible.
  // Refuses to STACK next to an existing newline: blank lines must come only from
  // the explicit "empty line" option, never from two adjacent single breaks.
  const addDisplayBreak = async (count: 1 | 2) => {
    if (!currentText) return;
    const tokens = useEditorTokenStore.getState().tokens;
    const regular = useTagStore.getState().spans.filter(s => s.tag.tag_kind === 'regular');
    const overrides = useDisplayBreakStore.getState().breaks;
    const groups = useUIStore.getState().lineBreakGroups;
    if (hasAdjacentNewline(tokens, regular, overrides, groups, selection.endSylId)) {
      setError("A line break already sits next to the selection — edit its ↵ icon "
        + "(e.g. choose 'empty line') instead of adding another.");
      return;
    }
    await setDisplayBreak(currentText.id, selection.endSylId, count);
    if (!lineBreaksOn) toggleLineBreaks();
    onClose();
  };

  // In session mode the popover offers only session tags (and only Tag mode);
  // in regular mode only regular tags.
  const availableTags = sessionMode ? selectSessionTags(tagStore) : selectRegularTags(tagStore);

  // In consult mode the Tag tab is gone, so default to Suggest edit.
  const [mode, setMode] = useState<Mode>(consultMode ? 'suggest' : 'tag');
  const [selectedTagId, setSelectedTagId] = useState<number | null>(
    availableTags[0]?.id ?? null,
  );
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [suggestText, setSuggestText] = useState('');
  const [suggestMode, setSuggestMode] = useState<'replace' | 'insert-after'>('replace');
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(
    noteCategories[0]?.id ?? null,
  );
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState<number[]>([]);

  // Session tags whose open/close range encloses the current selection.
  // A still-open session (close_position null) is included if the selection
  // starts after its open position — it conceptually extends to "now".
  const sessionsForSelection = selectSessionTags(tagStore).filter(t =>
    t.open_position != null
    && t.open_position <= selection.start
    && (t.close_position == null || t.close_position >= selection.end),
  );
  const [error, setError] = useState<string | null>(null);

  if (!currentText) return null;

  const newTagValid = sessionMode
    ? SESSION_TAG_NAME_RE.test(newTagName.trim())
    : newTagName.trim().length > 0;

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTagId) return;
    setError(null);
    try {
      await createSpan(currentText.id, selectedTagId, selection.start, selection.end,
        { startSylId: selection.startSylId, endSylId: selection.endSylId });
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCreateTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newTagName.trim();
    if (sessionMode && !SESSION_TAG_NAME_RE.test(trimmed)) {
      setError('Session tag names must look like A1, B2, K12');
      return;
    }
    if (!trimmed) return;
    setError(null);
    try {
      const color = sessionMode
        ? colorForSessionTag(trimmed)
        : COLORS[tagStore.tags.length % COLORS.length];
      const kind = sessionMode ? 'session' : 'regular';
      const newTag = await createTag(currentText.id, trimmed, color, kind);
      setSelectedTagId(newTag.id);
      setIsCreatingTag(false);
      setNewTagName('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSuggest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (suggestMode === 'insert-after' && !suggestText) {
      setError('Insertion text cannot be empty');
      return;
    }
    setError(null);
    // A secondary's edits are derivation ops over its parent chain (not suggestions):
    // edit-range aligns the new text against the selected run. Insert-after = the
    // selection's own text with the insertion appended (alignment keeps the run).
    if (currentText.text_type === 'secondary') {
      try {
        const selected = currentText.raw_text.substring(selection.start, selection.end);
        const newText = suggestMode === 'insert-after' ? selected + suggestText : suggestText;
        await editRange(currentText.id, {
          start_syl_id: selection.startSylId, end_syl_id: selection.endSylId, new_text: newText,
        });
        await loadText(currentText.id);  // full refresh — the composed text changed
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
      return;
    }
    const start = suggestMode === 'insert-after' ? selection.end : selection.start;
    try {
      // A replacement covers the whole selection → anchor by syllable ids (Part 6).
      // An insertion (insert-after) stays on the offset path for now.
      const sylIds = suggestMode === 'insert-after'
        ? undefined
        : { startSylId: selection.startSylId, endSylId: selection.endSylId };
      await createSuggestion(currentText.id, start, selection.end, suggestText, sylIds);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Transclude a whole other text AFTER the selection: a range LINK (no copy), so
  // corrections baked into the source ripple in. Undone from the Edits panel.
  const handleTransclude = async (srcTextId: number) => {
    setError(null);
    try {
      const { anchorId, anchorOpId } = anchorAfterSelection();
      await transclude(currentText.id, {
        anchor_syl_id: anchorId, src_text_id: srcTextId, anchor_op_id: anchorOpId,
      });
      await loadText(currentText.id);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Could not insert the text');
    }
  };

  // The explicit, sporadic upstream path: route this correction to the text where the
  // selected syllables first appear (their owner), as a pending suggestion reviewed
  // there. Confirmation popup guards against accidental upstream submissions.
  const handleSuggestUpstream = async () => {
    setError(null);
    if (suggestMode === 'insert-after' && !suggestText) {
      setError('Insertion text cannot be empty');
      return;
    }
    if (!confirm(
      'Send this correction upstream, for review in the text this content comes from?\n\n'
      + 'Nothing changes until it is accepted there — then it ripples back here.',
    )) return;
    try {
      let body: { start_syl_id: string; end_syl_id: string | null; suggested_text: string };
      if (suggestMode === 'insert-after') {
        // A zero-width insertion is anchored BEFORE the token after the selection.
        const tokens = useEditorTokenStore.getState().tokens;
        const i = tokens.findIndex(t => t.id === selection.endSylId);
        const before = i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : null;
        if (!before) {
          setError('Cannot suggest an insertion at the very end of the text');
          return;
        }
        body = { start_syl_id: before.id, end_syl_id: null, suggested_text: suggestText };
      } else {
        body = {
          start_syl_id: selection.startSylId, end_syl_id: selection.endSylId,
          suggested_text: suggestText,
        };
      }
      const res = await suggestUpstream(currentText.id, body);
      onClose();
      alert(`Sent for review in “${res.routed_to_title}”.`);
    } catch (e: any) {
      setError(e.message || 'Could not send the suggestion upstream');
    }
  };

  const handleCreateNoteCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const cat = await createCategory(currentText.id, trimmed);
      setSelectedCategoryId(cat.id);
      setIsCreatingCategory(false);
      setNewCategoryName('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await createNote(
        currentText.id,
        selectedCategoryId,
        selection.start,
        selection.end,
        noteBody,
        selectedSessionIds,
        selection.passageId ?? null,  // per-occurrence: only inside this passage run
      );
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleSelectedSession = (id: number) => {
    setSelectedSessionIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  const handleSplit = async () => {
    setError(null);
    if (selection.passageId != null) {
      // Selection inside a passage run: the host card supplied the dispatch (it knows
      // the anchor context) — passages split exactly like ordinary text.
      if (!passageSplit?.canSplit) return;
      try {
        await passageSplit.onSplit();
      } catch (e: any) {
        setError(e.message || 'Could not split here');
        return;
      }
      onClose();
      return;
    }
    if (selection.end >= segment.end && trailingPassages.length > 0) {
      // Boundary case: the selection reaches the end of the host text and inline
      // passages trail it. A split is ONE boundary: the first trailing passage starts
      // the new segment and the rest flow into it (a marker here would be meaningless
      // — the boundary already exists; passages have zero host width).
      await editPassage(trailingPassages[0].id, { own_segment: true });
      onClose();
      return;
    }
    // Marker goes at selection.end — already snapped to a unit boundary by
    // SegmentCard. New "before" segment will be [segment.start, selection.end].
    const marker = await createMarker(currentText.id, selection.end);
    if (!marker) {
      setError('Could not place a separator at this position (duplicate, or inside a tagged span).');
      return;
    }
    onClose();
  };

  // Reversibly hide the selected range: a delete-suggestion (empty replacement). Raw text
  // and syllables are untouched; the Suggestions sidebar lists it for undo.
  const handleDeleteSection = async () => {
    setError(null);
    try {
      if (currentText.text_type === 'secondary') {
        // A secondary's deletion is a derivation op (edit the run to nothing).
        await editRange(currentText.id, {
          start_syl_id: selection.startSylId, end_syl_id: selection.endSylId, new_text: '',
        });
        await loadText(currentText.id);
      } else {
        // Anchor the delete-suggestion by syllable ids (Part 6): deleting the full last
        // segment must not be rejected by the units_json boundary check.
        await createSuggestion(currentText.id, selection.start, selection.end, '',
          { startSylId: selection.startSylId, endSylId: selection.endSylId });
      }
    } catch (e: any) {
      // Surface the reason (e.g. "Overlaps with an existing suggestion") instead of
      // silently doing nothing — the popover renders `error` below.
      setError(e.message || 'Could not delete this section');
      return;
    }
    onClose();
  };

  // The composed token AFTER the selection — the anchor for insert-type ops. The
  // OCCURRENCE matters: the same source transcluded twice repeats the same uuids, so
  // match by offset first (falling back to id-only) and carry the emitting op's id.
  const anchorAfterSelection = () => {
    const tokens = useEditorTokenStore.getState().tokens;
    let i = tokens.findIndex(t => t.id === selection.endSylId && t.end_offset === selection.end);
    if (i < 0) i = tokens.findIndex(t => t.id === selection.endSylId);
    const anchor = i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : null;
    return { anchorId: anchor?.id ?? null, anchorOpId: anchor?.op_id };
  };

  // Extract the selection into a new independent primary text (and reversibly remove it
  // from this text). Addressed by syllable uuid — never offsets.
  const handleExtract = async () => {
    setError(null);
    try {
      await extractSelection(currentText.id, selection.startSylId, selection.endSylId);
    } catch (e: any) {
      setError(e.message || 'Extract failed');
      return;
    }
    onClose();
  };

  // Arm "place a passage": the next downstream syllable click in the tagger links this
  // selection there. Placement + validation happen in SegmentCard / on the backend.
  const handleLinkPassage = () => {
    setError(null);
    setPendingPassageSource({
      startSylId: selection.startSylId,
      endSylId: selection.endSylId,
      endOffset: selection.end,
    });
    onClose();
  };

  // Splitting is allowed any time the user picks an internal offset (segments
  // no longer have a tagged/untagged distinction). Selections inside a PASSAGE run
  // can't split: their offsets point at the SOURCE occurrence, so a marker would land
  // at the source location, not here.
  const canSplit = selection.passageId != null
    ? (passageSplit?.canSplit ?? false)
    : selection.end > segment.start &&
      (selection.end < segment.end ||
        // Boundary case: selection ends AT segment.end with inline passages trailing —
        // Split starts a new segment with them (see handleSplit).
        (selection.end === segment.end && trailingPassages.length > 0));

  // Position the popover near the selection rect, clipped to viewport.
  const PW = 320;
  const PH = 340;  // taller now that the toolbar wraps to a few rows
  const left = Math.max(8, Math.min(window.innerWidth - PW - 8, selection.rect.left + selection.rect.width / 2 - PW / 2));
  const top = selection.rect.bottom + 8 + PH > window.innerHeight
    ? Math.max(8, selection.rect.top - PH - 8)
    : selection.rect.bottom + 8;

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 bg-cream-hi shadow-2xl rounded-xl flex flex-col"
        style={{ top, left, width: PW, border: '1px solid var(--cline)' }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-1 px-3 py-2"
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          {/* Toolbar wraps within the popover width so buttons never overflow past the
              right edge (and the close X stays visible). */}
          <div className="flex flex-wrap gap-1 flex-1 min-w-0 [&_button]:whitespace-nowrap">
            {!consultMode && (
              <button
                onClick={() => setMode('tag')}
                className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                  mode === 'tag'
                    ? (sessionMode
                        ? 'bg-vermilion/10 text-vermilion-deep'
                        : 'bg-lapis/10 text-lapis')
                    : 'text-ink-soft hover:bg-cream'
                }`}
              >
                {sessionMode ? <Mic size={12} /> : <TagIcon size={12} />}
                {sessionMode ? 'Session' : 'Tag'}
              </button>
            )}
            {!sessionMode && (
              <button
                onClick={() => setMode('suggest')}
                className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                  mode === 'suggest'
                    ? 'bg-gold/15 text-amber-robe'
                    : 'text-ink-soft hover:bg-cream'
                }`}
              >
                <Edit3 size={12} /> Suggest edit
              </button>
            )}
            {!sessionMode && (
              <button
                onClick={() => setMode('note')}
                className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                  mode === 'note'
                    ? 'bg-jade/15 text-jade'
                    : 'text-ink-soft hover:bg-cream'
                }`}
              >
                <StickyNote size={12} /> Note
              </button>
            )}
            {!sessionMode && !consultMode && canSplit && (
              <button
                onClick={handleSplit}
                className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-amber-100 hover:text-amber-700 dark:hover:bg-amber-900/40 dark:hover:text-amber-300"
                title={`Insert a separator at offset ${selection.end} — splits this segment into [${segment.start}, ${selection.end}] · [${selection.end}, ${segment.end}]`}
              >
                <Scissors size={12} /> Split here
              </button>
            )}
            {/* Display-only line break AFTER the selection's last syllable. Persisted
                as a display_breaks override; editable via its ↵ icon in ¶ mode. */}
            {!sessionMode && (
              <>
                <button
                  onClick={() => addDisplayBreak(1)}
                  className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-cream hover:text-lapis"
                  title="Add a display-only line break after the selection (turns ¶ mode on)"
                >
                  ↵ line
                </button>
                <button
                  onClick={() => addDisplayBreak(2)}
                  className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-cream hover:text-lapis"
                  title="Add a display-only empty line after the selection (turns ¶ mode on)"
                >
                  ↵ empty line
                </button>
              </>
            )}
            {!sessionMode && !consultMode && (
              <button
                onClick={handleDeleteSection}
                className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                title={currentText.text_type === 'secondary'
                  ? 'Remove this range from the derived text (an edit op you can undo from the Edits panel)'
                  : 'Reversibly hide this range (a delete-suggestion you can undo from the Suggestions panel). Bake it in later with Duplicate.'}
              >
                <Trash2 size={12} /> Delete section
              </button>
            )}
            {!sessionMode && !consultMode && currentText.text_type === 'secondary' && (
              <>
                <button
                  onClick={() => { setError(null); setMode('insert-text'); }}
                  className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                    mode === 'insert-text'
                      ? 'bg-lapis/10 text-lapis'
                      : 'text-slate-500 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:text-blue-300'
                  }`}
                  title="Insert another text after the selection as a live link — corrections made there ripple in (undo from the Edits panel)"
                >
                  <BookPlus size={12} /> Insert text…
                </button>
              </>
            )}
            {!sessionMode && !consultMode && currentText.text_type === 'primary' && (
              <button
                onClick={handleExtract}
                className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-teal-100 hover:text-teal-700 dark:hover:bg-teal-900/40 dark:hover:text-teal-300"
                title="Extract this selection into a new primary text (and reversibly remove it here)"
              >
                <FileOutput size={12} /> Extract as text
              </button>
            )}
            {!sessionMode && !consultMode && (
              <button
                onClick={handleLinkPassage}
                className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                title="Link this selection as a passage — then click the downstream syllable AFTER which it should appear"
              >
                <Link2 size={12} /> Link as passage…
              </button>
            )}
          </div>
          <button onClick={onClose} className="p-1 shrink-0 text-slate-400 hover:text-slate-700">
            <X size={14} />
          </button>
        </div>

        <div className="px-3 py-2 text-[11px] text-bronze font-mono">
          Selection {selection.start}–{selection.end}
        </div>

        {error && (
          <div
            className="mx-3 mb-2 text-xs text-vermilion-deep rounded px-2 py-1"
            style={{ background: 'rgba(194,41,32,0.08)', border: '1px solid rgba(194,41,32,0.20)' }}
          >{error}</div>
        )}

        {/* TAG MODE */}
        {mode === 'tag' && !isCreatingTag && (
          <form onSubmit={handleApply} className="px-3 pb-3 flex flex-col gap-2">
            <select
              value={selectedTagId ?? ''}
              onChange={(e) => setSelectedTagId(e.target.value ? Number(e.target.value) : null)}
              className="w-full text-sm rounded bg-white py-1.5 px-2"
              style={{ border: '1px solid var(--cline)' }}
            >
              {availableTags.length === 0 ? (
                <option value="" disabled>No {sessionMode ? 'session ' : ''}tags yet — create one below</option>
              ) : (
                availableTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)
              )}
            </select>

            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!selectedTagId}
                className="flex-1 text-xs px-2 py-1.5 bg-vermilion hover:bg-vermilion-deep text-cream-hi rounded disabled:opacity-50"
              >
                Apply
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsCreatingTag(true)}
              className="text-xs text-vermilion hover:underline mt-1 text-left"
            >
              + New tag…
            </button>
          </form>
        )}

        {mode === 'tag' && isCreatingTag && (
          <form onSubmit={handleCreateTag} className="px-3 pb-3 flex flex-col gap-2">
            <input
              type="text"
              autoFocus
              placeholder={sessionMode ? 'A1, B2, K12…' : 'Tag name…'}
              value={newTagName}
              onChange={(e) => setNewTagName(sessionMode ? e.target.value.toUpperCase() : e.target.value)}
              className="w-full text-sm rounded bg-white py-1.5 px-2"
              style={{ border: '1px solid var(--cline)' }}
            />
            {sessionMode && (
              <p className="text-[10px] text-ink-soft">
                Letter + number. Letter chooses hue, number cycles through 4 shades.
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setIsCreatingTag(false)} className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand">
                Back
              </button>
              <button type="submit" disabled={!newTagValid} className="flex-1 text-xs px-2 py-1.5 bg-vermilion hover:bg-vermilion-deep text-cream-hi rounded disabled:opacity-50">
                Create
              </button>
            </div>
          </form>
        )}

        {/* SUGGEST MODE */}
        {mode === 'suggest' && (
          <form onSubmit={handleSuggest} className="px-3 pb-3 flex flex-col gap-2">
            <div className="flex gap-3 text-[11px] text-ink-soft">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="suggest-mode"
                  checked={suggestMode === 'replace'}
                  onChange={() => setSuggestMode('replace')}
                />
                Replace selection
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="suggest-mode"
                  checked={suggestMode === 'insert-after'}
                  onChange={() => setSuggestMode('insert-after')}
                />
                Insert after selection
              </label>
            </div>
            <div className="text-[11px] text-ink-soft">
              {suggestMode === 'replace'
                ? 'Replace selected text with:'
                : 'Insert this text at the end of the selection:'}
            </div>
            <textarea
              autoFocus
              placeholder={
                suggestMode === 'replace'
                  ? '(leave empty to suggest deletion)'
                  : 'Text to insert…'
              }
              value={suggestText}
              onChange={(e) => setSuggestText(e.target.value)}
              className="w-full text-sm rounded bg-white py-1.5 px-2 min-h-[60px] tibetan-text-sm"
              style={{ border: '1px solid var(--cline)' }}
            />
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand">
                Cancel
              </button>
              <button
                type="submit"
                disabled={suggestMode === 'insert-after' && !suggestText}
                className="flex-1 text-xs px-2 py-1.5 bg-amber-robe hover:bg-vermilion text-cream-hi rounded disabled:opacity-50"
              >
                Save suggestion
              </button>
            </div>
            {currentText.text_type === 'secondary' && (
              <button
                type="button"
                onClick={handleSuggestUpstream}
                disabled={suggestMode === 'insert-after' && !suggestText}
                className="text-xs px-2 py-1.5 rounded bg-lapis/10 text-lapis hover:bg-lapis hover:text-cream-hi transition-colors disabled:opacity-50"
                style={{ border: '1px solid var(--cline)' }}
                title="Send this correction for review in the text this content comes from — it only takes effect there once accepted, then ripples back here"
              >
                Suggest upstream…
              </button>
            )}
          </form>
        )}

        {/* NOTE MODE */}
        {mode === 'note' && !isCreatingCategory && (
          <form onSubmit={handleSaveNote} className="px-3 pb-3 flex flex-col gap-2">
            <select
              value={selectedCategoryId ?? ''}
              onChange={(e) => setSelectedCategoryId(e.target.value ? Number(e.target.value) : null)}
              className="w-full text-sm rounded bg-white py-1.5 px-2"
              style={{ border: '1px solid var(--cline)' }}
            >
              <option value="">— Uncategorized —</option>
              {noteCategories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <textarea
              autoFocus
              placeholder="Write a note about this passage…"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              className="w-full text-sm rounded bg-white py-1.5 px-2 min-h-[80px] tibetan-text-sm"
              style={{ border: '1px solid var(--cline)' }}
            />

            {/* Link to teaching sessions covering this selection. */}
            <div className={sessionsForSelection.length === 0 ? 'opacity-50 pointer-events-none' : ''}>
              <div className="text-[11px] text-ink-soft mb-1">
                {sessionsForSelection.length === 0
                  ? 'Link to session — none cover this selection'
                  : 'Link to session(s):'}
              </div>
              {sessionsForSelection.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {sessionsForSelection.map(t => {
                    const checked = selectedSessionIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleSelectedSession(t.id)}
                        className={`text-[11px] px-1.5 py-0.5 rounded flex items-center gap-1 ${
                          checked
                            ? 'text-cream-hi'
                            : 'text-ink-soft hover:bg-cream'
                        }`}
                        style={checked
                          ? { backgroundColor: t.color, border: '1px solid var(--gline)' }
                          : { border: '1px solid var(--cline)' }}
                        title={t.close_position == null ? `${t.name} (still open)` : `${t.name} (${t.open_position}–${t.close_position})`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand">
                Cancel
              </button>
              <button type="submit" className="flex-1 text-xs px-2 py-1.5 bg-jade hover:bg-[#5a8f5f] text-cream-hi rounded">
                Save note
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsCreatingCategory(true)}
              className="text-xs text-jade hover:underline mt-1 text-left"
            >
              + New category…
            </button>
          </form>
        )}

        {mode === 'note' && isCreatingCategory && (
          <form onSubmit={handleCreateNoteCategory} className="px-3 pb-3 flex flex-col gap-2">
            <input
              type="text"
              autoFocus
              placeholder="Category name (e.g. location)"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              className="w-full text-sm rounded bg-white py-1.5 px-2"
              style={{ border: '1px solid var(--cline)' }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setIsCreatingCategory(false); setNewCategoryName(''); }}
                className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!newCategoryName.trim()}
                className="flex-1 text-xs px-2 py-1.5 bg-jade hover:bg-[#5a8f5f] text-cream-hi rounded disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </form>
        )}

        {/* INSERT TEXT MODE (secondary only): pick another text to transclude AFTER the
            selection — a live range LINK, so corrections in the source ripple in. */}
        {mode === 'insert-text' && (
          <div className="px-3 pb-3 flex flex-col gap-2">
            <div className="text-[11px] text-ink-soft">
              Insert a whole text after the selection (a live link — corrections made in
              it ripple here; undo from the Edits panel):
            </div>
            {texts.filter(t => t.id !== currentText.id).length === 0 ? (
              <p className="text-xs text-ink-soft italic">No other texts available.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 max-h-56 overflow-y-auto rounded"
                  style={{ border: '1px solid var(--cline)' }}>
                {texts.filter(t => t.id !== currentText.id).map(t => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => handleTransclude(t.id)}
                      className="w-full text-left text-xs px-2 py-1.5 hover:bg-cream flex items-center gap-2 min-w-0"
                      title={t.title}
                    >
                      <FileText size={12} className="text-bronze shrink-0" />
                      <span className="tibetan-text-sm text-ink truncate min-w-0" style={{ fontSize: '13px' }}>
                        {t.title}
                      </span>
                      <span className={
                        'text-[9px] uppercase tracking-wide px-1 py-px rounded font-mono shrink-0 ml-auto ' +
                        (t.text_type === 'secondary' ? 'bg-lapis/10 text-lapis' : 'bg-bronze/10 text-bronze')
                      }>
                        {t.text_type}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Consult-mode escape hatch: copy the selected text and close. The
            mode-specific forms above are still the primary action — this is
            only here for the read-only "I just want to grab this passage"
            workflow. */}
        {consultMode && (
          <div className="px-3 py-2" style={{ borderTop: '1px solid var(--cline)' }}>
            <button
              type="button"
              onClick={async () => {
                const text = currentText.raw_text.substring(selection.start, selection.end);
                try { await navigator.clipboard.writeText(text); }
                catch { /* clipboard denied — silently fall through to close */ }
                onClose();
              }}
              className="w-full text-xs px-2 py-1.5 bg-cream hover:bg-sand text-ink rounded flex items-center justify-center gap-1.5"
              title="Copy the selected text to the clipboard"
            >
              <Copy size={12} /> Copy selection
            </button>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
};
