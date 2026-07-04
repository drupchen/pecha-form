import React, { useContext, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, Link2, GitBranchPlus, Trash2, X } from 'lucide-react';
import type { Segment } from './segments';
import { readTokenSelection } from './segments';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore, type Span, type Tag } from '../../store/useTagStore';
import { HoverTagPopover } from './HoverTagPopover';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { usePassageStore } from '../../store/usePassageStore';
import type { Passage } from '../../api/client';
import { useLinkStore, scrollToLinkPartner } from '../../store/useLinkStore';
import { useUIStore } from '../../store/useUIStore';
import { SegmentTagPopover } from './SegmentTagPopover';
import { TaggerSearchContext } from './TaggerSearchContext';

interface Props {
  segment: Segment;
}

// Neutral accent for the cross-pane link affordance (no tag color anymore).
const LINK_COLOR = '#A28348';

// Provenance foreground colours for a *secondary* text's composed tokens. A
// parent-link renders in the default ink; changed/added/transcluded syllables get a
// distinct colour so their origin is visible at a glance (syllable-native — keyed by
// the token's `source`, never offsets).
const PROVENANCE_COLOR: Record<string, string> = {
  override: '#B45309',      // amber — a parent syllable changed in place
  added: '#1E7A6B',         // jade — a syllable added in the secondary
  transclusion: '#2563EB',  // lapis — a range linked in from another text
};
const PROVENANCE_TITLE: Record<string, string> = {
  override: 'Changed in this secondary text',
  added: 'Added in this secondary text',
  transclusion: 'Transcluded from another text',
};

/**
 * Renders one segment as a stacked card. Segments are uniform — they're
 * marker-bounded text regions. A segment may be "linked" to a tree node iff
 * some node has `segment_start === segment.start`; the segment can also carry
 * any number of overlapping inline annotation spans rendered as colored
 * backgrounds inside the body text.
 */
export const SegmentCard: React.FC<Props> = ({ segment }) => {
  const { currentText } = useTextStore();
  const { tags, updateSpan, deleteSpan, deleteTag } = useTagStore();
  const { nodes, createNode, updateNode } = useTreeNodeStore();
  const activeNodeId = useTreeNodeStore(s => s.activeNodeId);
  const setActiveNode = useTreeNodeStore(s => s.setActiveNode);
  const editingAppend = useTreeNodeStore(s => s.editingAppend);
  const setHovered = useLinkStore(s => s.setHovered);
  const setFocused = useLinkStore(s => s.setFocused);
  const hoveredKey = useLinkStore(s => s.hoveredKey);
  const allPassages = usePassageStore(s => s.passages);
  const addPassage = usePassageStore(s => s.addPassage);
  const pendingPassageSource = useUIStore(s => s.pendingPassageSource);
  const setPendingPassageSource = useUIStore(s => s.setPendingPassageSource);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const taggerFontSize = useUIStore(s => s.taggerFontSize);
  const searchMatchIndex = useUIStore(s => s.searchMatchIndex);
  const allSearchMatches = useContext(TaggerSearchContext);
  const searchMatchesInSegment = useMemo(
    () => allSearchMatches.filter(m => m.start < segment.end && m.end > segment.start),
    [allSearchMatches, segment.start, segment.end],
  );
  const currentSearchMatch = allSearchMatches[searchMatchIndex];
  const textRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect;
  } | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Annotation-edit popover state. `editTarget` is the annotation span being
  // edited. `annPicker` shows when the user clicks a fragment with multiple
  // overlapping annotations — they pick one, which becomes `editTarget`.
  const [editTarget, setEditTarget] = useState<{ span: Span; anchor: DOMRect } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [annPicker, setAnnPicker] = useState<{ anns: Span[]; anchor: DOMRect } | null>(null);
  const [hoverPopover, setHoverPopover] = useState<{ tags: Tag[]; anchorRect: DOMRect } | null>(null);

  if (!currentText) return null;

  // Link key = segment.start. Both this segment and any tree node linked to
  // it carry the same `data-link-key` for the cross-pane LinkOverlay.
  const linkKey = segment.start;
  const linkedNode = nodes.find(n => n.segment_start === segment.start);

  const isLinkHovered = hoveredKey === linkKey;
  const linkProps: Record<string, any> = {
    'data-link-key': linkKey,
    onMouseEnter: () => setHovered(linkKey),
    onMouseLeave: () => setHovered(null),
  };
  const linkStyle: React.CSSProperties = {
    ['--link-color' as any]: LINK_COLOR,
    ...(isLinkHovered
      ? { boxShadow: `0 0 0 2px ${LINK_COLOR}`, backgroundColor: `${LINK_COLOR}1f` }
      : {}),
  };

  // In session mode, build pseudo-spans from session tags whose paired
  // open/close markers overlap this segment. In regular mode, just show
  // regular-kind annotation spans.
  const sessionRangeSpans = useMemo<Span[]>(() => {
    if (!sessionMode) return [];
    return tags
      .filter(t => t.tag_kind === 'session' && t.open_position != null && t.close_position != null)
      .filter(t => t.open_position! < segment.end && t.close_position! > segment.start)
      .map(t => ({
        id: -t.id, // pseudo id; negative to distinguish from real spans
        text_id: t.text_id,
        tag_id: t.id,
        start_offset: t.open_position!,
        end_offset: t.close_position!,
        tag: t,
      }));
  }, [sessionMode, tags, segment.start, segment.end]);

  // Open-only session tags whose open_position falls inside this segment —
  // rendered as inline hairlines (no closed range yet).
  const sessionOpenHairlines = useMemo(() => {
    if (!sessionMode) return [] as { position: number; color: string; name: string }[];
    return tags
      .filter(t => t.tag_kind === 'session' && t.open_position != null && t.close_position == null)
      .filter(t => t.open_position! >= segment.start && t.open_position! <= segment.end)
      .map(t => ({ position: t.open_position!, color: t.color, name: t.name }));
  }, [sessionMode, tags, segment.start, segment.end]);

  const visibleAnnotations = useMemo(() => {
    if (sessionMode) return sessionRangeSpans;
    return segment.annotations.filter(s => s.tag.tag_kind === 'regular');
  }, [sessionMode, sessionRangeSpans, segment.annotations]);

  // Passages anchored inside this segment. Each renders inline (in a distinct
  // colour) BEFORE its anchor syllable; anchor === null renders at the end of the
  // text (last segment). Passage content is links to syllables elsewhere in the
  // same text, so it is display-only and excluded from tagger selection.
  const passagesByAnchor = useMemo(() => {
    const tokenIds = new Set(segment.tokens.map(t => t.id));
    const map = new Map<string, Passage[]>();
    const atEnd: Passage[] = [];
    for (const p of allPassages) {
      if (p.text_id !== currentText.id) continue;
      if (p.anchor_syl_id && tokenIds.has(p.anchor_syl_id)) {
        const arr = map.get(p.anchor_syl_id) ?? [];
        arr.push(p);
        map.set(p.anchor_syl_id, arr);
      } else if (!p.anchor_syl_id && segment.end >= currentText.raw_text.length) {
        atEnd.push(p);
      }
    }
    return { map, atEnd };
  }, [allPassages, segment.tokens, segment.end, currentText.id, currentText.raw_text.length]);

  // Render the body as a flat sequence of corrected syllable tokens (Phase 3 E2).
  // Each token is a span carrying `data-syl-id` + raw offsets (`data-ro`/`data-reo`)
  // so the displayed text is the corrected, selectable text and selection snaps to
  // whole syllables. Tag/note/search overlays + session hairlines are applied per
  // token. Corrected/inserted tokens get an amber dotted underline; the original is
  // shown on hover.
  const fragments = useMemo(() => {
    const tagBgStyle = (anns: typeof visibleAnnotations): React.CSSProperties => {
      if (anns.length === 1) {
        return { backgroundColor: `${anns[0].tag.color}33` };
      }
      if (anns.length > 1) {
        const STRIPE_PX = 7;
        const stops = anns
          .map((a, i) => `${a.tag.color}33 ${i * STRIPE_PX}px, ${a.tag.color}33 ${(i + 1) * STRIPE_PX}px`)
          .join(', ');
        return { background: `repeating-linear-gradient(45deg, ${stops})` };
      }
      return {};
    };

    const out: React.ReactNode[] = [];
    const tokens = segment.tokens;
    // Fallback before the token layer has loaded: render the raw text as one
    // selectable span so the pane is never blank (offsets still work coarsely).
    if (tokens.length === 0) {
      out.push(
        <span key="raw" data-syl-id="" data-ro={segment.start} data-reo={segment.end}>
          {segment.text}
        </span>,
      );
      return out;
    }

    const renderPassage = (p: Passage) => {
      const text = p.members.flatMap(m => m.syllables.map(s => s.text)).join('');
      out.push(
        <span
          key={`passage-${p.id}`}
          data-passage-id={p.id}
          className="passage-run"
          style={p.color ? ({ ['--passage-fg' as any]: p.color }) : undefined}
          contentEditable={false}
          title="Linked passage — syllables drawn from elsewhere in this text"
        >
          {text}
        </span>,
      );
    };

    const renderHairlinesAt = (pos: number) => {
      for (const h of sessionOpenHairlines.filter(x => x.position === pos)) {
        out.push(
          <span
            key={`hairline-${h.name}-${pos}`}
            title={`Session ${h.name} opens here (close it from the popup)`}
            style={{
              display: 'inline-block', width: '3px', height: '1.1em',
              backgroundColor: h.color, verticalAlign: 'middle', margin: '0 1px',
            }}
          />,
        );
      }
    };

    for (const t of tokens) {
      renderHairlinesAt(t.start_offset);
      // Inline passages anchored before this syllable.
      const anchoredPassages = passagesByAnchor.map.get(t.id);
      if (anchoredPassages) anchoredPassages.forEach(renderPassage);
      // A token (a syllable) is fully covered or not — annotation boundaries are on
      // syllable edges. Inserted tokens are zero-width (start == end).
      const anns = visibleAnnotations.filter(x => x.start_offset <= t.start_offset && x.end_offset >= t.end_offset);
      const note = segment.notes.find(x => x.start_offset <= t.start_offset && x.end_offset >= t.end_offset);
      const searchHit = searchMatchesInSegment.find(m => m.start <= t.start_offset && m.end >= t.end_offset);
      const isCurrentSearchHit = !!searchHit && currentSearchMatch
        && searchHit.start === currentSearchMatch.start
        && searchHit.end === currentSearchMatch.end;
      const corrected = t.inserted || (t.original != null && t.original !== t.text);
      const style: React.CSSProperties = { ...tagBgStyle(anns) };
      // A run tagged "small" or "sapche" (small-letters annotations) renders at 75% size.
      // `em` (not rem) so it composes with the pane-wide taggerFontSize on the container.
      if (anns.some(a => ['small', 'sapche'].includes(a.tag.name.trim().toLowerCase()))) {
        style.fontSize = '0.75em';
      }
      const classes: string[] = [];
      // Secondary-text provenance: colour changed/added/transcluded syllables.
      const prov = t.source && t.source !== 'parent-link' ? t.source : undefined;
      if (prov) {
        style.color = PROVENANCE_COLOR[prov];
      }
      if (searchHit) {
        style.backgroundColor = isCurrentSearchHit ? '#fb923c' : '#fde68a';
        style.color = '#1f2937';  // search highlight wins over provenance colour
      }
      if (corrected) {
        // Applied correction: amber dotted underline; original shown on hover.
        style.borderBottom = '1.5px dotted #D85C1B';
      } else if (note) {
        style.borderBottom = '1.5px dashed #A28348';
      }
      const title = corrected
        ? (t.inserted
            ? `inserted: "${t.text}"`
            : `was: "${(t.original ?? '').replace(/\n/g, ' ')}"`)
        : prov
          ? (prov === 'override' && t.original
              ? `${PROVENANCE_TITLE[prov]} (was: "${t.original.replace(/\n/g, ' ')}")`
              : PROVENANCE_TITLE[prov])
          : undefined;
      const onAnnClick = anns.length > 0 && !consultMode
        ? (e: React.MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setEditError(null);
            if (anns.length === 1) {
              setAnnPicker(null);
              setEditTarget({ span: anns[0], anchor: rect });
            } else {
              setEditTarget(null);
              setAnnPicker({ anns, anchor: rect });
            }
          }
        : undefined;
      const onAnnMouseEnter = anns.length > 0
        ? (e: React.MouseEvent<HTMLSpanElement>) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setHoverPopover({ tags: anns.map(x => x.tag), anchorRect: rect });
          }
        : undefined;
      const onAnnMouseLeave = anns.length > 0
        ? () => setHoverPopover(null)
        : undefined;
      if (anns.length > 0 && !consultMode) classes.push('cursor-pointer');
      out.push(
        <span
          key={`t-${t.idx}`}
          data-syl-id={t.id}
          data-ro={t.start_offset}
          data-reo={t.end_offset}
          {...(t.inserted ? { 'data-inserted': '' } : {})}
          className={classes.join(' ')}
          style={style}
          title={title}
          onClick={onAnnClick}
          onMouseEnter={onAnnMouseEnter}
          onMouseLeave={onAnnMouseLeave}
        >
          {t.text}
        </span>,
      );
    }
    passagesByAnchor.atEnd.forEach(renderPassage);
    renderHairlinesAt(segment.end);
    return out;
  }, [segment, visibleAnnotations, sessionOpenHairlines, searchMatchesInSegment, currentSearchMatch, consultMode, passagesByAnchor]);

  const handleMouseUp = () => {
    // In session mode, the pane-level handler in TaggerPane takes over so it
    // can capture cross-card selections. Skip the per-card handler entirely.
    if (sessionMode) return;
    setTimeout(() => {
      if (!textRef.current) return;
      // Token-based selection: absolute raw offsets already snapped to whole
      // syllables (the token spans are the snap units).
      const result = readTokenSelection(textRef.current);
      if (!result) {
        setSelection(null);
        return;
      }
      const { start, end, startSylId, endSylId, rect } = result;
      // Priority 1: a tree node is being renamed RIGHT NOW — append the
      // selection to its rename input.
      if (editingAppend) {
        const text = currentText.raw_text.substring(start, end);
        if (text) editingAppend(text);
        setSelection({ start, end, startSylId, endSylId, rect });
        return;
      }
      // Priority 2: auto-fill an "active" tree node's title with the selected
      // text, but only when its title is a placeholder.
      if (activeNodeId != null) {
        const target = nodes.find(n => n.id === activeNodeId);
        const PLACEHOLDERS = new Set(['', 'New section']);
        const isPlaceholder = !target?.title || PLACEHOLDERS.has(target.title.trim());
        if (target && isPlaceholder) {
          const text = currentText.raw_text.substring(start, end).trim();
          if (text) {
            updateNode(activeNodeId, { title: text }).catch(() => { /* surfaced via store error */ });
            setActiveNode(null);
            const el = document.querySelector(`[data-node-id="${activeNodeId}"]`) as HTMLElement | null;
            if (el) {
              el.classList.remove('link-pulse');
              void el.offsetWidth;
              el.classList.add('link-pulse');
              setTimeout(() => el.classList.remove('link-pulse'), 1200);
            }
          }
        }
      }
      setSelection({ start, end, startSylId, endSylId, rect });
    }, 0);
  };

  const clearSelection = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  // When "place a passage" is armed, a click on a syllable that is downstream of the
  // source selection links the passage there. The anchor is addressed by syllable uuid;
  // `data-ro` (start offset) is only a frontend aid to enforce "downstream".
  const handlePlacePassageClick = (e: React.MouseEvent) => {
    if (!pendingPassageSource) return;
    const el = (e.target as HTMLElement).closest('[data-syl-id]') as HTMLElement | null;
    if (!el) return;
    const anchorSylId = el.dataset.sylId!;
    const anchorStart = Number(el.dataset.ro ?? NaN);
    // Only real host syllables carry data-ro; ignore clicks on inline passage runs etc.
    if (Number.isNaN(anchorStart)) return;
    if (anchorStart < pendingPassageSource.endOffset) {
      // Upstream of the source — passages are always placed downstream. Ignore the click.
      return;
    }
    addPassage(currentText.id, {
      anchor_syl_id: anchorSylId,
      members: [{
        src_start_syl_id: pendingPassageSource.startSylId,
        src_end_syl_id: pendingPassageSource.endSylId,
      }],
    }).catch(() => { /* surfaced by the store */ });
    setPendingPassageSource(null);
  };

  // Default title when promoting a segment that's been unnamed — use the first
  // ~30 chars of segment text, trimmed, so the new node has a readable label.
  const defaultSegmentTitle = (): string => {
    const t = segment.text.trim();
    if (!t) return 'Section';
    return t.length > 30 ? t.slice(0, 30).trim() + '…' : t;
  };

  const handlePromote = async () => {
    try {
      await createNode(currentText.id, {
        parent_id: null,
        segment_start: segment.start,
      });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleLinkToNode = async (nodeId: number) => {
    setLinkError(null);
    try {
      await updateNode(nodeId, { segment_start: segment.start });
      setLinkPickerOpen(false);
    } catch (e: any) {
      setLinkError(e.message || 'Could not link');
    }
  };

  // Candidate tree nodes for linking: free-form ones not already pointing at
  // a segment. Sort by title for predictable picker UX.
  const linkCandidates = useMemo(
    () =>
      nodes
        .filter(n => n.segment_start === null)
        .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [nodes],
  );

  const handleUnlink = async () => {
    if (!linkedNode) return;
    const label = linkedNode.title?.trim() || `#${linkedNode.id}`;
    if (!confirm(`Unlink this segment from tree node "${label}"? The node will stay in the tree.`)) return;
    // If the node has no explicit title, give it one before clearing the link
    // (CHECK constraint: title or segment_start must be non-null).
    const params: { segment_start: null; title?: string } = { segment_start: null };
    if (!linkedNode.title?.trim()) {
      params.title = defaultSegmentTitle();
    }
    try {
      await updateNode(linkedNode.id, params);
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Candidate tags for re-tagging the annotation the user is currently editing
  // (every tag except the current one — no type filter anymore).
  const tagChangeCandidates = useMemo(() => {
    const t = editTarget?.span.tag;
    if (!t) return [];
    return tags.filter(x => x.id !== t.id);
  }, [tags, editTarget]);

  const handleChangeTag = async (targetSpanId: number, newTagId: number) => {
    setEditError(null);
    try {
      await updateSpan(targetSpanId, newTagId);
      setEditTarget(null);
    } catch (e: any) {
      setEditError(e.message || 'Could not change tag');
    }
  };

  const handleRemoveTag = async (targetSpan: Span) => {
    try {
      // Session "pseudo-spans" (synthesized from paired session tags for
      // rendering) have a negative id. Route those through deleteTag, which
      // wipes the open/close markers in one step.
      if (targetSpan.id < 0) {
        await deleteTag(targetSpan.tag.id);
      } else {
        await deleteSpan(targetSpan.id);
      }
      setEditTarget(null);
    } catch (e: any) {
      setEditError(e.message || 'Could not remove tag');
    }
  };

  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
      {...linkProps}
      style={{
        ...linkStyle,
        border: '1px solid var(--cline)',
        boxShadow: '0 16px 40px -22px rgba(7,27,56,0.35)',
      }}
      className="relative group rounded-md mb-2 bg-cream-hi transition-shadow hover:shadow-sky-hi"
    >
      {/* Header — clickable when linked: scrolls partner tree node into view */}
      <div
        className={`flex items-center justify-between px-3 py-1.5 ${
          linkedNode ? 'cursor-pointer hover:bg-cream' : ''
        }`}
        style={{ borderBottom: '1px solid var(--cline)' }}
        onClick={() => {
          if (!linkedNode) return;
          setFocused(linkKey);
          scrollToLinkPartner(linkKey, rootRef.current);
        }}
        title={linkedNode ? 'Click to find the linked tree node' : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {linkedNode && (
            sessionMode || consultMode ? (
              <span
                className="flex items-center gap-1 text-[10px] text-bronze px-1 py-0.5 truncate"
                title={`Linked to tree node "${linkedNode.title || `#${linkedNode.id}`}" (read-only in this mode)`}
              >
                <Link2 size={10} />
                tree: {linkedNode.title || `#${linkedNode.id}`}
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleUnlink(); }}
                className="flex items-center gap-1 text-[10px] text-ink-soft hover:text-vermilion-deep hover:bg-vermilion/10 rounded px-1 py-0.5 truncate"
                title={`Click to unlink this segment from tree node "${linkedNode.title || `#${linkedNode.id}`}"`}
              >
                <Link2 size={10} />
                tree: {linkedNode.title || `#${linkedNode.id}`}
              </button>
            )
          )}
          <span className="text-[10px] text-bronze font-mono">
            {segment.start}–{segment.end}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!sessionMode && !consultMode && !linkedNode && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); handlePromote(); }}
                className="text-[11px] px-2 py-0.5 text-bronze hover:text-vermilion hover:bg-cream rounded"
                title="Create a tree node linked to this segment"
              >
                <GitBranchPlus size={12} className="inline mr-1" />
                Promote
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLinkError(null); setLinkPickerOpen(true); }}
                className="text-[11px] px-2 py-0.5 text-bronze hover:text-lapis hover:bg-cream rounded"
                title="Link this segment to an existing free-form tree node"
              >
                <Link size={12} className="inline mr-1" />
                Link…
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-3" onMouseUp={handleMouseUp} onClick={handlePlacePassageClick}>
        {/* The textRef container wraps ONLY the text content (no UI) so selection offsets match. */}
        <div
          ref={textRef}
          className={`tibetan-text whitespace-pre-wrap break-words text-ink select-text ${pendingPassageSource ? 'cursor-crosshair' : 'cursor-text'}`}
          style={{ fontSize: `${taggerFontSize}rem` }}
          data-text-container
          data-segment-start={segment.start}
          data-segment-end={segment.end}
        >
          {fragments}
        </div>
      </div>

      {hoverPopover && (
        <HoverTagPopover tags={hoverPopover.tags} anchorRect={hoverPopover.anchorRect} />
      )}

      {selection && (
        <SegmentTagPopover
          segment={segment}
          selection={selection}
          onClose={clearSelection}
        />
      )}

      {(editTarget || annPicker) && createPortal(
        (() => {
          const anchor = editTarget?.anchor ?? annPicker?.anchor;
          if (!anchor) return null;
          const PW = 240;
          const left = Math.max(8, Math.min(window.innerWidth - PW - 8, anchor.left));
          const top = anchor.bottom + 6;
          const close = () => { setEditTarget(null); setAnnPicker(null); setEditError(null); };
          const editTag = editTarget?.span.tag;
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={close} />
              <div
                className="fixed z-50 bg-cream-hi shadow-xl rounded-lg p-2 flex flex-col"
                style={{ top, left, width: PW, border: '1px solid var(--cline)' }}
                onClick={(e) => e.stopPropagation()}
              >
                {editTarget && editTag ? (
                  <>
                    <div className="flex items-center justify-between px-1 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: editTag.color }}
                        />
                        <span className="text-xs font-medium text-ink truncate" title={editTag.name}>
                          {editTag.name}
                        </span>
                      </div>
                      <button onClick={close} className="p-0.5 text-bronze hover:text-vermilion-deep shrink-0">
                        <X size={12} />
                      </button>
                    </div>

                    {editError && (
                      <p className="text-[11px] text-vermilion-deep mx-1 mb-1">{editError}</p>
                    )}

                    {/* Session pseudo-spans (negative id) can't change tag — they're tied to their session tag. Hide the change-to list. */}
                    {editTarget.span.id >= 0 && (
                      <>
                        <div className="text-[10px] font-medium text-bronze px-1 mt-1 mb-0.5 uppercase tracking-wider">
                          Change to
                        </div>
                        {tagChangeCandidates.length === 0 ? (
                          <p className="text-[11px] text-ink-soft italic px-1 py-1">
                            No other tags available.
                          </p>
                        ) : (
                          <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                            {tagChangeCandidates.map(t => (
                              <li key={t.id}>
                                <button
                                  onClick={() => handleChangeTag(editTarget.span.id, t.id)}
                                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-cream flex items-center gap-2"
                                >
                                  <span
                                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                                    style={{ backgroundColor: t.color }}
                                  />
                                  <span className="truncate">{t.name}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}

                    <div className="my-1.5" style={{ borderTop: '1px solid var(--cline)' }} />
                    <button
                      onClick={() => handleRemoveTag(editTarget.span)}
                      className="w-full text-left text-xs px-2 py-1.5 rounded text-vermilion-deep hover:bg-vermilion/10 flex items-center gap-2"
                    >
                      <Trash2 size={12} /> Remove tag
                    </button>
                  </>
                ) : annPicker && (
                  <>
                    <div className="flex items-center justify-between px-1 mb-1">
                      <span className="text-xs font-medium text-ink">
                        Pick an annotation
                      </span>
                      <button onClick={close} className="p-0.5 text-bronze hover:text-vermilion-deep">
                        <X size={12} />
                      </button>
                    </div>
                    <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                      {annPicker.anns.map(a => (
                        <li key={a.id}>
                          <button
                            onClick={() => {
                              setEditError(null);
                              setEditTarget({ span: a, anchor: annPicker.anchor });
                              setAnnPicker(null);
                            }}
                            className="w-full text-left text-xs px-2 py-1 rounded hover:bg-cream flex items-center gap-2"
                          >
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: a.tag.color }}
                            />
                            <span className="truncate">{a.tag.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          );
        })(),
        document.body,
      )}

      {linkPickerOpen && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setLinkPickerOpen(false)} />
          <div
            className="fixed z-50 bg-cream-hi shadow-xl rounded-xl p-3 w-80 max-h-96 overflow-hidden flex flex-col"
            style={{ top: '20%', left: '50%', transform: 'translateX(-50%)', border: '1px solid var(--cline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h4 className="font-display text-base text-lapis">
                Link to free-form tree node
              </h4>
              <button onClick={() => setLinkPickerOpen(false)} className="p-1 text-bronze hover:text-vermilion-deep">
                <X size={14} />
              </button>
            </div>
            {linkError && (
              <p className="text-xs text-vermilion-deep mb-2 shrink-0">{linkError}</p>
            )}
            {linkCandidates.length === 0 ? (
              <p className="text-xs text-ink-soft italic">
                No free-form tree nodes available. Create one in the tree pane first.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 overflow-y-auto">
                {linkCandidates.map(n => (
                  <li key={n.id}>
                    <button
                      onClick={() => handleLinkToNode(n.id)}
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
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};
