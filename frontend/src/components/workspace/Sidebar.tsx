import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { listDerivationOps, deleteDerivationOp, applyCorrections, acceptSuggestion, type DerivationOp } from '../../api/client';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTagStore, type Tag, selectRegularTags, selectSessionTags } from '../../store/useTagStore';
import { useNoteStore, type Note } from '../../store/useNoteStore';
import { useSuggestionStore, type Suggestion } from '../../store/useSuggestionStore';
import { useUIStore } from '../../store/useUIStore';
import { useTextStore } from '../../store/useTextStore';
import { colorForSessionTag, SESSION_TAG_NAME_RE } from '../../lib/sessionTagColor';
import { ChevronRight, ChevronLeft, ChevronUp, ChevronDown, Tag as TagIcon, Layers, Plus, X, Pencil, Mic, StickyNote, Check, MessageSquare, Trash2, Globe, Lock, Link2, CornerUpLeft, Scissors } from 'lucide-react';
import { usePassageStore } from '../../store/usePassageStore';
import { scrollTaggerToOffset, scrollTaggerToSyllable } from './scrollTaggerToOffset';

const REGULAR_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#22c55e', '#06b6d4', '#2A4A9A', '#6366f1',
  '#8b5cf6', '#d946ef', '#f43f5e', '#64748b',
];

const TagRow: React.FC<{ tag: Tag; dimmed?: boolean }> = ({ tag, dimmed }) => {
  const { updateTag, deleteTag, setTagShared, spans } = useTagStore();
  const currentText = useTextStore(s => s.currentText);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  const [error, setError] = useState<string | null>(null);

  /** Jump the tagger to the first usage of this tag. */
  const scrollToFirstUsage = () => {
    let target: number | null = null;
    if (tag.tag_kind === 'session') {
      target = tag.open_position;
    } else {
      const mine = spans.filter(s => s.tag_id === tag.id);
      if (mine.length > 0) target = Math.min(...mine.map(s => s.start_offset));
    }
    if (target == null) return;
    scrollTaggerToOffset(target);
  };

  const submit = async () => {
    const next = draft.trim();
    if (!next || next === tag.name) {
      setIsEditing(false);
      return;
    }
    // Session tags must keep the letter+number format AND get their color recomputed.
    if (tag.tag_kind === 'session') {
      if (!SESSION_TAG_NAME_RE.test(next)) {
        setError('Session tag names must look like A1, B2, K12');
        return;
      }
      const color = colorForSessionTag(next);
      try { await updateTag(tag.id, { name: next, color }); }
      catch (e: any) { setError(e.message); return; }
    } else {
      try { await updateTag(tag.id, { name: next }); }
      catch (e: any) { setError(e.message); return; }
    }
    setError(null);
    setIsEditing(false);
  };

  const cancel = () => {
    setDraft(tag.name);
    setError(null);
    setIsEditing(false);
  };

  return (
    <li className={`flex items-center justify-between gap-2 group py-0.5 px-1 rounded hover:bg-cream ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
        {isEditing ? (
          <div className="flex-1 min-w-0">
            <input
              type="text"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
              }}
              onBlur={cancel}
              className="text-sm w-full min-w-0 bg-white border border-gold rounded px-1 py-0"
            />
            {error && <p className="text-[10px] text-red-600 mt-0.5">{error}</p>}
          </div>
        ) : (
          <button
            type="button"
            onClick={scrollToFirstUsage}
            className="text-sm truncate text-left hover:underline decoration-dotted"
            title="Scroll the tagger to the first usage of this tag"
          >
            {tag.name}
          </button>
        )}
      </div>
      {/* Part 8: shared/private toggle (regular tags only). Globe stays visible so the
          shared state is glanceable; the private Lock reveals on hover. */}
      {!isEditing && tag.tag_kind === 'regular' && !consultMode && currentText && (
        <button
          type="button"
          onClick={() => setTagShared(tag.id, !tag.is_shared, currentText.id)}
          className={`shrink-0 p-0.5 transition-colors ${
            tag.is_shared
              ? 'text-vermilion hover:text-vermilion-deep'
              : 'text-bronze opacity-0 group-hover:opacity-100 hover:text-vermilion'
          }`}
          title={tag.is_shared
            ? 'Shared across all texts — click to make private to this document'
            : 'Private to this document — click to share across all texts'}
        >
          {tag.is_shared ? <Globe size={12} /> : <Lock size={12} />}
        </button>
      )}
      {!isEditing && !dimmed && !consultMode && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            onClick={() => { setDraft(tag.name); setError(null); setIsEditing(true); }}
            className="text-bronze hover:text-vermilion p-0.5"
            title="Rename tag"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() => {
              const extra = tag.is_shared
                ? ' This tag is shared — it will be removed from every text.'
                : '';
              if (confirm(`Delete tag "${tag.name}"? Any annotations using it will also be removed.${extra}`)) {
                deleteTag(tag.id);
              }
            }}
            className="text-bronze hover:text-vermilion-deep p-0.5"
            title="Delete tag"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </li>
  );
};

interface CreateRegularFormProps {
  textId: number;
  takenColors: string[];
  onClose: () => void;
}
const CreateRegularForm: React.FC<CreateRegularFormProps> = ({ textId, takenColors, onClose }) => {
  const { createTag } = useTagStore();
  const [name, setName] = useState('');
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const color = REGULAR_COLORS[takenColors.length % REGULAR_COLORS.length];
    try {
      await createTag(textId, name.trim(), color, 'regular');
      onClose();
    } catch (err: any) { alert(err.message); }
  };
  return (
    <form
      onSubmit={handleSubmit}
      className="mb-3 flex flex-col gap-2 p-2 bg-cream rounded"
      style={{ border: '1px solid var(--cline)' }}
    >
      <input
        type="text"
        autoFocus
        placeholder="Tag name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="text-sm rounded bg-white py-1 px-2"
        style={{ border: '1px solid var(--cline)' }}
      />
      <div className="flex gap-1.5 justify-end">
        <button type="button" onClick={onClose} className="text-xs px-2 py-0.5 text-ink-soft hover:bg-sand rounded">Cancel</button>
        <button type="submit" disabled={!name.trim()} className="text-xs px-2 py-0.5 bg-vermilion hover:bg-vermilion-deep text-cream-hi rounded disabled:opacity-50">Save</button>
      </div>
    </form>
  );
};

interface CreateSessionFormProps {
  textId: number;
  onClose: () => void;
}
const CreateSessionForm: React.FC<CreateSessionFormProps> = ({ textId, onClose }) => {
  const { createTag } = useTagStore();
  const [name, setName] = useState('');
  const valid = SESSION_TAG_NAME_RE.test(name.trim());
  const previewColor = valid ? colorForSessionTag(name.trim()) : '#94a3b8';
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!SESSION_TAG_NAME_RE.test(trimmed)) return;
    try {
      await createTag(textId, trimmed, colorForSessionTag(trimmed), 'session');
      onClose();
    } catch (err: any) { alert(err.message); }
  };
  return (
    <form
      onSubmit={handleSubmit}
      className="mb-3 flex flex-col gap-2 p-2 bg-cream rounded"
      style={{ border: '1px solid var(--cline)' }}
    >
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full shrink-0 transition-colors" style={{ backgroundColor: previewColor }} />
        <input
          type="text"
          autoFocus
          placeholder="A1, B2, K12…"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          className="text-sm flex-1 rounded bg-white py-1 px-2"
          style={{ border: '1px solid var(--cline)' }}
        />
      </div>
      <p className="text-[10px] text-ink-soft">
        Format: one letter + number (e.g. A1, B2). Letter chooses hue, number picks shade (cycles every 4).
      </p>
      <div className="flex gap-1.5 justify-end">
        <button type="button" onClick={onClose} className="text-xs px-2 py-0.5 text-ink-soft hover:bg-sand rounded">Cancel</button>
        <button type="submit" disabled={!valid} className="text-xs px-2 py-0.5 bg-vermilion hover:bg-vermilion-deep text-cream-hi rounded disabled:opacity-50">Save</button>
      </div>
    </form>
  );
};

interface SuggestionRowProps {
  s: Suggestion;
  rawText: string;
  onDelete: () => void;
}
const SuggestionRow: React.FC<SuggestionRowProps> = ({ s, rawText, onDelete }) => {
  const texts = useTextStore(st => st.texts);
  const loadText = useTextStore(st => st.loadText);
  const original = rawText.substring(s.start_offset, s.end_offset);
  const isInsertion = s.start_offset === s.end_offset;
  const isExtraction = s.extracted_text_id != null;
  const isDeletion = !isInsertion && s.suggested_text.length === 0;
  const kind = isInsertion ? 'insertion' : isExtraction ? 'extraction' : isDeletion ? 'deletion' : 'replacement';
  const target = isExtraction ? texts.find(d => d.id === s.extracted_text_id) : undefined;
  // Prefer the syllable-native jump (matches how the suggestion is anchored); fall back
  // to the offset scan (which also pulses the segment) if the id can't be resolved.
  const jump = () => {
    if (!s.start_syl_id || !scrollTaggerToSyllable(s.start_syl_id)) scrollTaggerToOffset(s.start_offset);
  };

  return (
    <li className="rounded group" style={{ border: '1px solid var(--cline)' }}>
      <button
        type="button"
        onClick={jump}
        className="block w-full text-left p-1.5 hover:bg-cream rounded-t"
        title="Scroll to this position in the text"
      >
        <div className="flex items-center gap-1 mb-0.5 flex-wrap">
          <span className={`text-[9px] uppercase ${isExtraction ? 'text-teal-700 dark:text-teal-300' : 'text-bronze'}`}>{kind}</span>
          <span className="text-[9px] text-bronze font-mono">{s.start_offset}–{s.end_offset}</span>
          {isExtraction && (
            <span
              onClick={(e) => { e.stopPropagation(); if (s.extracted_text_id != null) loadText(s.extracted_text_id); }}
              className="text-[9px] text-teal-700 dark:text-teal-300 hover:underline cursor-pointer truncate max-w-[10rem]"
              title="Open the extracted text"
            >→ {target ? target.title : 'extracted text'}</span>
          )}
        </div>
        <p className="tibetan-text-sm text-xs text-ink break-words line-clamp-2">
          {original.length > 0 && (
            <span className="line-through text-rose-600">{original}</span>
          )}
          {original.length > 0 && s.suggested_text.length > 0 && ' → '}
          {s.suggested_text.length > 0 && (
            <span className="text-emerald-700 font-medium">{s.suggested_text}</span>
          )}
        </p>
      </button>
      <div className="flex gap-0.5 px-1.5 pb-1 justify-end opacity-0 group-hover:opacity-100">
        <button onClick={onDelete} title="Delete correction" className="text-bronze hover:text-vermilion-deep p-0.5 rounded">
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
};

interface NoteRowProps {
  note: Note;
  snippet: string;
}
const NoteRow: React.FC<NoteRowProps> = ({ note, snippet }) => {
  const { updateNote, deleteNote, categories } = useNoteStore();
  const tagStore = useTagStore();
  const [isEditing, setIsEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(note.body);
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(note.category_id);
  const [draftSessionIds, setDraftSessionIds] = useState<number[]>(note.session_tag_ids);

  // Sessions whose extent currently covers this note's range, plus any
  // already-linked sessions even if no longer covering (so the user can
  // unlink them). Deduped by id.
  const candidateSessions = useMemo(() => {
    const covering = selectSessionTags(tagStore).filter(t =>
      t.open_position != null
      && t.open_position <= note.start_offset
      && (t.close_position == null || t.close_position >= note.end_offset),
    );
    const ids = new Set(covering.map(t => t.id));
    const extraLinked = tagStore.tags.filter(t =>
      note.session_tag_ids.includes(t.id) && !ids.has(t.id),
    );
    return [...covering, ...extraLinked];
  }, [tagStore.tags, note.start_offset, note.end_offset, note.session_tag_ids]);

  const submit = async () => {
    try {
      await updateNote(note.id, {
        body: draftBody,
        category_id: draftCategoryId,
        session_tag_ids: draftSessionIds,
      });
      setIsEditing(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const cancel = () => {
    setDraftBody(note.body);
    setDraftCategoryId(note.category_id);
    setDraftSessionIds(note.session_tag_ids);
    setIsEditing(false);
  };

  const toggleDraftSession = (id: number) => {
    setDraftSessionIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  return (
    <li className="py-1 px-1.5 rounded hover:bg-cream group">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => {
            // A per-occurrence note lives inside a passage run — jump to the passage's
            // placement (its anchor), not to the source occurrence of the syllables.
            if (note.passage_id != null) {
              const pg = usePassageStore.getState().passages.find(x => x.id === note.passage_id);
              if (pg?.anchor_syl_id && scrollTaggerToSyllable(pg.anchor_syl_id)) return;
            }
            scrollTaggerToOffset(note.start_offset);
          }}
          className="flex-1 min-w-0 text-left"
          title={note.body || snippet}
        >
          <div className="text-[10px] text-bronze font-mono truncate">
            {note.category_name ? note.category_name : 'Uncategorized'} · {note.start_offset}–{note.end_offset}
            {note.passage_id != null && (
              <span className="ml-1 text-[9px] px-1 py-px rounded bg-lapis/10 text-lapis normal-case">in passage</span>
            )}
          </div>
          <div className="text-xs text-ink truncate tibetan-text-sm">
            {snippet}
          </div>
          {note.body && (
            <div className="text-[11px] text-ink-soft line-clamp-2 whitespace-pre-wrap">
              {note.body}
            </div>
          )}
          {note.session_tag_names.length > 0 && (
            <div className="flex flex-wrap gap-0.5 mt-0.5">
              {note.session_tag_names.map(name => (
                <span
                  key={name}
                  className="text-[9px] uppercase tracking-wider font-semibold px-1 py-px rounded bg-vermilion/10 text-vermilion-deep"
                  style={{ border: '1px solid rgba(194,41,32,0.22)' }}
                  title="Linked session"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </button>
        {!isEditing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
            <button
              onClick={() => setIsEditing(true)}
              className="text-bronze hover:text-jade p-0.5"
              title="Edit note"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => {
                if (confirm('Delete this note?')) deleteNote(note.id);
              }}
              className="text-bronze hover:text-vermilion-deep p-0.5"
              title="Delete note"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      {isEditing && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <select
            value={draftCategoryId ?? ''}
            onChange={(e) => setDraftCategoryId(e.target.value ? Number(e.target.value) : null)}
            className="text-xs rounded bg-white py-0.5 px-1"
            style={{ border: '1px solid var(--cline)' }}
          >
            <option value="">— Uncategorized —</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            className="text-xs rounded bg-white py-1 px-1.5 min-h-[50px] tibetan-text-sm"
            style={{ border: '1px solid var(--cline)' }}
          />
          <div className={candidateSessions.length === 0 ? 'opacity-50 pointer-events-none' : ''}>
            <div className="text-[10px] uppercase tracking-wider text-bronze mb-0.5">
              {candidateSessions.length === 0
                ? 'Sessions — none cover this range'
                : 'Sessions'}
            </div>
            {candidateSessions.length > 0 && (
              <div className="flex flex-wrap gap-0.5">
                {candidateSessions.map(t => {
                  const checked = draftSessionIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleDraftSession(t.id)}
                      className={`text-[10px] px-1 py-px rounded flex items-center gap-1 ${
                        checked
                          ? 'text-cream-hi'
                          : 'text-ink-soft hover:bg-cream'
                      }`}
                      style={checked
                        ? { backgroundColor: t.color, border: '1px solid var(--gline)' }
                        : { border: '1px solid var(--cline)' }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex gap-1 justify-end">
            <button onClick={cancel} className="text-xs px-2 py-0.5 text-ink-soft hover:bg-sand rounded">
              Cancel
            </button>
            <button onClick={submit} className="text-xs px-2 py-0.5 bg-jade hover:bg-[#5a8f5f] text-cream-hi rounded flex items-center gap-1">
              <Check size={11} /> Save
            </button>
          </div>
        </div>
      )}
    </li>
  );
};

interface CreateNoteCategoryFormProps {
  textId: number;
  onClose: () => void;
}
const CreateNoteCategoryForm: React.FC<CreateNoteCategoryFormProps> = ({ textId, onClose }) => {
  const { createCategory } = useNoteStore();
  const [name, setName] = useState('');
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createCategory(textId, name.trim());
      onClose();
    } catch (err: any) { alert(err.message); }
  };
  return (
    <form
      onSubmit={handleSubmit}
      className="mb-2 flex gap-1 p-2 bg-cream rounded"
      style={{ border: '1px solid var(--cline)' }}
    >
      <input
        type="text"
        autoFocus
        placeholder="Category name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="text-xs flex-1 min-w-0 rounded bg-white py-0.5 px-1.5"
        style={{ border: '1px solid var(--cline)' }}
      />
      <button type="button" onClick={onClose} className="text-xs px-1.5 text-ink-soft hover:bg-sand rounded">×</button>
      <button type="submit" disabled={!name.trim()} className="text-xs px-2 bg-jade hover:bg-[#5a8f5f] text-cream-hi rounded disabled:opacity-50">Add</button>
    </form>
  );
};

export const Sidebar: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const { currentText } = useTextStore();
  const tagStore = useTagStore();
  const regularTags = selectRegularTags(tagStore);
  const sessionTags = selectSessionTags(tagStore);
  const sessionMode = useUIStore(s => s.sessionMode);
  const setSessionMode = useUIStore(s => s.setSessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');

  const [creatingRegular, setCreatingRegular] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [creatingNoteCategory, setCreatingNoteCategory] = useState(false);
  const [activeSection, setActiveSection] = useState<
    'tags' | 'session-tags' | 'annotations' | 'passages' | 'suggestions' | 'notes'
  >('tags');

  // Passages (inline transclusions within this text): list, jump, reorder, link, delete.
  const allPassages = usePassageStore(s => s.passages);
  const removePassage = usePassageStore(s => s.removePassage);
  const editPassage = usePassageStore(s => s.editPassage);
  // Node↔passage linking: linking a passage to a sapche node is the explicit "this
  // passage is its own section" act (it then renders as a standalone card).
  const treeNodes = useTreeNodeStore(s => s.nodes);
  const updateTreeNode = useTreeNodeStore(s => s.updateNode);
  const [passageLinkPickerFor, setPassageLinkPickerFor] = useState<number | null>(null);
  const passages = useMemo(
    () => allPassages.filter(p => p.text_id === currentText?.id),
    [allPassages, currentText?.id],
  );
  // Move a passage among the siblings sharing its anchor: renumber the sibling run in
  // the new order (explicit 0..n-1 positions — robust even when positions collide).
  const movePassage = async (p: (typeof passages)[number], dir: -1 | 1) => {
    const siblings = passages
      .filter(x => x.anchor_syl_id === p.anchor_syl_id)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    const i = siblings.findIndex(x => x.id === p.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const order = [...siblings];
    [order[i], order[j]] = [order[j], order[i]];
    for (let k = 0; k < order.length; k++) {
      if (order[k].position !== k) await editPassage(order[k].id, { position: k });
    }
  };

  // Corrections apply on creation (no accept/reject) — the list is delete-only.
  // Incoming PENDING suggestions (routed here from derived texts) are the exception:
  // they await review — accept (stage or ripple) or reject.
  const { suggestions, deleteSuggestion, fetchSuggestions } = useSuggestionStore();
  const appliedSuggestions = useMemo(() => suggestions.filter(s => s.status !== 'pending'), [suggestions]);
  const pendingIncoming = useMemo(() => suggestions.filter(s => s.status === 'pending'), [suggestions]);
  const loadText = useTextStore(s => s.loadText);

  // A secondary's edits are derivation ops (not suggestions): the same panel lists
  // them, delete-to-undo. Refetched whenever the open text changes identity (which a
  // post-edit loadText refresh triggers).
  const isSecondary = currentText?.text_type === 'secondary';
  const [ops, setOps] = useState<DerivationOp[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (currentText?.text_type === 'secondary') {
      listDerivationOps(currentText.id)
        .then(o => { if (!cancelled) setOps(o); })
        .catch(() => { if (!cancelled) setOps([]); });
    } else {
      setOps([]);
    }
    return () => { cancelled = true; };
  }, [currentText]);
  const handleDeleteOp = async (opId: number) => {
    try {
      await deleteDerivationOp(opId);
      if (currentText) await loadText(currentText.id);  // recompose + refresh panels
    } catch (e: any) {
      alert('Failed to undo edit: ' + (e?.message || e));
    }
  };

  // The ripple trigger: bake the primary's staged corrections into its base layer so
  // they propagate to every text derived from it. Consumes the staged list (pending
  // incoming suggestions are untouched — they bake only via their own accept).
  const handleApplyCorrections = async () => {
    if (!currentText) return;
    if (!confirm(
      `Apply all ${appliedSuggestions.length} correction(s) to the base text?\n\n` +
      'They become part of the text itself (no longer individually undoable) and ' +
      'ripple to every text derived from this one.',
    )) return;
    try {
      await applyCorrections(currentText.id);
      await loadText(currentText.id);
    } catch (e: any) {
      alert('Failed to apply corrections: ' + (e?.message || e));
    }
  };

  // Review an incoming suggestion. 'stage' joins the staged corrections (ripples at the
  // next Apply-all); 'ripple' bakes just this one into the base now. On a secondary
  // owner the backend applies it as an edit op (live) regardless of mode.
  const handleAcceptIncoming = async (id: number, mode: 'stage' | 'ripple') => {
    if (!currentText) return;
    if (mode === 'ripple' && !confirm(
      'Accept and bake this correction into the base now?\n\n' +
      'It immediately ripples to every text derived from this one; your other staged ' +
      'corrections stay staged.',
    )) return;
    try {
      await acceptSuggestion(id, mode);
      if (mode === 'ripple' || isSecondary) await loadText(currentText.id);
      else await fetchSuggestions(currentText.id);
    } catch (e: any) {
      alert('Failed to accept: ' + (e?.message || e));
    }
  };

  // Incoming-review block, shown on any text that owns pending suggestions (a primary,
  // or an intermediate secondary whose hosted syllables were suggested on downstream).
  const renderIncoming = () => pendingIncoming.length > 0 && currentText && (
    <div className="mb-2 shrink-0">
      <div className="text-[10px] uppercase tracking-wider text-lapis mb-1 px-1">
        Incoming — pending review ({pendingIncoming.length})
      </div>
      <ul className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
        {pendingIncoming.map(s => {
          const original = currentText.raw_text.substring(s.start_offset, s.end_offset);
          return (
            <li key={s.id} className="rounded group"
                style={{ border: '1px solid var(--cline)', background: 'rgba(37,99,235,0.06)' }}>
              <button
                type="button"
                onClick={() => {
                  if (!s.start_syl_id || !scrollTaggerToSyllable(s.start_syl_id)) {
                    scrollTaggerToOffset(s.start_offset);
                  }
                }}
                className="block w-full text-left p-1.5 hover:bg-cream rounded-t"
                title="Scroll to this position in the text"
              >
                <div className="flex items-center gap-1 mb-0.5 flex-wrap">
                  <span className="text-[9px] text-lapis uppercase truncate max-w-full">
                    from {s.origin_title ?? 'a derived text'}
                  </span>
                </div>
                <p className="tibetan-text-sm text-xs text-ink break-words line-clamp-2">
                  {original.length > 0 && (
                    <span className="line-through text-rose-600">{original}</span>
                  )}
                  {original.length > 0 && s.suggested_text.length > 0 && ' → '}
                  {s.suggested_text.length > 0 && (
                    <span className="text-emerald-700 font-medium">{s.suggested_text}</span>
                  )}
                </p>
              </button>
              <div className="flex gap-1 px-1.5 pb-1 justify-end items-center">
                <button
                  onClick={() => handleAcceptIncoming(s.id, 'stage')}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-jade/10 text-jade hover:bg-jade hover:text-cream-hi transition-colors"
                  title={isSecondary
                    ? 'Accept — applied as an edit here (ripples to texts derived from this one)'
                    : 'Accept — joins your staged corrections; ripples at the next Apply-all'}
                >
                  ✓ Accept
                </button>
                {!isSecondary && (
                  <button
                    onClick={() => handleAcceptIncoming(s.id, 'ripple')}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-lapis/10 text-lapis hover:bg-lapis hover:text-cream-hi transition-colors"
                    title="Accept & bake into the base now — ripples immediately to all derived texts"
                  >
                    ✓ Accept & ripple
                  </button>
                )}
                <button
                  onClick={() => deleteSuggestion(s.id)}
                  className="text-[10px] px-1.5 py-0.5 rounded text-bronze hover:text-vermilion-deep hover:bg-vermilion/10 transition-colors"
                  title="Reject (deletes the suggestion)"
                >
                  ✗ Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const notes = useNoteStore(s => s.notes);
  const noteCategories = useNoteStore(s => s.categories);
  const deleteNoteCategory = useNoteStore(s => s.deleteCategory);

  // Group notes by category for display.
  const notesByCategory = useMemo(() => {
    const groups = new Map<string, Note[]>();
    for (const n of notes) {
      const key = n.category_name ?? '__uncategorized__';
      const arr = groups.get(key);
      if (arr) arr.push(n);
      else groups.set(key, [n]);
    }
    return groups;
  }, [notes]);

  if (collapsed) {
    return (
      <div
        className="h-full w-8 bg-cream flex flex-col items-center pt-2"
        style={{ borderLeft: '1px solid var(--cline)' }}
      >
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 text-bronze hover:text-vermilion"
          title="Expand sidebar"
        >
          <ChevronLeft size={18} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="h-full w-72 bg-cream-hi flex flex-col overflow-hidden shrink-0"
      style={{ borderLeft: '1px solid var(--cline)' }}
    >
      <div
        className="px-3 py-2 bg-cream flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <span className="font-display text-base text-lapis">Sidebar</span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 text-bronze hover:text-vermilion"
          title="Collapse sidebar"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Mode toggle */}
      <div className="px-3 pt-3">
        <div
          className="flex rounded-md overflow-hidden text-xs font-medium"
          style={{ border: '1px solid var(--cline)' }}
        >
          <button
            type="button"
            onClick={() => setSessionMode(false)}
            className={`flex-1 py-1 flex items-center justify-center gap-1.5 transition-colors ${!sessionMode ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
          >
            <TagIcon size={12} /> Tags
          </button>
          <button
            type="button"
            onClick={() => setSessionMode(true)}
            className={`flex-1 py-1 flex items-center justify-center gap-1.5 transition-colors ${sessionMode ? 'bg-vermilion text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
          >
            <Mic size={12} /> Sessions
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col text-sm">
        {/* Regular tags section */}
        <section
          className={`${activeSection === 'tags' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => setActiveSection('tags')}
              className={`flex-1 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
                activeSection === 'tags'
                  ? 'text-lapis bg-lapis/10'
                  : 'text-bronze hover:bg-cream'
              }`}
            >
              <TagIcon size={12} /> Tags ({regularTags.length})
            </button>
            {activeSection === 'tags' && !consultMode && (
              <button
                onClick={() => setCreatingRegular(v => !v)}
                className="px-2 text-bronze hover:text-lapis bg-lapis/10"
                title="New tag"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          {activeSection === 'tags' && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {creatingRegular && !consultMode && currentText && (
                <CreateRegularForm
                  textId={currentText.id}
                  takenColors={regularTags.map(t => t.color)}
                  onClose={() => setCreatingRegular(false)}
                />
              )}
              {regularTags.length === 0 ? (
                <p className="text-xs text-ink-soft italic px-1">None yet</p>
              ) : (
                <ul className="flex-1 min-h-0 flex flex-col gap-0.5 overflow-y-auto">
                  {regularTags.map(t => <TagRow key={t.id} tag={t} />)}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Session tags section */}
        <section
          className={`${activeSection === 'session-tags' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => setActiveSection('session-tags')}
              className={`flex-1 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
                activeSection === 'session-tags'
                  ? 'text-vermilion-deep bg-vermilion/10'
                  : 'text-bronze hover:bg-cream'
              }`}
            >
              <Mic size={12} /> Session tags ({sessionTags.length})
            </button>
            {activeSection === 'session-tags' && !consultMode && (
              <button
                onClick={() => setCreatingSession(v => !v)}
                className="px-2 text-bronze hover:text-vermilion bg-vermilion/10"
                title="New session tag"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          {activeSection === 'session-tags' && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {creatingSession && !consultMode && currentText && (
                <CreateSessionForm
                  textId={currentText.id}
                  onClose={() => setCreatingSession(false)}
                />
              )}
              {sessionTags.length === 0 ? (
                <p className="text-xs text-ink-soft italic px-1">None yet</p>
              ) : (
                <ul className="flex-1 min-h-0 flex flex-col gap-0.5 overflow-y-auto">
                  {sessionTags.map(t => <TagRow key={t.id} tag={t} />)}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Annotations section */}
        <section
          className={`${activeSection === 'annotations' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <button
            type="button"
            onClick={() => setActiveSection('annotations')}
            className={`w-full px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
              activeSection === 'annotations'
                ? 'text-ink bg-bronze/10'
                : 'text-bronze hover:bg-cream'
            }`}
          >
            <Layers size={12} /> Annotations ({tagStore.spans.length})
          </button>
          {activeSection === 'annotations' && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {tagStore.spans.length === 0 ? (
                <p className="text-xs text-ink-soft italic px-1">No annotation spans yet</p>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ul className="text-xs flex flex-col gap-1">
                    {/* One row PER OCCURRENCE: a span on a twice-transcluded source
                        serializes once per run, same id at different offsets. */}
                    {tagStore.spans.map(s => (
                      <li key={`${s.id}-${s.start_offset}`} className="py-0.5 flex items-center gap-1.5 truncate">
                        <span className="px-1.5 py-0.5 rounded text-cream-hi text-[10px] shrink-0" style={{ backgroundColor: s.tag.color }}>
                          {s.tag.name}
                        </span>
                        <span className="text-bronze truncate font-mono">{s.start_offset}–{s.end_offset}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Passages section — inline transclusions within this text: jump to where a
            passage is placed (or to its source), delete the misplaced ones. */}
        <section
          className={`${activeSection === 'passages' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <button
            type="button"
            onClick={() => setActiveSection('passages')}
            className={`w-full px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
              activeSection === 'passages'
                ? 'text-lapis bg-lapis/10'
                : 'text-bronze hover:bg-cream'
            }`}
          >
            <Link2 size={12} /> Passages ({passages.length})
          </button>
          {activeSection === 'passages' && currentText && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {passages.length === 0 ? (
                <p className="text-xs text-ink-soft italic px-1">
                  No passages yet — select text in the tagger and pick "Link as passage…".
                </p>
              ) : (
                <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
                  {passages.map(p => {
                    const preview = p.members
                      .flatMap(m => m.syllables.map(s => s.text))
                      .join('')
                      .replace(/\n/g, ' ');
                    return (
                      <li key={p.id} className="rounded group" style={{ border: '1px solid var(--cline)' }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!p.anchor_syl_id || !scrollTaggerToSyllable(p.anchor_syl_id)) {
                              scrollTaggerToOffset(currentText.raw_text.length);  // end-anchored
                            }
                          }}
                          className="block w-full text-left p-1.5 hover:bg-cream rounded-t"
                          title="Scroll to where this passage is placed"
                        >
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="text-[9px] text-lapis uppercase">
                              {p.anchor_syl_id ? 'placed' : 'at end'}
                            </span>
                            {p.own_segment && (
                              <span className="text-[9px] text-bronze uppercase">new segment</span>
                            )}
                          </div>
                          <p className="tibetan-text-sm text-xs text-ink break-words line-clamp-2">
                            {preview || '(empty)'}
                          </p>
                        </button>
                        <div className="flex gap-0.5 px-1.5 pb-1 justify-end items-center opacity-0 group-hover:opacity-100">
                          {(() => {
                            const linked = treeNodes.find(n => n.passage_id === p.id);
                            return linked ? (
                              <button
                                onClick={() => updateTreeNode(linked.id, { passage_id: null }).catch((e: any) => alert(e?.message || e))}
                                title={`Unlink from "${linked.title || `#${linked.id}`}" (back to inline rendering)`}
                                className="text-[10px] px-1 py-0.5 rounded text-lapis hover:text-vermilion-deep truncate max-w-[7rem]"
                              >
                                ⛓ {linked.title || `#${linked.id}`}
                              </button>
                            ) : (
                              <button
                                onClick={() => setPassageLinkPickerFor(p.id)}
                                title="Link to a sapche node — the passage becomes its own section (standalone card)"
                                className="text-bronze hover:text-lapis p-0.5 rounded"
                              >
                                <Link2 size={12} />
                              </button>
                            );
                          })()}
                          <button
                            onClick={() => editPassage(p.id, { own_segment: !p.own_segment })}
                            title={p.own_segment
                              ? 'Merge into the preceding segment'
                              : 'Start a new segment before this passage'}
                            className={`p-0.5 rounded hover:text-lapis ${p.own_segment ? 'text-lapis' : 'text-bronze'}`}
                          >
                            <Scissors size={12} />
                          </button>
                          <button
                            onClick={() => movePassage(p, -1)}
                            title="Move earlier among passages at the same spot"
                            className="text-bronze hover:text-lapis p-0.5 rounded"
                          >
                            <ChevronUp size={12} />
                          </button>
                          <button
                            onClick={() => movePassage(p, 1)}
                            title="Move later among passages at the same spot"
                            className="text-bronze hover:text-lapis p-0.5 rounded"
                          >
                            <ChevronDown size={12} />
                          </button>
                          <button
                            onClick={() => {
                              const src = p.members[0]?.src_start_syl_id;
                              if (src) scrollTaggerToSyllable(src);
                            }}
                            title="Scroll to the source section this passage links"
                            className="text-bronze hover:text-lapis p-0.5 rounded"
                          >
                            <CornerUpLeft size={12} />
                          </button>
                          <button
                            onClick={() => removePassage(p.id)}
                            title="Delete this passage"
                            className="text-bronze hover:text-vermilion-deep p-0.5 rounded"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Node picker for linking a passage to a sapche node (own-section act). */}
        {passageLinkPickerFor != null && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPassageLinkPickerFor(null)} />
            <div
              className="fixed z-50 bg-cream-hi shadow-xl rounded-xl p-3 w-80 max-h-96 overflow-hidden flex flex-col"
              style={{ top: '20%', left: '50%', transform: 'translateX(-50%)', border: '1px solid var(--cline)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2 shrink-0">
                <h4 className="font-display text-base text-lapis">Link passage to tree node</h4>
                <button onClick={() => setPassageLinkPickerFor(null)} className="p-1 text-bronze hover:text-vermilion-deep">
                  <X size={14} />
                </button>
              </div>
              {(() => {
                const candidates = treeNodes
                  .filter(n => n.segment_start === null && n.passage_id == null)
                  .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                return candidates.length === 0 ? (
                  <p className="text-xs text-ink-soft italic">
                    No free tree nodes available. Create one in the tree pane first.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5 overflow-y-auto">
                    {candidates.map(n => (
                      <li key={n.id}>
                        <button
                          onClick={() => {
                            updateTreeNode(n.id, { passage_id: passageLinkPickerFor })
                              .catch((e: any) => alert(e?.message || e));
                            setPassageLinkPickerFor(null);
                          }}
                          className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-cream truncate"
                          title={n.title || `(untitled #${n.id})`}
                        >
                          <span className="tibetan-text-sm text-ink" style={{ fontSize: '13px' }}>
                            {n.title || `(untitled #${n.id})`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </>,
          document.body,
        )}

        {/* Suggestions section */}
        <section
          className={`${activeSection === 'suggestions' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <button
            type="button"
            onClick={() => setActiveSection('suggestions')}
            className={`w-full px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
              activeSection === 'suggestions'
                ? 'text-amber-robe bg-gold/15'
                : 'text-bronze hover:bg-cream'
            }`}
          >
            <MessageSquare size={12} /> {isSecondary ? `Edits (${ops.length})` : `Suggestions (${appliedSuggestions.length})`}
            {pendingIncoming.length > 0 && (
              <span
                className="ml-1 text-[9px] px-1.5 py-px rounded-full bg-lapis text-cream-hi normal-case tracking-normal"
                title="Incoming suggestions pending review"
              >
                {pendingIncoming.length} in
              </span>
            )}
          </button>
          {activeSection === 'suggestions' && currentText && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {renderIncoming()}
              {isSecondary ? (
                ops.length === 0 ? (
                  pendingIncoming.length === 0 && (
                    <p className="text-xs text-ink-soft italic px-1">
                      No edits yet — select text in the tagger and pick "Suggest edit",
                      "Delete section" or "Line break".
                    </p>
                  )
                ) : (
                  <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
                    {ops.map(o => (
                      <li key={o.id} className="rounded group" style={{ border: '1px solid var(--cline)' }}>
                        <button
                          type="button"
                          onClick={() => { if (o.anchor_syl_id) scrollTaggerToSyllable(o.anchor_syl_id); }}
                          className="block w-full text-left p-1.5 hover:bg-cream rounded-t"
                          title="Scroll to this edit in the text"
                        >
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="text-[9px] text-bronze uppercase">{o.op_kind}</span>
                          </div>
                          <p className="tibetan-text-sm text-xs text-ink break-words line-clamp-2">{o.summary}</p>
                        </button>
                        <div className="flex gap-0.5 px-1.5 pb-1 justify-end opacity-0 group-hover:opacity-100">
                          <button onClick={() => handleDeleteOp(o.id)} title="Undo this edit" className="text-bronze hover:text-vermilion-deep p-0.5 rounded">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              ) : appliedSuggestions.length === 0 ? (
                pendingIncoming.length === 0 && (
                  <p className="text-xs text-ink-soft italic px-1">
                    No corrections yet — select text in the tagger and pick "Suggest edit".
                  </p>
                )
              ) : (
                <>
                  {!consultMode && (
                    <button
                      type="button"
                      onClick={handleApplyCorrections}
                      className="mb-2 shrink-0 text-xs px-2 py-1.5 rounded bg-amber-robe/10 text-amber-robe hover:bg-amber-robe hover:text-cream-hi transition-colors font-medium"
                      style={{ border: '1px solid var(--cline)' }}
                      title="Bake all corrections into the base text so they ripple to every text derived from this one"
                    >
                      Apply all to base — ripples to derived texts
                    </button>
                  )}
                  <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
                    {appliedSuggestions.map(s => (
                      <SuggestionRow
                        key={s.id}
                        s={s}
                        rawText={currentText.raw_text}
                        onDelete={() => deleteSuggestion(s.id)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>

        {/* Notes section */}
        <section className={`${activeSection === 'notes' ? 'flex-1 min-h-0' : 'shrink-0'} flex flex-col`}>
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => setActiveSection('notes')}
              className={`flex-1 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.13em] flex items-center gap-1.5 transition-colors ${
                activeSection === 'notes'
                  ? 'text-jade bg-jade/15'
                  : 'text-bronze hover:bg-cream'
              }`}
            >
              <StickyNote size={12} /> Notes ({notes.length})
            </button>
            {activeSection === 'notes' && (
              <button
                onClick={() => setCreatingNoteCategory(v => !v)}
                className="px-2 text-bronze hover:text-jade bg-jade/15"
                title="New category"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          {activeSection === 'notes' && (
            <div className="flex-1 min-h-0 p-3 flex flex-col">
              {creatingNoteCategory && currentText && (
                <CreateNoteCategoryForm
                  textId={currentText.id}
                  onClose={() => setCreatingNoteCategory(false)}
                />
              )}

              {notes.length === 0 ? (
                <p className="text-xs text-ink-soft italic px-1">
                  No notes yet — select text in the tagger and pick the Note tab.
                </p>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ul className="flex flex-col gap-2">
                    {Array.from(notesByCategory.entries())
                      .sort(([a], [b]) => {
                        if (a === '__uncategorized__') return 1;
                        if (b === '__uncategorized__') return -1;
                        return a.localeCompare(b);
                      })
                      .map(([categoryName, group]) => (
                        <li key={categoryName}>
                          <div className="text-[10px] uppercase tracking-[0.13em] text-bronze px-1 mb-0.5">
                            {categoryName === '__uncategorized__' ? 'Uncategorized' : categoryName}
                          </div>
                          <ul className="flex flex-col gap-0.5">
                            {group.map(n => (
                              <NoteRow
                                key={n.id}
                                note={n}
                                snippet={
                                  currentText
                                    ? truncate(currentText.raw_text.substring(n.start_offset, n.end_offset), 40)
                                    : ''
                                }
                              />
                            ))}
                          </ul>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {noteCategories.length > 0 && (
                <div className="shrink-0 mt-2 pt-2" style={{ borderTop: '1px solid var(--cline)' }}>
                  <div className="text-[10px] uppercase tracking-wider text-bronze mb-1">Categories</div>
                  <ul className="flex flex-wrap gap-1">
                    {noteCategories.map(c => (
                      <li key={c.id} className="group flex items-center gap-0.5 text-[11px] bg-cream rounded px-1.5 py-0.5">
                        <span className="text-ink">{c.name}</span>
                        <button
                          onClick={() => {
                            if (confirm(`Delete category "${c.name}"? Notes using it will become uncategorized.`)) {
                              deleteNoteCategory(c.id);
                            }
                          }}
                          className="text-bronze hover:text-vermilion-deep opacity-0 group-hover:opacity-100"
                          title="Delete category"
                        >
                          <X size={10} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '…';
}
