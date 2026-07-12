import { create } from 'zustand';

/** Keys of the display-only line-break groups. To add one: extend this union, add a
 *  rule in `tokenBreak` (segments.ts), and a row in WorkspaceView's
 *  LINE_BREAK_GROUP_OPTIONS. */
export type LineBreakGroup = 'verse' | 'sapche' | 'mantra';

/**
 * Cross-cutting UI state. Currently just the global "session mode" toggle —
 * when true, the workspace hides regular annotations and operates on the
 * teaching-session tag layer only.
 */
interface UIState {
  sessionMode: boolean;
  setSessionMode: (v: boolean) => void;
  toggleSessionMode: () => void;
  /** Display-only line breaks, master switch. When on, the groups enabled in
   *  `lineBreakGroups` synthesize line breaks at render time (nothing persisted):
   *  verse — after each space inside a "verse"-tagged run (one line per phrase,
   *  seed syllables excepted); sapche — after each "sapche"-tagged run. */
  lineBreaksOn: boolean;
  toggleLineBreaks: () => void;
  /** Which break groups apply while `lineBreaksOn`. Choices are remembered while
   *  the master switch is off. */
  lineBreakGroups: Record<LineBreakGroup, boolean>;
  setLineBreakGroup: (g: LineBreakGroup, on: boolean) => void;
  /** Workspace focus mode — hides all top chrome (app header, the Workspace
   *  bar, and the Tree/Tagger pane titles) to maximize working area. */
  workspaceFullscreen: boolean;
  setWorkspaceFullscreen: (v: boolean) => void;
  toggleWorkspaceFullscreen: () => void;
  /** Workspace mode. In 'consult' every write affordance except suggestion
   *  and note CRUD is hidden / disabled so the user can browse without
   *  accidentally editing structure. */
  editMode: 'edit' | 'consult';
  setEditMode: (m: 'edit' | 'consult') => void;
  /** When set, the workspace is in "place a passage" mode: the user has picked a
   *  source syllable range and the next downstream syllable click places the passage
   *  there. `endOffset` is the source selection's end offset (frontend aid) used to
   *  reject upstream anchors. Cleared on placement or Esc. */
  pendingPassageSource: { startSylId: string; endSylId: string; endOffset: number } | null;
  setPendingPassageSource: (v: { startSylId: string; endSylId: string; endOffset: number } | null) => void;
  /** Feedback line shown in the "place a passage" banner (e.g. "pick a syllable AFTER
   *  the selection", or a backend rejection). Cleared when (dis)arming placement. */
  passageNotice: string | null;
  setPassageNotice: (v: string | null) => void;
  /** Tagger-pane search query. Empty string disables search. */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Index into the current match list. Reset to 0 whenever the query
   *  changes. */
  searchMatchIndex: number;
  setSearchMatchIndex: (i: number) => void;
  /** Pixel width of every tree-node card. Shared across all cards so the
   *  resize handle on any one of them resizes the whole tree at once. */
  treeNodeWidth: number;
  setTreeNodeWidth: (px: number) => void;
  /** Where the navigation band currently sits. Moves with arrow nav AND
   *  with body clicks. Cleared on document switch. */
  lastHoveredTreeNodeId: number | null;
  setLastHoveredTreeNodeId: (id: number | null) => void;
  /** The user's persistent anchor — only changes on body click. Survives
   *  arrow navigation so the focus button can return to it. */
  selectedTreeNodeId: number | null;
  setSelectedTreeNodeId: (id: number | null) => void;
  /** Set of tree-node ids the user has explicitly collapsed. Nodes not in
   *  the set are open by default. */
  collapsedTreeNodeIds: Set<number>;
  toggleNodeCollapse: (id: number) => void;
  expandNode: (id: number) => void;
  collapseAllTreeNodes: (ids: number[]) => void;
  expandAllTreeNodes: () => void;
  /** Deepest indent level currently in the tree (0 = only roots). Tracked so
   *  the selected-node band can extend just past the rightmost node's edge
   *  rather than running to infinity. */
  maxTreeDepth: number;
  setMaxTreeDepth: (n: number) => void;
  /** Font size (in rem) applied to the Tibetan body text inside every
   *  SegmentCard in the Tagger pane. Shared so all cards scale together. */
  taggerFontSize: number;
  increaseTaggerFontSize: () => void;
  decreaseTaggerFontSize: () => void;
}

const MIN_W = 120;
const MAX_W = 900;
const DEFAULT_W = 240;

export const MIN_FONT = 0.75;
export const MAX_FONT = 3.0;
export const DEFAULT_FONT = 1.25;
const FONT_STEP = 0.125;

export const useUIStore = create<UIState>((set) => ({
  sessionMode: false,
  setSessionMode: (v) => set({ sessionMode: v }),
  toggleSessionMode: () => set((s) => ({ sessionMode: !s.sessionMode })),
  lineBreaksOn: false,
  toggleLineBreaks: () => set((s) => ({ lineBreaksOn: !s.lineBreaksOn })),
  lineBreakGroups: { verse: true, sapche: true, mantra: true },
  setLineBreakGroup: (g, on) => set((s) => ({
    lineBreakGroups: { ...s.lineBreakGroups, [g]: on },
  })),
  workspaceFullscreen: false,
  setWorkspaceFullscreen: (v) => set({ workspaceFullscreen: v }),
  toggleWorkspaceFullscreen: () => set((s) => ({ workspaceFullscreen: !s.workspaceFullscreen })),
  editMode: 'edit',
  setEditMode: (m) => set({ editMode: m }),
  pendingPassageSource: null,
  // (Dis)arming placement always resets the notice so stale feedback never lingers.
  setPendingPassageSource: (v) => set({ pendingPassageSource: v, passageNotice: null }),
  passageNotice: null,
  setPassageNotice: (v) => set({ passageNotice: v }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q, searchMatchIndex: 0 }),
  searchMatchIndex: 0,
  setSearchMatchIndex: (i) => set({ searchMatchIndex: i }),
  treeNodeWidth: DEFAULT_W,
  setTreeNodeWidth: (px) => set({ treeNodeWidth: Math.max(MIN_W, Math.min(MAX_W, px)) }),
  lastHoveredTreeNodeId: null,
  setLastHoveredTreeNodeId: (id) => set({ lastHoveredTreeNodeId: id }),
  selectedTreeNodeId: null,
  setSelectedTreeNodeId: (id) => set({ selectedTreeNodeId: id }),
  collapsedTreeNodeIds: new Set<number>(),
  toggleNodeCollapse: (id) => set((s) => {
    const next = new Set(s.collapsedTreeNodeIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { collapsedTreeNodeIds: next };
  }),
  expandNode: (id) => set((s) => {
    if (!s.collapsedTreeNodeIds.has(id)) return {};
    const next = new Set(s.collapsedTreeNodeIds);
    next.delete(id);
    return { collapsedTreeNodeIds: next };
  }),
  collapseAllTreeNodes: (ids) => set({ collapsedTreeNodeIds: new Set(ids) }),
  expandAllTreeNodes: () => set({ collapsedTreeNodeIds: new Set<number>() }),
  maxTreeDepth: 0,
  setMaxTreeDepth: (n) => set({ maxTreeDepth: n }),
  taggerFontSize: DEFAULT_FONT,
  increaseTaggerFontSize: () => set((s) => ({
    taggerFontSize: Math.min(MAX_FONT, s.taggerFontSize + FONT_STEP),
  })),
  decreaseTaggerFontSize: () => set((s) => ({
    taggerFontSize: Math.max(MIN_FONT, s.taggerFontSize - FONT_STEP),
  })),
}));
