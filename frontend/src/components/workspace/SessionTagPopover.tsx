import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Mic, ChevronsLeft, ChevronsRight, Trash2 } from 'lucide-react';
import { useTagStore, selectSessionTags, type Tag } from '../../store/useTagStore';
import { useUIStore } from '../../store/useUIStore';
import { colorForSessionTag, SESSION_TAG_NAME_RE } from '../../lib/sessionTagColor';

interface Props {
  textId: number;
  /** Start of the syllable the user clicked in (alt position). */
  unitStart: number;
  /** End of the syllable the user clicked in (default position). */
  unitEnd: number;
  anchorRect: DOMRect;
  onClose: () => void;
}

type TabKey = 'open' | 'close';

/**
 * Popover for the session-tag two-step workflow.
 *
 * - "Open new" creates a session tag with `open_position = position`.
 * - "Close" sets `close_position = position` on an existing open-but-unclosed
 *   session tag, picked from a list.
 *
 * The "Open new" tab suggests the next unused letter in gray, lists already-used
 * letters as quick-pick buttons, accepts a free-letter typed override, and
 * shows the next-unused number (per-letter) in an editable input.
 */
export const SessionTagPopover: React.FC<Props> = ({ textId, unitStart, unitEnd, anchorRect, onClose }) => {
  const tagStore = useTagStore();
  const { createTag, updateTag } = tagStore;
  const sessionTags = selectSessionTags(tagStore);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const openTags = sessionTags.filter(t => t.open_position != null && t.close_position == null);

  // Default to the Close tab if there's at least one open tag to close.
  const [tab, setTab] = useState<TabKey>(openTags.length > 0 ? 'close' : 'open');
  const [error, setError] = useState<string | null>(null);

  // Marker position — defaults to the END of the clicked syllable, with a
  // toggle to flip to the START (so a click anywhere in the very first
  // syllable can place a marker at offset 0).
  const [atStart, setAtStart] = useState(false);
  const position = atStart ? unitStart : unitEnd;

  // ─── Open-new state ────────────────────────────────────────────────────────
  const usedLetters = useMemo(() => {
    const set = new Set<string>();
    for (const t of sessionTags) {
      const m = SESSION_TAG_NAME_RE.exec(t.name);
      if (m) set.add(m[1]);
    }
    return Array.from(set).sort();
  }, [sessionTags]);

  const nextUnusedLetter = useMemo(() => {
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c);
      if (!usedLetters.includes(L)) return L;
    }
    return 'A';
  }, [usedLetters]);

  const nextNumberForLetter = (L: string): number => {
    const used = new Set<number>();
    for (const t of sessionTags) {
      const m = SESSION_TAG_NAME_RE.exec(t.name);
      if (m && m[1] === L) used.add(Number.parseInt(m[2], 10));
    }
    for (let i = 1; i <= 9999; i++) if (!used.has(i)) return i;
    return 1;
  };

  // Default letter: keep continuing the most recently created series rather
  // than jumping to a fresh letter. If the last tag was A1, we want A2 next,
  // not B. Falls back to next-unused-letter when there are no session tags
  // yet (i.e. the very first session in the doc gets "A").
  const defaultLetter = useMemo(() => {
    if (sessionTags.length === 0) return nextUnusedLetter;
    // Pick the session tag with the highest id (most recent insertion).
    const latest = sessionTags.reduce((a, b) => (a.id > b.id ? a : b));
    const m = SESSION_TAG_NAME_RE.exec(latest.name);
    return m ? m[1] : nextUnusedLetter;
  }, [sessionTags, nextUnusedLetter]);

  // Selected letter (either from the buttons or the free input).
  const [letter, setLetter] = useState<string>(defaultLetter);
  const [numberInput, setNumberInput] = useState<string>(String(nextNumberForLetter(defaultLetter)));

  const chooseLetter = (L: string) => {
    setLetter(L);
    setNumberInput(String(nextNumberForLetter(L)));
    setError(null);
  };

  const onFreeLetterChange = (raw: string) => {
    // Accept exactly one A-Z letter (uppercased), or empty.
    const upper = raw.toUpperCase();
    const single = upper.length > 0 ? upper.slice(-1) : '';
    if (single && !/^[A-Z]$/.test(single)) return;
    setError(null);
    if (single) chooseLetter(single);
  };

  const candidateName = `${letter}${numberInput}`;
  const candidateValid = SESSION_TAG_NAME_RE.test(candidateName);

  const handleOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!candidateValid) { setError('Name must look like A1, B12, K3'); return; }
    // Refuse re-creating an existing tag.
    if (sessionTags.some(t => t.name === candidateName)) {
      setError(`"${candidateName}" already exists in this text`);
      return;
    }
    try {
      await createTag(textId, candidateName, colorForSessionTag(candidateName), 'session', position);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleClose = async (tag: Tag) => {
    setError(null);
    if (tag.open_position == null) { setError(`Tag ${tag.name} has no open marker`); return; }
    if (position <= tag.open_position) {
      setError(`Close position must come after open position (${tag.open_position})`);
      return;
    }
    try {
      await updateTag(tag.id, { close_position: position });
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const { deleteTag } = useTagStore.getState();
  const handleDeleteOpen = async (tag: Tag) => {
    if (!confirm(`Delete session tag "${tag.name}" (open marker only)?`)) return;
    try {
      await deleteTag(tag.id);
      // Keep the popover open so the user can do another action.
    } catch (err: any) {
      setError(err.message);
    }
  };

  // ─── Positioning ───────────────────────────────────────────────────────────
  const PW = 320;
  const PH = 280;
  const left = Math.max(8, Math.min(window.innerWidth - PW - 8, anchorRect.left + anchorRect.width / 2 - PW / 2));
  const top = anchorRect.bottom + 8 + PH > window.innerHeight
    ? Math.max(8, anchorRect.top - PH - 8)
    : anchorRect.bottom + 8;

  // Consult mode: session-tag CRUD is disabled at the source (TaggerPane click
  // handler), but bail out here too as a safety net in case anything else opens
  // this popover.
  if (consultMode) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 bg-cream-hi shadow-2xl rounded-xl flex flex-col"
        style={{ top, left, width: PW, border: '1px solid var(--cline)' }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <div className="flex gap-1">
            <button
              onClick={() => setTab('close')}
              disabled={openTags.length === 0}
              className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                tab === 'close' && openTags.length > 0
                  ? 'bg-vermilion/10 text-vermilion-deep'
                  : 'text-ink-soft hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
              title={openTags.length === 0 ? 'No open session tags to close' : undefined}
            >
              Close existing ({openTags.length})
            </button>
            <button
              onClick={() => setTab('open')}
              className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                tab === 'open'
                  ? 'bg-vermilion/10 text-vermilion-deep'
                  : 'text-ink-soft hover:bg-cream'
              }`}
            >
              <Mic size={12} /> Open new
            </button>
          </div>
          <button onClick={onClose} className="p-1 text-bronze hover:text-vermilion-deep">
            <X size={14} />
          </button>
        </div>

        <div className="px-3 py-2 text-[11px] text-ink-soft flex items-center justify-between gap-2">
          <span>Marker at offset <span className="font-mono text-ink">{position}</span></span>
          {unitStart !== unitEnd && (
            <button
              type="button"
              onClick={() => setAtStart(v => !v)}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-soft hover:bg-cream"
              style={{ border: '1px solid var(--cline)' }}
              title={atStart
                ? `Move to end of syllable (offset ${unitEnd})`
                : `Move to start of syllable (offset ${unitStart})`}
            >
              {atStart ? <ChevronsRight size={11} /> : <ChevronsLeft size={11} />}
              {atStart ? 'end of syllable' : 'start of syllable'}
            </button>
          )}
        </div>

        {error && (
          <div
            className="mx-3 mb-2 text-xs text-vermilion-deep rounded px-2 py-1"
            style={{ background: 'rgba(194,41,32,0.08)', border: '1px solid rgba(194,41,32,0.20)' }}
          >{error}</div>
        )}

        {tab === 'close' && (
          <div className="px-3 pb-3 flex flex-col gap-1.5">
            {openTags.length === 0 ? (
              <p className="text-xs text-ink-soft italic">No open session tags.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
                {openTags.map(t => (
                  <li key={t.id} className="group flex items-center gap-1 rounded hover:bg-vermilion/5">
                    <button
                      onClick={() => handleClose(t)}
                      className="flex-1 text-left text-xs px-2 py-1.5 flex items-center gap-2"
                    >
                      <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                      <span className="font-medium text-ink">{t.name}</span>
                      <span className="text-bronze text-[10px] font-mono ml-auto">opened @ {t.open_position}</span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteOpen(t); }}
                      className="opacity-0 group-hover:opacity-100 px-2 py-1.5 text-bronze hover:text-vermilion-deep"
                      title={`Delete the open marker for ${t.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'open' && (
          <form onSubmit={handleOpen} className="px-3 pb-3 flex flex-col gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-bronze mb-1">Letter</p>
              <div className="flex flex-wrap gap-1 items-center">
                {usedLetters.map(L => (
                  <button
                    key={L}
                    type="button"
                    onClick={() => chooseLetter(L)}
                    className={`text-xs px-2 py-1 rounded font-medium ${
                      letter === L
                        ? 'bg-vermilion text-cream-hi'
                        : 'bg-cream text-ink hover:bg-sand'
                    }`}
                  >
                    {L}
                  </button>
                ))}
                {!usedLetters.includes(nextUnusedLetter) && (
                  <button
                    key={nextUnusedLetter}
                    type="button"
                    onClick={() => chooseLetter(nextUnusedLetter)}
                    className={`text-xs px-2 py-1 rounded font-medium ${
                      letter === nextUnusedLetter
                        ? 'bg-vermilion text-cream-hi'
                        : 'text-bronze hover:bg-cream'
                    }`}
                    style={letter === nextUnusedLetter ? undefined : { border: '1px dashed var(--cline)' }}
                    title="Next unused letter"
                  >
                    {nextUnusedLetter}
                  </button>
                )}
                <input
                  type="text"
                  value={letter}
                  onChange={(e) => onFreeLetterChange(e.target.value)}
                  maxLength={1}
                  className="w-10 text-center text-xs font-medium uppercase rounded bg-white py-1 ml-auto"
                  style={{ border: '1px solid var(--cline)' }}
                  title="Type any letter"
                />
              </div>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wider text-bronze mb-1">Number</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={numberInput}
                  onChange={(e) => setNumberInput(e.target.value.replace(/[^0-9]/g, ''))}
                  className="w-20 text-sm rounded bg-white py-1 px-2"
                  style={{ border: '1px solid var(--cline)' }}
                />
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: candidateValid ? colorForSessionTag(candidateName) : '#94a3b8' }} />
                  <span className="font-medium text-ink">{candidateName}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-1">
              <button type="button" onClick={onClose} className="flex-1 text-xs px-2 py-1.5 bg-cream text-ink rounded hover:bg-sand">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!candidateValid}
                className="flex-1 text-xs px-2 py-1.5 bg-vermilion hover:bg-vermilion-deep text-cream-hi rounded disabled:opacity-50"
              >
                Open {candidateValid ? candidateName : 'tag'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>,
    document.body,
  );
};
