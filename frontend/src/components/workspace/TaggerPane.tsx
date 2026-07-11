import React, { useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { X } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useSuggestionStore } from '../../store/useSuggestionStore';
import { useNoteStore } from '../../store/useNoteStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useUIStore, MIN_FONT, MAX_FONT } from '../../store/useUIStore';
import { computeSegments } from './segments';
import { SegmentCard } from './SegmentCard';
import { SessionTagPopover } from './SessionTagPopover';
import { getReadingPosition, putReadingPosition } from '../../api/client';

/** Walk up from `node` to the nearest token span (`data-syl-id`). */
function enclosingTokenEl(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.sylId !== undefined) {
      return n as HTMLElement;
    }
    n = n.parentNode;
  }
  return null;
}

/** Resolve a selection endpoint to its token span (with a between-tokens fallback). */
function tokenAt(node: Node, offset: number): HTMLElement | null {
  const direct = enclosingTokenEl(node);
  if (direct) return direct;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const kids = (node as HTMLElement).childNodes;
    return enclosingTokenEl(kids[offset]) || enclosingTokenEl(kids[offset - 1]);
  }
  return null;
}

/**
 * Session-mode selection reader. Resolves BOTH the drag start and end to their
 * syllable tokens, snaps the visible selection across the whole [start..end]
 * range (so the highlight lands on syllable boundaries on both ends — the cue
 * for verifying a selection is syllable-aligned), and returns the END syllable's
 * [start, end] raw offsets for the marker (snaps to its end; `unitStart` is the
 * alternative boundary). Reads token spans' `data-ro`/`data-reo`, robust to
 * corrected text. Null when the endpoints aren't on tokens.
 */
function readClickToken(): { unitStart: number; unitEnd: number; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const endEl = tokenAt(range.endContainer, range.endOffset);
  if (!endEl || endEl.dataset.ro === undefined) return null;
  // Collapsed click → single syllable; drag → from the start token to the end token.
  const startEl = tokenAt(range.startContainer, range.startOffset) ?? endEl;
  let a = startEl, b = endEl;
  if (Number(a.dataset.ro) > Number(b.dataset.ro)) { const t = a; a = b; b = t; }
  const snapped = document.createRange();
  snapped.setStartBefore(a);
  snapped.setEndAfter(b);
  sel.removeAllRanges();
  sel.addRange(snapped);
  let rect = endEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) rect = snapped.getBoundingClientRect();
  // Marker bounds come from the drag-end syllable.
  return { unitStart: Number(endEl.dataset.ro), unitEnd: Number(endEl.dataset.reo), rect };
}

export const TaggerPane: React.FC = () => {
  const { currentText } = useTextStore();
  const { spans } = useTagStore();
  const { markers, deleteMarker } = useMarkerStore();
  const { suggestions } = useSuggestionStore();
  const notes = useNoteStore(s => s.notes);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const taggerFontSize = useUIStore(s => s.taggerFontSize);
  const increaseTaggerFontSize = useUIStore(s => s.increaseTaggerFontSize);
  const decreaseTaggerFontSize = useUIStore(s => s.decreaseTaggerFontSize);
  const fullscreen = useUIStore(s => s.workspaceFullscreen);

  const editorTokens = useEditorTokenStore(s => s.tokens);
  const fetchEditorTokens = useEditorTokenStore(s => s.fetchTokens);
  // (Re)fetch the corrected syllable layer for the body whenever the document or
  // its suggestions change (a correction edits the corrected text).
  useEffect(() => {
    if (currentText) fetchEditorTokens(currentText.id);
  }, [currentText, suggestions, fetchEditorTokens]);

  const segments = useMemo(() => {
    if (!currentText) return [];
    return computeSegments(currentText.raw_text, spans, markers, suggestions, notes, editorTokens);
  }, [currentText, spans, markers, suggestions, notes, editorTokens]);

  // Session-mode click state: the user clicks anywhere in the tagger and the
  // marker snaps to the end of the syllable under the caret. `unitStart` is
  // the alternative position (start of that syllable) — the popover exposes a
  // toggle so the user can flip the marker to that boundary if needed (used
  // notably for the doc-start edge case: click anywhere in the first syllable
  // → marker defaults to end of first syllable, flip → position 0).
  const [sessionSelection, setSessionSelection] = useState<{
    unitStart: number;
    unitEnd: number;
    rect: DOMRect;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- Last-viewed segment: restore on open, then save the top-most visible segment
  // (syllable-native, per-user on the backend). The corrected tokens/markers/notes load
  // asynchronously and each arrival re-renders the body, which can reset scrollTop — so a
  // one-shot scroll fires too early and gets clobbered. We keep `restoreSylRef` set to the
  // saved segment and re-pin it to the top in a layout effect that runs after *every* render
  // (a clobber is itself a render), synchronously before paint, until the user takes over
  // (wheel / pointer / a navigation key). `savingEnabledRef` gates saving so the transient
  // top-of-document position during load never overwrites the stored one.
  const restoreSylRef = useRef<string | null>(null);
  const savingEnabledRef = useRef(false);
  const lastTopSyl = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // The start syllable of the first segment still visible at/below the viewport's top.
  const topSegmentSyl = (): string | null => {
    const container = scrollRef.current;
    if (!container) return null;
    const top = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll<HTMLElement>('[data-segment-syl]')) {
      if (el.getBoundingClientRect().bottom > top + 1) return el.dataset.segmentSyl || null;
    }
    return null;
  };

  const flushSave = (id: number) => {
    if (!savingEnabledRef.current || !lastTopSyl.current) return;
    putReadingPosition(id, lastTopSyl.current).catch(() => {});
  };

  const handleScrollSave = () => {
    if (!currentText || !savingEnabledRef.current) return;
    const syl = topSegmentSyl();
    if (syl) lastTopSyl.current = syl;
    const id = currentText.id;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flushSave(id), 400);
  };

  // On opening a text, fetch its saved position and arm the restore (or enable saving if none).
  useEffect(() => {
    const id = currentText?.id;
    if (id == null) return;
    savingEnabledRef.current = false;
    restoreSylRef.current = null;
    lastTopSyl.current = null;
    let cancelled = false;
    getReadingPosition(id)
      .then(pos => {
        if (cancelled || useTextStore.getState().currentText?.id !== id) return;
        if (pos?.syl_id) {
          restoreSylRef.current = pos.syl_id;
          forceTick(t => t + 1);  // ensure at least one render → the layout effect pins it
        } else {
          savingEnabledRef.current = true;  // nothing to restore → save from the start
        }
      })
      .catch(() => { if (!cancelled) savingEnabledRef.current = true; });
    return () => { cancelled = true; };
  }, [currentText]);

  // Re-pin the saved segment to the top after every render, before paint, while restore is
  // armed. Because async body re-renders (token/marker/note loads) each trigger this, any
  // scroll reset they cause is corrected immediately and invisibly.
  useLayoutEffect(() => {
    const syl = restoreSylRef.current;
    const c = scrollRef.current;
    if (!syl || !c) return;
    const el = c.querySelector<HTMLElement>(`[data-segment-syl="${CSS.escape(syl)}"]`)
      ?? document.querySelector<HTMLElement>(`[data-syl-id="${CSS.escape(syl)}"]`)
           ?.closest<HTMLElement>('[data-segment-start]') ?? null;
    if (!el) return;
    const delta = el.getBoundingClientRect().top - c.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) c.scrollTop += delta;
    lastTopSyl.current = syl;
  });

  // The user taking over (real wheel / pointer / navigation key — not our programmatic
  // scrollTop writes) disarms restore and switches to saving. Also flush on leave/switch.
  useEffect(() => {
    const id = currentText?.id;
    if (id == null) return;
    const container = scrollRef.current;
    const takeOver = () => { restoreSylRef.current = null; savingEnabledRef.current = true; };
    const takeOverKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) takeOver();
    };
    const opts: AddEventListenerOptions = { passive: true };
    container?.addEventListener('wheel', takeOver, opts);
    container?.addEventListener('pointerdown', takeOver, opts);
    container?.addEventListener('touchstart', takeOver, opts);
    window.addEventListener('keydown', takeOverKey);
    return () => {
      container?.removeEventListener('wheel', takeOver, opts);
      container?.removeEventListener('pointerdown', takeOver, opts);
      container?.removeEventListener('touchstart', takeOver, opts);
      window.removeEventListener('keydown', takeOverKey);
      flushSave(id);
    };
  }, [currentText]);

  if (!currentText) return null;

  const handlePaneMouseUp = () => {
    // Any interaction in the pane records the current top segment (so clicking a
    // segment — not only scrolling — leaves a resumable position).
    if (savingEnabledRef.current) {
      const syl = topSegmentSyl();
      if (syl) lastTopSyl.current = syl;
    }
    if (!sessionMode) return;
    // Consult mode disables session-tag creation.
    if (consultMode) return;
    // Defer so the browser has settled the selection before we read it.
    setTimeout(() => {
      const click = readClickToken();
      if (!click || click.unitEnd <= click.unitStart) { setSessionSelection(null); return; }
      setSessionSelection({ unitStart: click.unitStart, unitEnd: click.unitEnd, rect: click.rect });
    }, 0);
  };

  const closeSessionPopover = () => {
    setSessionSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-cream-hi">
      {!fullscreen && (
      <div
        className="px-4 py-2 bg-cream shrink-0 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <div className="flex items-center gap-3">
          <h3 className="font-display text-lg text-lapis flex items-center gap-2">
            Tagger
            {sessionMode && (
              <span
                className="text-[10px] uppercase tracking-[0.15em] font-sans text-vermilion-deep px-1.5 py-px rounded"
                style={{ background: 'rgba(194,41,32,0.10)', border: '1px solid rgba(194,41,32,0.22)' }}
              >
                Session mode
              </span>
            )}
          </h3>
          <div className="flex items-center gap-0.5">
            <button
              onClick={decreaseTaggerFontSize}
              disabled={taggerFontSize <= MIN_FONT}
              className="px-1.5 py-0.5 rounded text-xs font-medium text-bronze hover:bg-cream-hi hover:text-vermilion disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Decrease font size"
              aria-label="Decrease font size"
            >
              A−
            </button>
            <button
              onClick={increaseTaggerFontSize}
              disabled={taggerFontSize >= MAX_FONT}
              className="px-1.5 py-0.5 rounded text-sm font-medium text-bronze hover:bg-cream-hi hover:text-vermilion disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Increase font size"
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>
        </div>
        <span className="text-[10px] text-bronze font-mono">
          {segments.length} segment{segments.length === 1 ? '' : 's'} · {sessionMode ? 'click anywhere to drop a session marker' : 'select text to tag or suggest an edit'}
        </span>
      </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3"
        data-tagger-root
        onMouseUp={handlePaneMouseUp}
        onScroll={handleScrollSave}
      >
        {segments.length === 0 ? (
          <p className="text-ink-soft italic text-sm">Loading text…</p>
        ) : (
          segments.map((seg, i) => {
            const markerHere = i > 0
              ? markers.find(m => m.position === seg.start)
              : undefined;
            return (
              <React.Fragment key={seg.key}>
                {markerHere && (
                  <div className="flex items-center justify-center gap-1 my-1.5 group">
                    <span className="h-px flex-1 bg-vermilion-lo opacity-60" />
                    <span className="text-[10px] uppercase tracking-wider text-vermilion-deep">separator</span>
                    {!consultMode && (
                      <button
                        onClick={() => deleteMarker(markerHere.id)}
                        className="opacity-0 group-hover:opacity-100 text-vermilion hover:text-vermilion-deep p-0.5"
                        title="Remove this separator"
                      >
                        <X size={10} />
                      </button>
                    )}
                    <span className="h-px flex-1 bg-vermilion-lo opacity-60" />
                  </div>
                )}
                <SegmentCard segment={seg} />
              </React.Fragment>
            );
          })
        )}
      </div>

      {sessionSelection && (
        <SessionTagPopover
          textId={currentText.id}
          unitStart={sessionSelection.unitStart}
          unitEnd={sessionSelection.unitEnd}
          anchorRect={sessionSelection.rect}
          onClose={closeSessionPopover}
        />
      )}
    </div>
  );
};
