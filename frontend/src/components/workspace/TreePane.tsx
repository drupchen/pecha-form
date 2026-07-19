import React, { useEffect, useMemo, useRef } from 'react';
import { Focus, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';
import { useTreeNodeStore, buildNestedTree, type NestedTreeNode } from '../../store/useTreeNodeStore';
import { useUIStore } from '../../store/useUIStore';
import { TreeNodeCard } from './TreeNodeCard';
import { TreeConsultContext } from './treeConsult';
import { AddNodeButton } from './AddNodeButton';
import { SiblingInsertSlot } from './SiblingInsertSlot';

export const TreePane: React.FC<{ forceConsult?: boolean }> = ({ forceConsult = false }) => {
  const currentText = useTextStore(s => s.currentText);
  const nodes = useTreeNodeStore(s => s.nodes);
  const loading = useTreeNodeStore(s => s.loading);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult') || forceConsult;
  const selectedTreeNodeId = useUIStore(s => s.selectedTreeNodeId);
  const setLastHoveredTreeNodeId = useUIStore(s => s.setLastHoveredTreeNodeId);
  const collapsedTreeNodeIds = useUIStore(s => s.collapsedTreeNodeIds);
  const collapseAllTreeNodes = useUIStore(s => s.collapseAllTreeNodes);
  const expandAllTreeNodes = useUIStore(s => s.expandAllTreeNodes);
  const fullscreen = useUIStore(s => s.workspaceFullscreen);

  // Bring a node into view WITHIN this sidebar's own scroll container — never a bare
  // `element.scrollIntoView`, which also scrolls every ancestor (it was jumping the whole
  // view, so the sidebar never appeared to "follow" the content). `force` centres even a
  // visible node (the Focus button); the scroll-spy passes false so it doesn't fight a manual
  // scroll or jitter when the section is already on screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollNodeIntoSidebar = (nodeId: number, force: boolean) => {
    const c = scrollRef.current;
    if (!c) return;
    const el = c.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    if (!el) return;
    const cr = c.getBoundingClientRect(), er = el.getBoundingClientRect();
    const top = er.top - cr.top;
    if (!force && top >= 0 && er.bottom - cr.top <= c.clientHeight) return;   // already visible
    // Manual Focus glides (smooth); the scroll-spy tracks instantly so the band doesn't lag a
    // frame behind the content or fight a smooth animation that restarts on every scroll tick.
    c.scrollTo({ top: c.scrollTop + top - c.clientHeight / 2 + er.height / 2, behavior: force ? 'smooth' : 'auto' });
  };
  const scrollToSelected = () => {
    if (selectedTreeNodeId == null) return;
    // Snap the band back to the selected anchor too, so the user lands on
    // a card that's clearly the one they had picked.
    setLastHoveredTreeNodeId(selectedTreeNodeId);
    scrollNodeIntoSidebar(selectedTreeNodeId, true);
  };
  // Follow the content: whenever the scroll-spy (or a click) moves the selected section, keep
  // it visible in the sidebar. Centralised here so every place that mounts the tree —
  // translate, phonetics, workspace — follows the scroll the same way.
  useEffect(() => {
    if (selectedTreeNodeId == null) return;
    scrollNodeIntoSidebar(selectedTreeNodeId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTreeNodeId]);

  // Toggle: if anything is currently collapsed, expand everything. Otherwise
  // collapse every node that has at least one child (no point collapsing leaves).
  const anyCollapsed = collapsedTreeNodeIds.size > 0;
  const nodeIdsWithChildren = useMemo(() => {
    const haveChildren = new Set<number>();
    for (const n of nodes) if (n.parent_id != null) haveChildren.add(n.parent_id);
    return Array.from(haveChildren);
  }, [nodes]);
  const toggleAll = () => {
    if (anyCollapsed) expandAllTreeNodes();
    else collapseAllTreeNodes(nodeIdsWithChildren);
  };

  const roots = useMemo(() => buildNestedTree(nodes), [nodes]);

  // Track the tree's deepest indent so the selected-node band can stop a
  // little past the rightmost node instead of extending forever.
  const setMaxTreeDepth = useUIStore(s => s.setMaxTreeDepth);
  useEffect(() => {
    const walk = (ns: NestedTreeNode[], d: number): number => {
      let max = d;
      for (const n of ns) max = Math.max(max, walk(n.children, d + 1));
      return max;
    };
    setMaxTreeDepth(roots.length === 0 ? 0 : walk(roots, 0));
  }, [roots, setMaxTreeDepth]);

  if (!currentText) return null;

  return (
    <TreeConsultContext.Provider value={forceConsult}>
    <div className="h-full w-full flex flex-col overflow-hidden bg-cream-hi">
      {!fullscreen && (
        <div
          className="px-4 py-2 bg-cream shrink-0 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <h3 className="font-display text-lg text-lapis">Tree</h3>
          <span className="text-[10px] text-bronze">
            {consultMode
              ? 'read-only — click a section to jump there'
              : 'Tab to indent · Shift+Tab to outdent · click any title to rename'}
          </span>
        </div>
      )}
      <div className="flex-1 relative">
        <div className="absolute top-12 right-12 z-10 flex items-center gap-1">
          <button
            type="button"
            onClick={toggleAll}
            disabled={nodeIdsWithChildren.length === 0}
            className="p-1.5 rounded-md bg-cream-hi/90 backdrop-blur-sm shadow-sm text-bronze hover:text-lapis disabled:opacity-40 disabled:cursor-default transition-colors"
            style={{ border: '1px solid var(--cline)' }}
            title={anyCollapsed ? 'Expand all nodes' : 'Collapse all nodes'}
          >
            {anyCollapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
          </button>
          <button
            type="button"
            onClick={scrollToSelected}
            disabled={selectedTreeNodeId == null}
            className="p-1.5 rounded-md bg-cream-hi/90 backdrop-blur-sm shadow-sm text-bronze hover:text-lapis disabled:opacity-40 disabled:cursor-default transition-colors"
            style={{ border: '1px solid var(--cline)' }}
            title={selectedTreeNodeId == null ? 'No selected node yet' : 'Scroll to the selected node'}
          >
            <Focus size={16} />
          </button>
        </div>
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-auto pt-3 pr-3 pb-3 pl-12 text-sm">
        {loading && nodes.length === 0 ? (
          <p className="text-ink-soft italic">Loading…</p>
        ) : (
          <>
            {roots.length === 0 ? (
              <p className="text-ink-soft italic mb-3">
                Empty tree. Add a section below or tag text in the right pane to start organizing.
              </p>
            ) : (
              <>
                <SiblingInsertSlot parentId={null} position={0} />
                {roots.map((root, i) => (
                  <React.Fragment key={root.id}>
                    <TreeNodeCard
                      node={root}
                      parentChildren={roots}
                      parentNode={null}
                      grandparentNode={null}
                      depth={0}
                      parentComponent={null}
                    />
                    <SiblingInsertSlot parentId={null} position={i + 1} />
                  </React.Fragment>
                ))}
              </>
            )}
            {!sessionMode && !consultMode && (
              <div className="mt-2">
                <AddNodeButton parentId={null} label="+ Add root section" />
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
    </TreeConsultContext.Provider>
  );
};
