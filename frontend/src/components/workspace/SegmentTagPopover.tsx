import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Segment } from './segments';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore, selectRegularTags, selectSessionTags } from '../../store/useTagStore';
import { useUIStore } from '../../store/useUIStore';
import { useSuggestionStore } from '../../store/useSuggestionStore';
import { useNoteStore } from '../../store/useNoteStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { editRange, insertBreak, suggestUpstream } from '../../api/client';
import { colorForSessionTag, SESSION_TAG_NAME_RE } from '../../lib/sessionTagColor';
import { Tag as TagIcon, Edit3, Scissors, X, Mic, StickyNote, Copy, Trash2, Link2, FileOutput, CornerDownLeft } from 'lucide-react';

const COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#22c55e', '#06b6d4', '#3b82f6', '#6366f1',
  '#8b5cf6', '#d946ef', '#f43f5e', '#64748b',
];

interface Props {
  segment: Segment;
  selection: { start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect };
  onClose: () => void;
}

type Mode = 'tag' | 'suggest' | 'note';

export const SegmentTagPopover: React.FC<Props> = ({ segment, selection, onClose }) => {
  const { currentText, extractSelection, loadText } = useTextStore();
  const tagStore = useTagStore();
  const { createTag, createSpan } = tagStore;
  const { createSuggestion } = useSuggestionStore();
  const { categories: noteCategories, createCategory, createNote } = useNoteStore();
  const createMarker = useMarkerStore(s => s.createMarker);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const setPendingPassageSource = useUIStore(s => s.setPendingPassageSource);

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

  // Manual line break AFTER the selection: a hosted "\n" op inserted before the next
  // composed token (or at the end of the text). Secondary-only formatting.
  const handleInsertBreak = async () => {
    setError(null);
    try {
      const tokens = useEditorTokenStore.getState().tokens;
      const i = tokens.findIndex(t => t.id === selection.endSylId);
      const before = i >= 0 && i + 1 < tokens.length ? tokens[i + 1].id : null;
      await insertBreak(currentText.id, before);
      await loadText(currentText.id);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Could not insert a line break');
    }
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
  // no longer have a tagged/untagged distinction).
  const canSplit =
    selection.end > segment.start &&
    selection.end < segment.end;

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
              <button
                onClick={handleInsertBreak}
                className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-indigo-100 hover:text-indigo-700 dark:hover:bg-indigo-900/40 dark:hover:text-indigo-300"
                title="Insert a line break after the selection (undo from the Edits panel)"
              >
                <CornerDownLeft size={12} /> Line break
              </button>
            )}
            {!sessionMode && !consultMode && currentText.text_type === 'primary' && (
              <>
                <button
                  onClick={handleExtract}
                  className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-teal-100 hover:text-teal-700 dark:hover:bg-teal-900/40 dark:hover:text-teal-300"
                  title="Extract this selection into a new primary text (and reversibly remove it here)"
                >
                  <FileOutput size={12} /> Extract as text
                </button>
                <button
                  onClick={handleLinkPassage}
                  className="text-xs px-2 py-1 rounded flex items-center gap-1 text-slate-500 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                  title="Link this selection as a passage — then click a syllable downstream to place it"
                >
                  <Link2 size={12} /> Link as passage…
                </button>
              </>
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
