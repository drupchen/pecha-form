import React, { useMemo, useState } from 'react';
import {
  Upload, Trash2, FileText, ChevronRight, GitBranch, CopyPlus,
  Pencil, Check, X, FolderInput, ChevronDown, Folder, Plus, FolderPlus,
} from 'lucide-react';
import type { TextInfo } from '../store/useTextStore';

const SEP = '/'; // reserved nesting separator for text_group paths
const ADD_ROOT = ' root'; // sentinel: the "new top-level group" input is open

// A node in the derived group tree. `path` is the full "/"-joined DISPLAY path; `texts` are
// the texts living directly at this node (not in a deeper sub-group).
interface GroupNode {
  name: string;
  path: string;
  children: Map<string, GroupNode>;
  texts: TextInfo[];
}

const subtreeCount = (node: GroupNode): number =>
  node.texts.length +
  Array.from(node.children.values()).reduce((sum, c) => sum + subtreeCount(c), 0);

const pathSegments = (group: string | null): string[] =>
  (group || '').split(SEP).map(s => s.trim()).filter(Boolean);

/**
 * One grouped region of the "Your texts" home: the nested `text_group` tree with drag-to-file,
 * inline group create/rename/delete, and (columns layout only) group drag-reorder. Works purely
 * in DISPLAY-path space — the parent supplies scope-bridged group/text actions so the same engine
 * renders both the primary columns and the secondary (namespaced) panel with its own state.
 */
export interface GroupedTextRegionProps {
  layout: 'columns' | 'panel';
  texts: TextInfo[];                 // this region's texts (text_group already in display space)
  groups: string[];                  // this region's registry paths (display space, ordered)
  titleById: Map<number, string>;
  groupMime: string;                 // region-unique DnD type so group drags don't cross regions
  onSelectDoc: (id: number) => void;
  renameText: (id: number, title: string) => Promise<void>;
  setTextGroup: (id: number, displayPathOrNull: string | null) => Promise<void>;
  removeText: (id: number) => void | Promise<void>;
  createGroup: (displayPath: string) => Promise<void>;
  moveGroup: (srcDisplay: string, destDisplay: string) => Promise<void>;
  reorderGroup?: (srcDisplay: string, beforeDisplay: string) => Promise<void>;
  deleteGroup: (displayPath: string) => Promise<void>;
  onDerive?: (id: number) => void;   // primary rows only
  onClone?: (id: number) => void;    // primary rows only
  onAddText?: () => void;            // columns toolbar "Add text"
  title?: string;                    // panel header label
  emptyHint?: string;                // panel empty-state hint
}

export const GroupedTextRegion: React.FC<GroupedTextRegionProps> = ({
  layout, texts, groups, titleById, groupMime, onSelectDoc, renameText, setTextGroup,
  removeText, createGroup, moveGroup, reorderGroup, deleteGroup, onDerive, onClone,
  onAddText, title, emptyHint,
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [gapTarget, setGapTarget] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');

  const { root, ungrouped } = useMemo(() => {
    const root: GroupNode = { name: '', path: '', children: new Map(), texts: [] };
    const ungrouped: TextInfo[] = [];
    const ensurePath = (segs: string[]): GroupNode => {
      let node = root;
      let acc = '';
      for (const seg of segs) {
        acc = acc ? acc + SEP + seg : seg;
        let child = node.children.get(seg);
        if (!child) {
          child = { name: seg, path: acc, children: new Map(), texts: [] };
          node.children.set(seg, child);
        }
        node = child;
      }
      return node;
    };
    for (const g of groups) {
      const segs = pathSegments(g);
      if (segs.length) ensurePath(segs);
    }
    for (const t of texts) {
      const segs = pathSegments(t.text_group);
      if (segs.length === 0) { ungrouped.push(t); continue; }
      ensurePath(segs).texts.push(t);
    }
    return { root, ungrouped };
  }, [texts, groups]);

  const existingGroups = useMemo(() => {
    const out: string[] = [];
    const walk = (n: GroupNode) => { if (n.path) out.push(n.path); n.children.forEach(walk); };
    root.children.forEach(walk);
    return out.sort((a, b) => a.localeCompare(b));
  }, [root]);

  const orderIndex = useMemo(() => new Map(groups.map((p, i) => [p, i])), [groups]);
  const sortSiblings = (a: GroupNode, b: GroupNode) => {
    const ia = orderIndex.has(a.path) ? orderIndex.get(a.path)! : Infinity;
    const ib = orderIndex.has(b.path) ? orderIndex.get(b.path)! : Infinity;
    return ia - ib || a.name.localeCompare(b.name);
  };

  const toggleCollapse = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const startEdit = (doc: TextInfo) => { setEditingId(doc.id); setDraftTitle(doc.title); };
  const commitEdit = async () => {
    const id = editingId;
    if (id == null) return;
    const title = draftTitle.trim();
    setEditingId(null);
    if (title && title !== titleById.get(id)) {
      try { await renameText(id, title); }
      catch (err: any) { alert('Rename failed: ' + (err?.message || err)); }
    }
  };

  const assignGroup = async (doc: TextInfo) => {
    const choice = window.prompt(
      `Group for "${doc.title}"\n\nUse "/" for sub-groups, e.g. Guru Padma/Root.\n\nExisting: ${existingGroups.join(', ') || '(none yet)'}\n\nType a group path, or leave blank to remove from group:`,
      doc.text_group ?? '',
    );
    if (choice === null) return;
    try { await setTextGroup(doc.id, choice.trim() || null); }
    catch (err: any) { alert('Failed to set group: ' + (err?.message || err)); }
  };

  const dropOnGroup = async (e: React.DragEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const groupPath = e.dataTransfer.getData(groupMime);
    if (groupPath) {
      if (path === groupPath || path.startsWith(groupPath + SEP)) return;
      const parent = groupPath.includes(SEP) ? groupPath.slice(0, groupPath.lastIndexOf(SEP)) : '';
      if (parent === path) return;
      try { await moveGroup(groupPath, path); }
      catch (err: any) { alert('Failed to move group: ' + (err?.message || err)); }
      return;
    }
    const id = Number(e.dataTransfer.getData('text/plain'));
    if (!id) return;
    const doc = texts.find(t => t.id === id);  // region-scoped → cross-region text drops ignored
    if (!doc) return;
    if ((doc.text_group ?? '') === path) return;
    try { await setTextGroup(id, path || null); }
    catch (err: any) { alert('Failed to move: ' + (err?.message || err)); }
  };

  const submitNewGroup = async () => {
    const name = newGroupName.trim();
    const under = addingUnder;
    setAddingUnder(null);
    setNewGroupName('');
    if (!name || under === null) return;
    const path = under === ADD_ROOT ? name : under + SEP + name;
    try {
      await createGroup(path);
      if (under !== ADD_ROOT) {
        setCollapsed(prev => { const n = new Set(prev); n.delete(under); return n; });
      }
    } catch (err: any) { alert('Failed to create group: ' + (err?.message || err)); }
  };

  const renderNewGroupInput = (paddingLeft: number) => (
    <div className="flex items-center gap-2 py-2 bg-cream" style={{ paddingLeft, paddingRight: 24, borderBottom: '1px solid var(--cline)' }}>
      <FolderPlus size={15} className="text-bronze shrink-0" />
      <input
        autoFocus
        value={newGroupName}
        onChange={e => setNewGroupName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submitNewGroup();
          if (e.key === 'Escape') { setAddingUnder(null); setNewGroupName(''); }
        }}
        onBlur={submitNewGroup}
        placeholder="New group name…"
        className="font-display text-base text-lapis bg-white rounded px-2 py-0.5 flex-1"
        style={{ border: '1px solid var(--cline)' }}
      />
      <button onMouseDown={e => e.preventDefault()} onClick={submitNewGroup}
        className="p-1 text-teal-600 hover:bg-teal-500/10 rounded" title="Create">
        <Check size={16} />
      </button>
    </div>
  );

  const renderRow = (doc: TextInfo) => (
    <li
      key={doc.id}
      draggable={editingId !== doc.id}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', String(doc.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="relative flex items-center justify-between p-4 hover:bg-cream transition-colors group"
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center text-gold shrink-0 cursor-pointer"
          style={{ background: 'rgba(236,179,32,0.12)', boxShadow: 'inset 0 0 0 1px var(--cline)' }}
          onClick={() => onSelectDoc(doc.id)}
        >
          <FileText size={20} />
        </div>
        <div className="min-w-0 flex-1">
          {editingId === doc.id ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={commitEdit}
                className="font-display text-lg text-lapis bg-white rounded px-2 py-0.5 w-full"
                style={{ border: '1px solid var(--cline)' }}
              />
              <button onMouseDown={e => e.preventDefault()} onClick={commitEdit}
                className="p-1 text-teal-600 hover:bg-teal-500/10 rounded" title="Save">
                <Check size={16} />
              </button>
              <button onMouseDown={e => e.preventDefault()} onClick={() => setEditingId(null)}
                className="p-1 text-bronze hover:bg-vermilion/10 rounded" title="Cancel">
                <X size={16} />
              </button>
            </div>
          ) : (
            <h4
              className="font-display text-lg text-lapis group-hover:text-vermilion transition-colors flex items-center gap-2 cursor-pointer min-w-0"
              onClick={() => onSelectDoc(doc.id)}
            >
              <span className="truncate min-w-0">{doc.title}</span>
              <span className={
                'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono shrink-0 ' +
                (doc.text_type === 'secondary' ? 'bg-lapis/10 text-lapis' : 'bg-bronze/10 text-bronze')
              }>
                {doc.text_type}
              </span>
              {doc.cloned_from_text_id != null && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-700 dark:text-teal-300 font-mono shrink-0">
                  duplicate
                </span>
              )}
              {doc.has_clone && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 font-mono shrink-0">
                  original
                </span>
              )}
            </h4>
          )}
          <p className="text-xs text-ink-soft mt-0.5 font-mono truncate">
            {doc.text_type === 'secondary'
              ? `derived from ${titleById.get(doc.parent_text_id ?? -1) ?? 'parent'}`
              : doc.cloned_from_text_id != null
              ? `duplicate of ${titleById.get(doc.cloned_from_text_id) ?? 'a deleted text'}`
              : `${doc.span_count} tags · added ${new Date(doc.created_at).toLocaleDateString()}`}
          </p>
        </div>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 bg-cream rounded-lg shadow-sm px-1">
        <button
          onClick={() => startEdit(doc)}
          className="p-2 text-bronze hover:text-lapis hover:bg-lapis/10 rounded-md transition-colors"
          title="Rename title"
        >
          <Pencil size={18} />
        </button>
        <button
          onClick={() => assignGroup(doc)}
          className="p-2 text-bronze hover:text-gold hover:bg-gold/10 rounded-md transition-colors"
          title="Move to group"
        >
          <FolderInput size={18} />
        </button>
        {doc.text_type === 'primary' && onClone && (
          <button
            onClick={() => onClone(doc.id)}
            className="p-2 text-bronze hover:text-teal-600 hover:bg-teal-500/10 rounded-md transition-colors"
            title="Duplicate with edits baked in (applies deletions permanently to the copy)"
          >
            <CopyPlus size={18} />
          </button>
        )}
        {doc.text_type === 'primary' && onDerive && (
          <button
            onClick={() => onDerive(doc.id)}
            className="p-2 text-bronze hover:text-lapis hover:bg-lapis/10 rounded-md transition-colors"
            title="Derive secondary text"
          >
            <GitBranch size={18} />
          </button>
        )}
        <button
          onClick={() => removeText(doc.id)}
          className="p-2 text-bronze hover:text-vermilion-deep hover:bg-vermilion/10 rounded-md transition-colors"
          title="Delete text"
        >
          <Trash2 size={18} />
        </button>
        <button
          onClick={() => onSelectDoc(doc.id)}
          className="p-2 text-bronze hover:text-gold hover:bg-gold/10 rounded-md transition-colors"
          title="Open Tag Editor"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </li>
  );

  const renderNode = (node: GroupNode, depth: number): React.ReactNode => {
    const isOpen = !collapsed.has(node.path);
    const isDrop = dropTarget === node.path;
    const isEmpty = subtreeCount(node) === 0;
    const childNodes = Array.from(node.children.values()).sort(sortSiblings);
    return (
      <section key={node.path} style={{ borderBottom: '1px solid var(--cline)' }}>
        <div
          draggable
          onDragStart={e => {
            e.stopPropagation();
            e.dataTransfer.setData(groupMime, node.path);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => toggleCollapse(node.path)}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTarget(node.path); setGapTarget(null); }}
          onDragLeave={() => setDropTarget(prev => (prev === node.path ? null : prev))}
          onDrop={e => dropOnGroup(e, node.path)}
          className={
            'w-full py-3 flex items-center gap-2 cursor-pointer transition-colors text-left group/hdr ' +
            (isDrop ? 'bg-gold/20' : 'bg-cream-hi hover:bg-cream')
          }
          style={{
            paddingLeft: 24 + depth * 20,
            paddingRight: 24,
            borderBottom: isOpen ? '1px solid var(--cline)' : 'none',
          }}
        >
          {isOpen ? <ChevronDown size={16} className="text-bronze" /> : <ChevronRight size={16} className="text-bronze" />}
          <Folder size={15} className="text-bronze shrink-0" />
          <h2 className="font-display text-lg text-lapis truncate">{node.name}</h2>
          <span className="text-xs text-ink-soft font-mono ml-1">({subtreeCount(node)})</span>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {isEmpty && (
              <button
                onClick={e => { e.stopPropagation(); deleteGroup(node.path).catch((err: any) => alert('Failed to delete group: ' + (err?.message || err))); }}
                className="p-1.5 text-bronze hover:text-vermilion-deep hover:bg-vermilion/10 rounded-md transition-colors opacity-0 group-hover/hdr:opacity-100"
                title="Delete empty group"
              >
                <Trash2 size={16} />
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); setNewGroupName(''); setAddingUnder(node.path); }}
              className="p-1.5 text-bronze hover:text-gold hover:bg-gold/10 rounded-md transition-colors"
              title="Add sub-group"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        {addingUnder === node.path && renderNewGroupInput(24 + (depth + 1) * 20)}
        {isOpen && (
          <>
            {childNodes.map(c => renderNode(c, depth + 1))}
            {node.texts.length > 0 && (
              <ul className="divide-y divide-bronze/10" style={{ paddingLeft: (depth + 1) * 20 }}>
                {node.texts.map(renderRow)}
              </ul>
            )}
          </>
        )}
      </section>
    );
  };

  const renderUngrouped = () => {
    const isOpen = !collapsed.has('');
    const isDrop = dropTarget === '';
    return (
      <section key="__ungrouped__" style={{ borderBottom: '1px solid var(--cline)' }}>
        <div
          onClick={() => toggleCollapse('')}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTarget(''); setGapTarget(null); }}
          onDragLeave={() => setDropTarget(prev => (prev === '' ? null : prev))}
          onDrop={e => dropOnGroup(e, '')}
          className={
            'w-full px-6 py-3 flex items-center gap-2 cursor-pointer transition-colors text-left ' +
            (isDrop ? 'bg-gold/20' : 'bg-cream-hi hover:bg-cream')
          }
          style={{ borderBottom: isOpen && ungrouped.length > 0 ? '1px solid var(--cline)' : 'none' }}
        >
          {isOpen ? <ChevronDown size={16} className="text-bronze" /> : <ChevronRight size={16} className="text-bronze" />}
          <h2 className="font-display text-lg text-ink-soft italic">Ungrouped</h2>
          <span className="text-xs text-ink-soft font-mono ml-1">({ungrouped.length})</span>
        </div>
        {isOpen && ungrouped.length > 0 && (
          <ul className="divide-y divide-bronze/10">
            {ungrouped.map(renderRow)}
          </ul>
        )}
      </section>
    );
  };

  const topNodes = Array.from(root.children.values()).sort(sortSiblings);

  // --- Column-reorder drag helpers (columns layout only) ---
  const boundaryAtX = (rowEl: HTMLElement, clientX: number): string => {
    const cols = Array.from(rowEl.querySelectorAll<HTMLElement>(':scope > [data-group-path]'));
    const idx = cols.filter(c => {
      const r = c.getBoundingClientRect();
      return clientX > r.left + r.width / 2;
    }).length;
    return idx < cols.length ? (cols[idx].dataset.groupPath ?? '') : '';
  };
  const isGroupDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(groupMime);
  const onRowDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isGroupDrag(e)) return;
    e.preventDefault();
    setGapTarget(boundaryAtX(e.currentTarget, e.clientX));
  };
  const onRowDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setGapTarget(null);
  };
  const onRowDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!isGroupDrag(e) || !reorderGroup) return;
    e.preventDefault();
    const beforePath = boundaryAtX(e.currentTarget, e.clientX);
    setGapTarget(null);
    const groupPath = e.dataTransfer.getData(groupMime);
    if (!groupPath || groupPath === beforePath) return;
    try { await reorderGroup(groupPath, beforePath); }
    catch (err: any) { alert('Failed to reorder group: ' + (err?.message || err)); }
  };
  const renderGap = (beforePath: string) => (
    <div
      key={`gap:${beforePath}`}
      className="flex-shrink-0 self-stretch rounded-full transition-all pointer-events-none"
      style={{
        width: gapTarget === beforePath ? 6 : 10,
        background: gapTarget === beforePath ? 'var(--gold)' : 'transparent',
      }}
    />
  );

  // A "New group" button/inline-input (top-level), reused by both layouts.
  const newTopGroupControl = addingUnder === ADD_ROOT ? (
    <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-white" style={{ border: '1px solid var(--cline)' }}>
      <FolderPlus size={15} className="text-bronze shrink-0" />
      <input
        autoFocus
        value={newGroupName}
        onChange={e => setNewGroupName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submitNewGroup();
          if (e.key === 'Escape') { setAddingUnder(null); setNewGroupName(''); }
        }}
        onBlur={submitNewGroup}
        placeholder="New group name…"
        className="font-display text-base text-lapis bg-transparent px-1 py-0.5 w-40 outline-none"
      />
      <button onMouseDown={e => e.preventDefault()} onClick={submitNewGroup}
        className="p-1 text-teal-600 hover:bg-teal-500/10 rounded" title="Create">
        <Check size={16} />
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => { setNewGroupName(''); setAddingUnder(ADD_ROOT); }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white text-lapis hover:bg-cream transition-colors cursor-pointer"
      style={{ border: '1px solid var(--cline)' }}
      title="Create a new top-level group"
    >
      <Plus size={16} className="text-bronze" />
      <span className="font-display text-base">New group</span>
    </button>
  );

  if (layout === 'panel') {
    // Compact: one box; groups stack vertically (no side-by-side columns / reorder).
    return (
      <div className="px-3 pt-3">
        <div className="rounded-xl overflow-hidden bg-cream-hi" style={{ border: '1px solid var(--cline)' }}>
          <div className="flex items-center gap-3 px-4 py-2 bg-cream" style={{ borderBottom: '1px solid var(--cline)' }}>
            <h2 className="font-display text-lg text-lapis">{title ?? 'Derived texts'}</h2>
            <div className="ml-auto">{newTopGroupControl}</div>
          </div>
          {addingUnder === ADD_ROOT && null}
          {topNodes.length === 0 && ungrouped.length === 0 ? (
            <div className="px-4 py-4 text-sm text-ink-soft italic">
              {emptyHint ?? 'No derived texts yet — derive one from a primary text below.'}
            </div>
          ) : (
            <>
              {renderUngrouped()}
              {topNodes.map(n => renderNode(n, 0))}
            </>
          )}
        </div>
      </div>
    );
  }

  // Columns layout (primary): side-by-side cards with the Add-text / New-group toolbar.
  return (
    <div
      className="flex flex-nowrap p-3 items-start overflow-x-auto"
      onDragOver={onRowDragOver}
      onDragLeave={onRowDragLeave}
      onDrop={onRowDrop}
    >
      <div className="flex-shrink-0 self-start flex flex-col gap-3" style={{ width: 380 }}>
        <div className="flex items-center gap-2">
          {onAddText && (
            <button
              type="button"
              onClick={onAddText}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white text-lapis hover:bg-cream transition-colors cursor-pointer"
              style={{ border: '1px solid var(--cline)' }}
              title="Upload a .txt file"
            >
              <Upload size={16} className="text-bronze" />
              <span className="font-display text-base">Add text</span>
            </button>
          )}
          {newTopGroupControl}
        </div>
        <div className="rounded-xl overflow-hidden bg-cream-hi" style={{ border: '1px solid var(--cline)' }}>
          {renderUngrouped()}
        </div>
      </div>
      {topNodes.map(n => (
        <React.Fragment key={n.path}>
          {renderGap(n.path)}
          <div
            data-group-path={n.path}
            className="flex-shrink-0 rounded-xl overflow-hidden self-start bg-cream-hi"
            style={{ width: 380, border: '1px solid var(--cline)' }}
          >
            {renderNode(n, 0)}
          </div>
        </React.Fragment>
      ))}
      {renderGap('')}
    </div>
  );
};
