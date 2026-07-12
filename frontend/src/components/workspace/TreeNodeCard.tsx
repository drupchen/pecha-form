import React, { useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight, ChevronDown, MoreVertical, Trash2, Edit2,
  ArrowUp, ArrowDown, Indent, Outdent, Plus, EyeOff, Eye, Unlink,
} from 'lucide-react';
import type { NestedTreeNode } from '../../store/useTreeNodeStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTextStore } from '../../store/useTextStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useLinkStore, scrollToLinkPartner } from '../../store/useLinkStore';
import { useUIStore } from '../../store/useUIStore';
import { SiblingInsertSlot } from './SiblingInsertSlot';
import { TreeConsultContext } from './treeConsult';

// Per-indent-level accent palette. Each depth picks the next color; past the
// last entry we loop. Tailwind 300-shade hues — bright enough to distinguish
// levels, muted enough to read as a "grayed thick line".
const INDENT_COLORS = [
  '#fca5a5', // red-300
  '#fdba74', // orange-300
  '#fcd34d', // amber-300
  '#bef264', // lime-300
  '#86efac', // green-300
  '#67e8f9', // cyan-300
  '#7dd3fc', // sky-300
  '#93c5fd', // lapis-light (replaces indigo-300)
  '#c4b5fd', // violet-300
  '#f9a8d4', // pink-300
];
const indentColor = (depth: number) => INDENT_COLORS[depth % INDENT_COLORS.length];

// Spreadsheet-style letters for the level identifier: 0→A … 25→Z, 26→AA, …
const toLetters = (i: number): string => {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

// Identifier components are colored by type so a shared component (e.g. the `2`
// in parent `B.2` and child `2.A`) reads as the same element across levels.
const componentColorClass = (s: string): string =>
  /^\d+$/.test(s) ? 'text-amber-robe' : 'text-azure-soft';

// Neutral accent used for the link-overlay hover ring (not the accent strip).
const LINK_COLOR = '#A28348';

interface Props {
  node: NestedTreeNode;
  parentChildren: NestedTreeNode[]; // siblings (including self), in order
  parentNode: NestedTreeNode | null; // null at root
  grandparentNode: NestedTreeNode | null; // null when parent is at root or null
  depth: number;
  parentComponent: string | null; // parent's own level identifier (null at root)
}

export const TreeNodeCard: React.FC<Props> = ({
  node, parentChildren, parentNode, grandparentNode, depth, parentComponent,
}) => {
  const { currentText } = useTextStore();
  const markers = useMarkerStore(s => s.markers);
  const setHovered = useLinkStore(s => s.setHovered);
  const hoveredKey = useLinkStore(s => s.hoveredKey);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult') || useContext(TreeConsultContext);
  // An INHERITED section is read-only here — edit the sapche on its owning text.
  const readOnly = sessionMode || consultMode || !!node.inherited;
  const { updateNode, moveNode, deleteNode, createNode } = useTreeNodeStore();
  const activeNodeId = useTreeNodeStore(s => s.activeNodeId);
  const setActiveNode = useTreeNodeStore(s => s.setActiveNode);
  const setEditingAppend = useTreeNodeStore(s => s.setEditingAppend);

  // Open/closed state lives in useUIStore so the global collapse/expand-all
  // button can flip every node at once while still letting the user toggle
  // any individual one. Default is OPEN (nodes not in the set).
  const isOpen = !useUIStore(s => s.collapsedTreeNodeIds.has(node.id));
  const toggleNodeCollapse = useUIStore(s => s.toggleNodeCollapse);
  const expandNode = useUIStore(s => s.expandNode);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title || '');

  // While renaming, register an append closure so a tagger selection lands
  // in the rename input instead of triggering the active-node auto-fill.
  useEffect(() => {
    if (!isRenaming) return;
    setEditingAppend((text: string) => setRenameValue(v => v + text));
    return () => setEditingAppend(null);
  }, [isRenaming, setEditingAppend]);

  // Linked iff the node has a segment_start offset (and that offset is still
  // within the document — orphan links are silently treated as not-linked
  // when the segment can't be found, but the accent strip stays on so the
  // user knows the link metadata is there). A node may instead link a PASSAGE
  // occurrence (node.passage_id) — its own standalone card in the tagger.
  const isLinked = node.segment_start != null || node.passage_id != null;
  // Cross-pane link key: segment offset, or the passage key space (negative id).
  const linkKey: number | null =
    node.segment_start ?? (node.passage_id != null ? -node.passage_id : null);
  // Compute the segment_end for preview: next marker after segment_start, or
  // raw_text.length if there is no later marker.
  const segmentRange: [number, number] | null = (() => {
    if (node.segment_start == null || !currentText) return null;
    const start = node.segment_start;
    let end = currentText.raw_text.length;
    for (const m of markers) {
      if (m.position > start && m.position < end) end = m.position;
    }
    return [start, end];
  })();

  const displayTitle = node.title?.trim() || '(untitled)';
  const titleIsPlaceholder = !node.title?.trim();

  const hasChildren = node.children.length > 0;
  const idx = parentChildren.findIndex(c => c.id === node.id);

  // Alternating level identifier: numbers at even depths, letters at odd depths.
  // Label = parent's own component + this node's own component (max two parts);
  // roots show just `N.`.
  const ownComponent = depth % 2 === 0 ? String(idx + 1) : toLetters(idx);
  const canMoveUp = idx > 0;
  const canMoveDown = idx >= 0 && idx < parentChildren.length - 1;
  const canIndent = idx > 0; // a previous sibling exists to nest under
  const canOutdent = parentNode !== null; // not at the root

  const docId = currentText!.id;

  const handleRenameSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = renameValue.trim() || null;
    if (next !== node.title) {
      // Don't allow clearing title for a free-form node — the API will reject anyway.
      if (next === null && node.segment_start === null) {
        setRenameValue(node.title || '');
      } else {
        try { await updateNode(node.id, { title: next }); } catch {}
      }
    }
    setIsRenaming(false);
    // Manual rename retires the auto-fill target.
    if (activeNodeId === node.id) setActiveNode(null);
  };

  const handleMoveUp = async () => {
    if (!canMoveUp) return;
    await moveNode(node.id, node.parent_id, node.position - 1);
  };
  const handleMoveDown = async () => {
    if (!canMoveDown) return;
    await moveNode(node.id, node.parent_id, node.position + 1);
  };

  const handleIndent = async () => {
    if (!canIndent) return;
    const prev = parentChildren[idx - 1];
    // Move to end of prev sibling's children.
    await moveNode(node.id, prev.id, prev.children.length);
  };

  const handleOutdent = async () => {
    if (!canOutdent || !parentNode) return;
    // Move to immediately after parent in grandparent's children.
    const newParentId = grandparentNode ? grandparentNode.id : null;
    await moveNode(node.id, newParentId, parentNode.position + 1);
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (isLinked) {
      if (!confirm('This node is linked to a text segment. Delete it anyway? (The segment text stays.)')) return;
    }
    try { await deleteNode(node.id, 'promote'); } catch (e: any) { alert(e.message); }
  };

  const handleAddChild = async () => {
    setMenuOpen(false);
    try {
      const child = await createNode(docId, { parent_id: node.id, title: 'New section' });
      setActiveNode(child.id);
      expandNode(node.id);
    } catch (e: any) { alert(e.message); }
  };

  const handleToggleTransparent = async () => {
    setMenuOpen(false);
    try { await updateNode(node.id, { transparent: !node.transparent }); } catch {}
  };

  // Release the node from whatever it links (a segment, or a passage occurrence).
  // Works even when the linked segment no longer exists (e.g. its marker was removed),
  // which strands the node with no segment-side "tree:" badge to click.
  const handleUnlinkSegment = async () => {
    setMenuOpen(false);
    try {
      if (node.passage_id != null) {
        await updateNode(node.id, { passage_id: null });
        return;
      }
      // CHECK constraint: title OR segment_start_syl_id must stay non-null — give an
      // untitled (segment-derived) node a concrete title before clearing the link.
      const params: { segment_start: null; title?: string } = { segment_start: null };
      if (!node.title?.trim()) params.title = displayTitle;
      await updateNode(node.id, params);
    } catch (e: any) { alert(e.message); }
  };

  // The ⋯ menu is portaled with fixed positioning, so close it on any scroll so it can
  // never visually detach from its trigger (capture phase catches the scrolling pane too).
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [menuOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) handleOutdent();
      else handleIndent();
    }
  };

  // Link-overlay wiring: linked nodes participate. The link key is the segment_start
  // offset, or the passage key space (-passage_id) for passage-linked nodes.
  const isLinkHovered = linkKey != null && hoveredKey === linkKey;
  const isActive = activeNodeId === node.id;
  const lastHoveredTreeNodeId = useUIStore(s => s.lastHoveredTreeNodeId);
  const setLastHoveredTreeNodeId = useUIStore(s => s.setLastHoveredTreeNodeId);
  const selectedTreeNodeId = useUIStore(s => s.selectedTreeNodeId);
  const setSelectedTreeNodeId = useUIStore(s => s.setSelectedTreeNodeId);
  // The band follows `lastHoveredTreeNodeId` — it moves on arrow nav and
  // on body click. The persistent SELECTION (inside overlay + boundary
  // outline) follows `selectedTreeNodeId` — it only changes on body click,
  // so arrow nav can wander while the user keeps their anchor.
  const isLastHovered = lastHoveredTreeNodeId === node.id;
  const isSelected = selectedTreeNodeId === node.id;
  // `isBodyHovered` gates the action overlay and the resize handle. No
  // dwell timer anymore — selection happens via explicit click only.
  const [isBodyHovered, setIsBodyHovered] = useState(false);
  const onBodyMouseEnter = () => setIsBodyHovered(true);
  const onBodyMouseLeave = () => setIsBodyHovered(false);
  /** Body click: set BOTH the selection anchor and the band position to
   *  this node. In session mode, also scroll the tagger to this node's
   *  linked segment (falling through DFS to the first linked descendant
   *  when this node itself isn't linked). */
  const findFirstLinkedSegmentStart = (n: NestedTreeNode): number | null => {
    if (n.segment_start != null) return n.segment_start;
    if (n.passage_id != null) return -n.passage_id;  // passage key space
    for (const c of n.children) {
      const found = findFirstLinkedSegmentStart(c);
      if (found != null) return found;
    }
    return null;
  };
  const onBodyClick = () => {
    setLastHoveredTreeNodeId(node.id);
    setSelectedTreeNodeId(node.id);
    if (sessionMode) {
      const target = findFirstLinkedSegmentStart(node);
      if (target != null) scrollToLinkPartner(target, rootRef.current);
    }
  };
  const linkProps: Record<string, any> = {
    'data-node-id': node.id,
    'data-node-depth': depth,
    onMouseEnter: () => {
      if (linkKey != null) setHovered(linkKey);
    },
    onMouseLeave: () => {
      if (linkKey != null) setHovered(null);
    },
  };
  if (linkKey != null) {
    linkProps['data-link-key'] = linkKey;
  }
  // Active state takes precedence visually: indigo ring signals "selecting
  // text in the tagger will auto-fill this node's title". Last-hovered is a
  // softer slate ring as a sticky breadcrumb.
  const treeNodeWidth = useUIStore(s => s.treeNodeWidth);
  const maxTreeDepth = useUIStore(s => s.maxTreeDepth);
  const setTreeNodeWidth = useUIStore(s => s.setTreeNodeWidth);
  const linkStyle: React.CSSProperties = {
    ['--link-color' as any]: LINK_COLOR,
    width: treeNodeWidth,
    ...(isActive
      ? { boxShadow: '0 0 0 2px rgba(18, 59, 115, 0.65)' }
      : isLinkHovered
        ? { boxShadow: `0 0 0 2px ${LINK_COLOR}`, backgroundColor: `${LINK_COLOR}1f` }
        : isSelected
          ? {
              // SELECTED anchor: inside azure-glow tint + lapis boundary outline.
              // This survives arrow navigation (only changes on body click)
              // so the user can always find their anchor. The full-width
              // band (a separate DOM element above) tracks `lastHovered`,
              // which moves with nav.
              backgroundColor: 'rgba(14, 92, 158, 0.30)', // azure-glow @ 30%
              boxShadow: '0 0 0 1.5px rgba(18, 59, 115, 0.65)', // lapis outline
            }
          : {}),
  };

  // Drag-resize handle: pressing on the right-edge strip and dragging changes
  // the shared treeNodeWidth so all cards resize together.
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = treeNodeWidth;
    const onMove = (ev: MouseEvent) => {
      setTreeNodeWidth(startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const rootRef = React.useRef<HTMLDivElement>(null);

  // In consult mode the title's native tooltip should only appear when the box
  // is too narrow to show the full text. `truncate` clips to a single line, so
  // scrollWidth > clientWidth detects exactly that. Re-measured on hover.
  const titleRef = React.useRef<HTMLButtonElement>(null);
  const [titleTruncated, setTitleTruncated] = useState(false);
  const checkTitleOverflow = () => {
    const el = titleRef.current;
    if (el) setTitleTruncated(el.scrollWidth > el.clientWidth);
  };

  // Same-level navigation: prev/next sibling among parentChildren, with a
  // fallback to `parentNode` when at a boundary. Children are never entered.
  // null targets disable the corresponding arrow.
  const myIdx = parentChildren.findIndex(c => c.id === node.id);
  const prevSibling = myIdx > 0 ? parentChildren[myIdx - 1] : null;
  const nextSibling = myIdx >= 0 && myIdx < parentChildren.length - 1 ? parentChildren[myIdx + 1] : null;
  const prevTarget = prevSibling ?? parentNode;
  const nextTarget = nextSibling ?? parentNode;

  /** Arrow-navigation: scroll to the target AND make it the new selected
   *  node so the yellow band follows the navigation. */
  const navigateTo = (target: NestedTreeNode) => {
    setLastHoveredTreeNodeId(target.id);
    const el = document.querySelector<HTMLElement>(`[data-node-id="${target.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div>
      {/* Card-row wrapper. The selected-node band lives here as a
          full-width absolutely-positioned sibling drawn behind the card,
          so hovering the card can change its inner styling without
          hiding the band. */}
      <div className="relative">
        {isLastHovered && (() => {
          // Stretch the band to a little past the rightmost node in the
          // tree. A card at depth `d` has its left edge at the wrapper's
          // origin; the deepest card's right edge sits `16 * (maxDepth - d)`
          // px further right plus the shared `treeNodeWidth`. Add a small
          // margin so the band doesn't end exactly flush with the deepest
          // card's edge.
          const RIGHT_MARGIN = 16;
          const LEFT_EXTEND = 2000; // way more than enough; clipped by overflow
          const distanceToDeepestRight =
            Math.max(0, maxTreeDepth - depth) * 16 + treeNodeWidth + RIGHT_MARGIN;
          return (
            <div
              aria-hidden
              className="absolute pointer-events-none"
              style={{
                left: -LEFT_EXTEND,
                top: -4,
                bottom: -4,
                width: LEFT_EXTEND + distanceToDeepestRight,
                backgroundColor: 'rgba(14, 92, 158, 0.45)', // azure-glow @ 45%
              }}
            />
          );
        })()}
        <div
          ref={rootRef}
          {...linkProps}
          style={{
            ...linkStyle,
            // Card recipe per guidelines: cream-hi → cream gradient, bronze
            // hairline, soft blue-cast shadow. Unlinked nodes get a dashed
            // bronze hairline and a flatter cream surface to read as
            // "placeholder".
            background: isLinked
              ? 'linear-gradient(180deg, var(--cream-hi), var(--cream))'
              : 'var(--cream)',
            border: isLinked ? '1px solid var(--cline)' : '1px dashed var(--cline)',
            boxShadow: isLinked ? '0 14px 32px -22px rgba(7,27,56,0.35)' : 'none',
          }}
          className={`relative group flex items-stretch rounded-md transition-shadow mb-1 ${
            node.transparent ? 'opacity-50' : 'hover:shadow-sky-hi'
          }`}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
        {/* Accent bar — color encodes indent depth. Clickable when linked.
            The container is wider than the visible strip so hovering the gutter
            to its left also reveals the "jump to previous same-depth node"
            up-arrow. */}
        <div
          className={`relative group/accent w-1.5 rounded-l-md shrink-0 ${isLinked ? 'cursor-pointer' : ''}`}
          style={{ backgroundColor: indentColor(depth) }}
          onClick={() => {
            if (linkKey != null) scrollToLinkPartner(linkKey, rootRef.current);
          }}
          title={isLinked ? 'Click to find the linked tagger segment' : undefined}
        >
          {/* Horizontal hover zone in the indent gutter. Catches hover even
              in the small gap between the two arrow buttons so the pills
              stay visible while moving the cursor between them. */}
          <div className="absolute -left-[44px] top-0 bottom-0 w-12" />
          {/* Up arrow (prev sibling, or parent if first). The CLICK ZONE
              spans the upper half of the card vertically (top-0 → bottom-1/2)
              while the visible pill stays small and sits at the bottom of
              that zone, near the card's vertical centre. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (prevTarget) navigateTo(prevTarget); }}
            disabled={!prevTarget}
            className="group/upbtn absolute -left-[42px] top-0 bottom-1/2 w-5 flex items-end justify-center disabled:cursor-not-allowed"
            title={prevTarget ? `↑ ${prevTarget.title || 'previous node'}` : '↑ (already at the first node at this level)'}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center bg-cream opacity-0 group-hover/accent:opacity-100 shadow-sm transition-opacity ${prevTarget ? 'text-ink group-hover/upbtn:text-vermilion' : 'text-bronze'}`} style={{ border: '1px solid var(--cline)' }}>
              <ArrowUp size={12} />
            </span>
          </button>
          {/* Down arrow (next sibling, or parent if last). CLICK ZONE
              spans the lower half (top-1/2 → bottom-0); visible pill at the
              top of that zone, near the centre. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (nextTarget) navigateTo(nextTarget); }}
            disabled={!nextTarget}
            className="group/downbtn absolute -left-[20px] top-1/2 bottom-0 w-5 flex items-start justify-center disabled:cursor-not-allowed"
            title={nextTarget ? `↓ ${nextTarget.title || 'next node'}` : '↓ (already at the last node at this level)'}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center bg-cream opacity-0 group-hover/accent:opacity-100 shadow-sm transition-opacity ${nextTarget ? 'text-ink group-hover/downbtn:text-vermilion' : 'text-bronze'}`} style={{ border: '1px solid var(--cline)' }}>
              <ArrowDown size={12} />
            </span>
          </button>
        </div>

        {/* Toggle chevron */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleNodeCollapse(node.id); }}
          className="px-1 py-2 text-bronze hover:text-lapis shrink-0"
          title={hasChildren ? (isOpen ? 'Collapse' : 'Expand') : ''}
        >
          {hasChildren
            ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
            : <span className="w-[14px] inline-block" />}
        </button>

        {/* Alternating level identifier (e.g. 1.A, A.1) — marks the indent depth. */}
        <span className="self-center shrink-0 select-none font-mono text-[11px] pr-1.5">
          {parentComponent != null && (
            <span className={componentColorClass(parentComponent)}>{parentComponent}</span>
          )}
          {parentComponent != null && <span className="text-bronze">.</span>}
          <span className={componentColorClass(ownComponent)}>{ownComponent}</span>
          {parentComponent == null && <span className="text-bronze">.</span>}
        </span>

        {/* Content — the "main body" zone. Hovering this region (and ONLY
            this region; not the chevron, nav arrows, or resize handle) is
            what triggers the dwell timer + the action overlay + the resize
            handle's visibility. The overlay and resize handle live INSIDE
            this div so the mouse can transition from text → control without
            crossing back through a non-body area (which would flicker the
            hover state). */}
        <div
          className={`relative flex-1 min-w-0 py-1.5 pr-2 ${sessionMode ? 'cursor-pointer' : ''}`}
          onMouseEnter={onBodyMouseEnter}
          onMouseLeave={onBodyMouseLeave}
          onClick={onBodyClick}
        >
          {isRenaming ? (
            <form onSubmit={handleRenameSubmit} onClick={e => e.stopPropagation()}>
              <input
                type="text"
                autoFocus
                className="w-full text-sm bg-white border border-gold rounded px-1.5 py-0.5 font-display"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setRenameValue(node.title || '');
                    setIsRenaming(false);
                  }
                }}
              />
            </form>
          ) : (
            <button
              ref={titleRef}
              onMouseEnter={checkTitleOverflow}
              className={`text-left tibetan-text-sm font-display w-full truncate ${
                titleIsPlaceholder ? 'text-ink-soft italic' : 'text-lapis font-medium'
              } ${consultMode ? (segmentRange ? 'cursor-pointer' : 'cursor-default') : (readOnly ? 'cursor-default' : '')}`}
              style={{ fontSize: '17px' }}
              onClick={() => {
                if (consultMode) {
                  if (segmentRange) scrollToLinkPartner(segmentRange[0], rootRef.current);
                  return;
                }
                if (readOnly) return;
                setRenameValue(node.title || '');
                setIsRenaming(true);
                setActiveNode(node.id);
              }}
              title={consultMode ? (titleTruncated ? displayTitle : undefined) : displayTitle}
            >
              {displayTitle}
            </button>
          )}
          {segmentRange && !node.transparent && !sessionMode && !consultMode && (
            <PreviewText
              spanText={currentText!.raw_text.substring(segmentRange[0], segmentRange[1])}
              color="#A28348cc"
              onScroll={(e) => {
                e.stopPropagation();
                scrollToLinkPartner(segmentRange[0], rootRef.current);
              }}
            />
          )}

        {/* Action buttons — overlay the content area on hover so they don't
            steal horizontal space from the preview text. Hidden entirely in
            session mode and consult mode (both are read-only for the tree). */}
        <div
          className={`absolute top-1 right-1 z-10 flex items-start ${readOnly ? 'hidden' : (isBodyHovered ? 'opacity-100' : 'opacity-0')} transition-opacity bg-cream-hi/95 backdrop-blur-sm rounded shadow-sm`}
          style={{ border: '1px solid var(--cline)' }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); handleMoveUp(); }}
            disabled={!canMoveUp}
            className="p-1 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze transition-colors"
            title="Move up"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleMoveDown(); }}
            disabled={!canMoveDown}
            className="p-1 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze transition-colors"
            title="Move down"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleOutdent(); }}
            disabled={!canOutdent}
            className="p-1 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze transition-colors"
            title="Outdent (Shift+Tab)"
          >
            <Outdent size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleIndent(); }}
            disabled={!canIndent}
            className="p-1 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze transition-colors"
            title="Indent (Tab)"
          >
            <Indent size={13} />
          </button>

          {/* Three-dot menu */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuRect(e.currentTarget.getBoundingClientRect());
                setMenuOpen(v => !v);
              }}
              className="p-1 text-bronze hover:text-lapis"
              title="Options"
            >
              <MoreVertical size={13} />
            </button>
            {menuOpen && menuRect && createPortal(
              (() => {
                // Fixed position, right-aligned to the button, flipped above / clamped to the
                // viewport so the whole menu is visible without scrolling the tree behind it.
                const MW = 192, MH = 236;
                const left = Math.max(8, Math.min(menuRect.right - MW, window.innerWidth - MW - 8));
                const top = menuRect.bottom + 4 + MH > window.innerHeight
                  ? Math.max(8, menuRect.top - MH - 4)
                  : menuRect.bottom + 4;
                return (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div
                      className="fixed bg-cream-hi shadow-lg rounded py-1 z-50 w-48"
                      style={{ top, left, border: '1px solid var(--cline)' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { setRenameValue(node.title || ''); setIsRenaming(true); setMenuOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-cream flex items-center gap-2"
                      >
                        <Edit2 size={12} /> Rename
                      </button>
                      <button onClick={handleAddChild} className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-cream flex items-center gap-2">
                        <Plus size={12} /> Add child
                      </button>
                      <button onClick={handleToggleTransparent} className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-cream flex items-center gap-2">
                        {node.transparent ? <Eye size={12} /> : <EyeOff size={12} />}
                        {node.transparent ? 'Remove transparent' : 'Mark transparent'}
                      </button>
                      {isLinked && (
                        <button
                          onClick={handleUnlinkSegment}
                          className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-cream flex items-center gap-2"
                          title="Break this node's link (segment or passage) so it can be linked elsewhere"
                        >
                          <Unlink size={12} /> {node.passage_id != null ? 'Unlink from passage' : 'Unlink from segment'}
                        </button>
                      )}
                      <div className="my-1" style={{ borderTop: '1px solid var(--cline)' }} />
                      <button onClick={handleDelete} className="w-full text-left px-3 py-1.5 text-sm text-vermilion-deep hover:bg-vermilion/10 flex items-center gap-2">
                        <Trash2 size={12} /> Delete (promote children)
                      </button>
                    </div>
                  </>
                );
              })(),
              document.body,
            )}
          </div>
        </div>

        </div>

        {/* Right-edge resize handle. Sibling of the body (NOT inside it) so
            hovering the handle doesn't keep the body's action overlay alive.
            Visible while the body is hovered OR the handle itself is hovered.
            Available in all modes (only changes the shared treeNodeWidth UI
            state, not document data). */}
        <div
          onMouseDown={onResizeMouseDown}
          className={`absolute right-0 top-0 bottom-0 w-1.5 rounded-r-md cursor-col-resize ${isBodyHovered ? 'opacity-100' : 'opacity-0 hover:opacity-100'} bg-bronze/60 hover:bg-gold`}
          title="Drag to resize all tree nodes"
        />
      </div>
      </div>

      {/* Children */}
      {hasChildren && isOpen && (
        <div style={{ paddingLeft: 16 }}>
          <SiblingInsertSlot parentId={node.id} position={0} />
          {node.children.map((child, i) => (
            <React.Fragment key={child.id}>
              <TreeNodeCard
                node={child}
                parentChildren={node.children}
                parentNode={node}
                grandparentNode={parentNode}
                depth={depth + 1}
                parentComponent={ownComponent}
              />
              <SiblingInsertSlot parentId={node.id} position={i + 1} />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Linked-text preview rendered under the tree-node title.
 *
 * Truncation: pure CSS `line-clamp: 1`. Previously this used a per-mount
 * binary search against `scrollHeight` to snap the cut to a tsek boundary,
 * which forced ~10–15 synchronous reflows per node — at ~200 linked nodes
 * that compounded into a multi-second stall on document open. The browser's
 * native line-clamp clips at the visible edge in C++ after layout, no JS
 * measurement loop, no ResizeObserver per card.
 */
const PreviewText: React.FC<{
  spanText: string;
  color: string;
  onScroll: (e: React.MouseEvent) => void;
}> = ({ spanText, color, onScroll }) => {
  return (
    <p
      className="tibetan-text-sm mt-0.5 cursor-pointer hover:underline decoration-dotted"
      style={{
        color,
        fontSize: '10px',
        wordBreak: 'break-word',
        display: '-webkit-box',
        WebkitLineClamp: 1,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
      title={spanText + '\n\nClick to scroll to this segment in the tagger.'}
      onClick={onScroll}
    >
      {spanText}
    </p>
  );
};
