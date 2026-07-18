import React, { useEffect, useRef, useMemo } from 'react';
import { useTextStore } from '../store/useTextStore';
import type { Route } from '../App';
import { GroupedTextRegion } from './GroupedTextRegion';
import { useCan } from '../store/usePermissions';

interface TextPickerProps {
  onNavigate: (route: Route) => void;
}

const GROUP_MIME = 'application/x-pf-group';
// Reserved top segment that namespaces secondary-text groups so they stay independent from the
// primary groups while sharing the same untyped `text_groups` registry (see the two regions
// below). Users never see it — it's stripped for display and re-added when talking to the store.
const DERIVED_NS = '__derived__';
const inNs = (p: string) => p === DERIVED_NS || p.startsWith(DERIVED_NS + '/');
const stripNs = (p: string | null): string | null => {
  if (p == null) return null;
  if (p === DERIVED_NS) return '';
  return p.startsWith(DERIVED_NS + '/') ? p.slice(DERIVED_NS.length + 1) : p;
};
const toNs = (displayPath: string) => `${DERIVED_NS}/${displayPath}`;

export const TextPicker: React.FC<TextPickerProps> = ({ onNavigate }) => {
  const texts = useTextStore(s => s.texts);
  const groups = useTextStore(s => s.groups);
  const fetchTexts = useTextStore(s => s.fetchTexts);
  const fetchGroups = useTextStore(s => s.fetchGroups);
  const createGroup = useTextStore(s => s.createGroup);
  const moveGroup = useTextStore(s => s.moveGroup);
  const reorderGroup = useTextStore(s => s.reorderGroup);
  const deleteGroup = useTextStore(s => s.deleteGroup);
  const uploadNewFile = useTextStore(s => s.uploadNewFile);
  const loadText = useTextStore(s => s.loadText);
  const removeText = useTextStore(s => s.removeText);
  const deriveSecondary = useTextStore(s => s.deriveSecondary);
  const cloneWithEdits = useTextStore(s => s.cloneWithEdits);
  const updateMeta = useTextStore(s => s.updateMeta);
  const loading = useTextStore(s => s.loading);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { canModify: canEditTexts } = useCan('texts');

  useEffect(() => {
    fetchTexts();
    fetchGroups();
  }, [fetchTexts, fetchGroups]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      try {
        await uploadNewFile(e.target.files[0]);
        onNavigate('/workspace');
      } catch (err) {
        alert('Failed to upload text');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSelectDoc = async (id: number) => {
    await loadText(id);
    onNavigate('/workspace');
  };
  const handleDerive = async (parentId: number) => {
    try {
      const newId = await deriveSecondary(parentId);
      await handleSelectDoc(newId);
    } catch (err: any) {
      alert('Failed to derive secondary text: ' + (err?.message || err));
    }
  };
  const handleClone = async (id: number) => {
    try { await cloneWithEdits(id); }
    catch (err: any) { alert('Failed to duplicate text: ' + (err?.message || err)); }
  };

  const titleById = useMemo(() => new Map(texts.map(t => [t.id, t.title])), [texts]);

  // Partition texts + registry groups into the two regions. Primary keeps bare paths; secondary
  // works in display space (namespace prefix stripped), re-added by the scope-bridged actions.
  const primaryTexts = useMemo(() => texts.filter(t => t.text_type !== 'secondary'), [texts]);
  const secondaryTexts = useMemo(
    () => texts.filter(t => t.text_type === 'secondary')
      .map(t => ({ ...t, text_group: stripNs(t.text_group) })),
    [texts],
  );
  const primaryGroups = useMemo(() => groups.filter(p => !inNs(p)), [groups]);
  const secondaryGroups = useMemo(
    () => groups.filter(inNs).map(stripNs).filter((p): p is string => !!p),
    [groups],
  );

  const isEmpty = texts.length === 0 && groups.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full mt-10 px-6 pb-12">
        <div className="text-center mb-6">
          <div className="text-[11px] tracking-[0.4em] uppercase text-bronze mb-2">
            Oral Teachings Archive
          </div>
          <h1 className="font-display text-4xl text-lapis font-medium">Your texts</h1>
          <div className="font-display italic text-ink-soft mt-1">choose a text, or bring one in</div>
        </div>

        <div
          className="bg-cream rounded-2xl overflow-hidden"
          style={{
            border: '1px solid var(--cline)',
            boxShadow: '0 16px 40px -18px rgba(7,27,56,0.50)',
          }}
        >
          <div className="p-0 bg-cream-hi">
            <input
              type="file"
              className="hidden"
              accept=".txt"
              ref={fileInputRef}
              onChange={handleFileChange}
            />

            {loading && isEmpty ? (
              <div className="p-6 text-center text-ink-soft">Loading...</div>
            ) : isEmpty ? (
              <div className="p-6 text-center text-ink-soft text-sm">No texts found. Use “Add text” to begin.</div>
            ) : (
              <>
                {/* Upper box: secondary (derived) texts — a compact grouped panel with its own
                    independent groups (namespaced), separated by a divider from the columns. */}
                <GroupedTextRegion
                  layout="panel"
                  title="Derived texts"
                  texts={secondaryTexts}
                  groups={secondaryGroups}
                  titleById={titleById}
                  groupMime={GROUP_MIME + ':secondary'}
                  onSelectDoc={handleSelectDoc}
                  renameText={(id, title) => updateMeta(id, { title })}
                  setTextGroup={(id, disp) => updateMeta(id, { text_group: disp ? toNs(disp) : null })}
                  removeText={removeText}
                  createGroup={(disp) => createGroup(toNs(disp))}
                  moveGroup={(src, dest) => moveGroup(toNs(src), dest ? toNs(dest) : DERIVED_NS)}
                  deleteGroup={(disp) => deleteGroup(toNs(disp))}
                  readOnly={!canEditTexts}
                />

                <div style={{ borderTop: '1px solid var(--cline)' }} />

                {/* Lower box: primary texts — the existing side-by-side columns. */}
                <GroupedTextRegion
                  layout="columns"
                  texts={primaryTexts}
                  groups={primaryGroups}
                  titleById={titleById}
                  groupMime={GROUP_MIME}
                  onSelectDoc={handleSelectDoc}
                  renameText={(id, title) => updateMeta(id, { title })}
                  setTextGroup={(id, disp) => updateMeta(id, { text_group: disp })}
                  removeText={removeText}
                  createGroup={createGroup}
                  moveGroup={moveGroup}
                  reorderGroup={(src, before) => reorderGroup(src, '', before)}
                  deleteGroup={deleteGroup}
                  onDerive={handleDerive}
                  onClone={handleClone}
                  onAddText={() => fileInputRef.current?.click()}
                  readOnly={!canEditTexts}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
