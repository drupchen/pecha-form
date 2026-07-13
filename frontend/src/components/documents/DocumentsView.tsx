import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Library, Plus, Trash2, ChevronUp, ChevronDown, FileText, Image as ImageIcon,
  BookOpen, List, Copyright, Square, BookMarked, LayoutTemplate, Pencil,
} from 'lucide-react';
import { useDocumentStore } from '../../store/useDocumentStore';
import { useTextStore } from '../../store/useTextStore';
import {
  getLanguages, getFurniture, putFurniture,
  uploadItemImage, deleteItemImage, itemImageUrl,
  type Language, type DocumentItemKind, type TocSection, type DocumentFurnitureRow,
} from '../../api/client';
import { PaginationBench } from './PaginationBench';

/** Furniture kinds that carry per-language authored text. */
const EDITABLE_FURNITURE: DocumentItemKind[] = ['cover', 'copyright', 'image_page'];

const KIND_META: Record<DocumentItemKind, { label: string; icon: React.ReactNode }> = {
  cover: { label: 'Cover', icon: <BookOpen size={14} /> },
  blank: { label: 'Blank page', icon: <Square size={14} /> },
  toc: { label: 'Table of contents', icon: <List size={14} /> },
  copyright: { label: 'Copyright', icon: <Copyright size={14} /> },
  text: { label: 'Text', icon: <FileText size={14} /> },
  image_page: { label: 'Image', icon: <ImageIcon size={14} /> },
  backcover: { label: 'Back cover', icon: <BookMarked size={14} /> },
};
const FURNITURE: DocumentItemKind[] = ['cover', 'blank', 'toc', 'copyright', 'image_page', 'backcover'];

/** Recursive TOC section list (structure only — page numbers arrive with D2). */
const TocSections: React.FC<{ sections: TocSection[]; depth?: number }> = ({ sections, depth = 0 }) => (
  <ul className="list-none">
    {sections.map((s, i) => (
      <li key={i} style={{ paddingLeft: depth * 14 }} className="py-0.5">
        <span className={depth === 0 ? 'text-ink' : 'text-ink-soft'}>{s.title}</span>
        {s.children.length > 0 && <TocSections sections={s.children} depth={depth + 1} />}
      </li>
    ))}
  </ul>
);

/**
 * Documents bench (Phase D1). Compose a booklet: order pages (text pages + furniture),
 * pick the publication languages, and preview the auto-generated table of contents.
 * Pagination and PDF export are the next phases; this is structure only.
 */
export const DocumentsView: React.FC = () => {
  const list = useDocumentStore(s => s.list);
  const current = useDocumentStore(s => s.current);
  const toc = useDocumentStore(s => s.toc);
  const error = useDocumentStore(s => s.error);
  const fetchList = useDocumentStore(s => s.fetchList);
  const open = useDocumentStore(s => s.open);
  const create = useDocumentStore(s => s.create);
  const rename = useDocumentStore(s => s.rename);
  const remove = useDocumentStore(s => s.remove);
  const addItem = useDocumentStore(s => s.addItem);
  const removeItem = useDocumentStore(s => s.removeItem);
  const moveItem = useDocumentStore(s => s.moveItem);
  const setLanguages = useDocumentStore(s => s.setLanguages);

  const texts = useTextStore(s => s.texts);
  const fetchTexts = useTextStore(s => s.fetchTexts);

  const [languages, setLangs] = useState<Language[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pickingText, setPickingText] = useState(false);
  const [paginating, setPaginating] = useState(false);
  const [furniture, setFurniture] = useState<DocumentFurnitureRow[]>([]);
  const [editingItem, setEditingItem] = useState<number | null>(null);
  const [imgBust, setImgBust] = useState(0);   // cache-buster for image previews
  const [imgBusy, setImgBusy] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchList();
    fetchTexts();
    getLanguages().then(setLangs).catch(() => {});
  }, [fetchList, fetchTexts]);

  // Load furniture content whenever the open document changes.
  useEffect(() => {
    if (current) getFurniture(current.id).then(setFurniture).catch(() => setFurniture([]));
    else setFurniture([]);
    setEditingItem(null);
  }, [current?.id]);

  const furnitureBody = (itemId: number, langCode: string) =>
    furniture.find(f => f.item_id === itemId && f.lang === langCode)?.body ?? '';
  const saveFurniture = async (itemId: number, langCode: string, body: string) => {
    if (!current) return;
    if (body === furnitureBody(itemId, langCode)) return;
    try {
      const row = await putFurniture(current.id, { item_id: itemId, lang: langCode, body });
      setFurniture(prev => [
        ...prev.filter(f => !(f.item_id === itemId && f.lang === langCode)), row,
      ]);
    } catch { /* surfaced by store elsewhere */ }
  };

  const onPickImage = async (itemId: number, file: File | undefined) => {
    if (!current || !file) return;
    setImgBusy(true);
    try {
      await uploadItemImage(itemId, file);
      await open(current.id);            // refresh has_image
      setImgBust(v => v + 1);            // bust the preview cache
    } catch { /* surfaced elsewhere */ }
    finally { setImgBusy(false); }
  };
  const onRemoveImage = async (itemId: number) => {
    if (!current) return;
    setImgBusy(true);
    try {
      await deleteItemImage(itemId);
      await open(current.id);
      setImgBust(v => v + 1);
    } catch { /* ignore */ }
    finally { setImgBusy(false); }
  };

  // Secondary texts first (the booklet intent), then the rest; primaries allowed.
  const pickable = useMemo(() => {
    const rank = (t: typeof texts[number]) => (t.text_type === 'secondary' ? 0 : 1);
    return [...texts].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  }, [texts]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPickingText(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const toggleLang = (code: string) => {
    if (!current) return;
    const has = current.languages.includes(code);
    const next = has ? current.languages.filter(c => c !== code) : [...current.languages, code];
    void setLanguages(next);
  };

  const startRename = () => { if (current) { setEditingTitle(current.title); setRenaming(true); } };
  const commitRename = () => {
    if (current && editingTitle.trim() && editingTitle.trim() !== current.title) {
      void rename(current.id, editingTitle.trim());
    }
    setRenaming(false);
  };

  // The pagination bench takes over the whole view for the current document.
  if (paginating && current) {
    return <PaginationBench documentId={current.id} onClose={() => setPaginating(false)} />;
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── Left rail: documents list ── */}
      <div className="w-64 shrink-0 flex flex-col bg-cream-hi overflow-hidden"
           style={{ borderRight: '1px solid var(--cline)' }}>
        <div className="px-4 py-3 flex items-center gap-2 font-display text-lg text-lapis"
             style={{ borderBottom: '1px solid var(--cline)' }}>
          <Library size={18} /> Documents
        </div>
        <div className="px-3 py-2 flex gap-1" style={{ borderBottom: '1px solid var(--cline)' }}>
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newTitle.trim()) { void create(newTitle.trim()); setNewTitle(''); } }}
            placeholder="New document…"
            className="flex-1 min-w-0 px-2 py-1 rounded-md bg-white text-sm"
            style={{ border: '1px solid var(--cline)' }}
          />
          <button
            type="button"
            onClick={() => { if (newTitle.trim()) { void create(newTitle.trim()); setNewTitle(''); } }}
            className="px-1.5 rounded-md text-lapis hover:bg-cream shrink-0"
            style={{ border: '1px solid var(--cline)' }}
            title="Create document"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {list.length === 0 && <div className="px-4 py-3 text-xs text-ink-soft">No documents yet.</div>}
          {list.map(d => (
            <button
              key={d.id}
              type="button"
              onClick={() => void open(d.id)}
              className={`w-full text-left px-4 py-2 transition-colors ${
                current?.id === d.id ? 'bg-lapis/10 text-lapis' : 'hover:bg-cream text-ink'
              }`}
            >
              <div className="text-sm font-medium truncate">{d.title}</div>
              <div className="text-[11px] text-ink-soft">
                {d.item_count} page{d.item_count === 1 ? '' : 's'}
                {d.languages.length > 0 && ` · ${d.languages.join(' ')}`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Right: editor ── */}
      {!current ? (
        <div className="flex-1 flex items-center justify-center text-ink-soft">
          Select a document, or create one.
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header: title + languages + delete */}
          <div className="px-5 py-3 shrink-0 flex items-center gap-4 bg-cream-hi"
               style={{ borderBottom: '1px solid var(--cline)' }}>
            {renaming ? (
              <input
                autoFocus
                value={editingTitle}
                onChange={e => setEditingTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
                className="font-display text-xl text-lapis px-2 py-0.5 rounded-md bg-white"
                style={{ border: '1px solid var(--cline)' }}
              />
            ) : (
              <h2 className="font-display text-xl text-lapis truncate max-w-sm cursor-text"
                  title="Click to rename" onClick={startRename}>
                {current.title}
              </h2>
            )}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-ink-soft mr-1">languages</span>
              {languages.map(l => {
                const on = current.languages.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => toggleLang(l.code)}
                    className={`px-2 py-0.5 rounded-full transition-colors ${
                      on ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
                    style={{ border: '1px solid var(--cline)' }}
                    title={l.name}
                  >
                    {l.code}
                  </button>
                );
              })}
            </div>
            <div className="flex-1" />
            {error && <span className="text-vermilion text-xs truncate max-w-xs" title={error}>{error}</span>}
            <button
              type="button"
              onClick={() => setPaginating(true)}
              disabled={current.items.every(i => i.kind !== 'text')}
              className="px-2 py-1 rounded-md text-lapis hover:bg-cream text-xs flex items-center gap-1 disabled:opacity-40"
              style={{ border: '1px solid var(--cline)' }}
              title="Open the pagination bench"
            >
              <LayoutTemplate size={13} /> layout
            </button>
            <button
              type="button"
              onClick={() => { if (confirm(`Delete "${current.title}"?`)) void remove(current.id); }}
              className="px-2 py-1 rounded-md text-vermilion hover:bg-cream text-xs flex items-center gap-1"
              style={{ border: '1px solid var(--cline)' }}
            >
              <Trash2 size={13} /> delete
            </button>
          </div>

          {/* Body: items | TOC */}
          <div className="flex-1 flex overflow-hidden">
            {/* Items */}
            <div className="flex-1 overflow-auto px-5 py-4">
              <div className="text-xs text-ink-soft mb-2">Pages ({current.items.length})</div>
              <div className="flex flex-col gap-1">
                {current.items.map((it, i) => {
                  // Text items get an editable per-language TOC title; furniture items
                  // get their per-language authored content.
                  const isTextItem = it.kind === 'text';
                  const editable = isTextItem || EDITABLE_FURNITURE.includes(it.kind);
                  return (
                  <div key={it.id}>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white"
                         style={{ border: '1px solid var(--cline)' }}>
                      <span className="text-ink-soft w-6 text-right text-xs">{i + 1}</span>
                      <span className="text-lapis">{KIND_META[it.kind].icon}</span>
                      <span className="text-sm flex-1 truncate">
                        {it.kind === 'text'
                          ? (it.text_title ?? <span className="text-vermilion">missing text</span>)
                          : <span className="text-ink-soft">{KIND_META[it.kind].label}</span>}
                      </span>
                      {editable && (
                        <button type="button"
                                onClick={() => setEditingItem(editingItem === it.id ? null : it.id)}
                                className={`p-0.5 hover:text-lapis ${editingItem === it.id ? 'text-lapis' : 'text-ink-soft'}`}
                                title={isTextItem ? 'Edit table-of-contents title (per language)' : 'Edit content (per language)'}>
                          <Pencil size={13} />
                        </button>
                      )}
                      <button type="button" onClick={() => void moveItem(it.id, -1)} disabled={i === 0}
                              className="p-0.5 text-ink-soft hover:text-lapis disabled:opacity-30" title="Move up">
                        <ChevronUp size={15} />
                      </button>
                      <button type="button" onClick={() => void moveItem(it.id, 1)} disabled={i === current.items.length - 1}
                              className="p-0.5 text-ink-soft hover:text-lapis disabled:opacity-30" title="Move down">
                        <ChevronDown size={15} />
                      </button>
                      <button type="button" onClick={() => void removeItem(it.id)}
                              className="p-0.5 text-ink-soft hover:text-vermilion" title="Remove page">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {editable && editingItem === it.id && (
                      <div className="ml-8 mt-1 mb-2 p-2 rounded-md bg-cream-hi flex flex-col gap-1.5"
                           style={{ border: '1px solid var(--cline)' }}>
                        {it.kind === 'image_page' && (
                          <div className="flex items-center gap-3 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            {it.has_image ? (
                              <img src={`${itemImageUrl(it.id)}?v=${imgBust}`} alt=""
                                   className="h-16 w-16 object-contain rounded bg-white"
                                   style={{ border: '1px solid var(--cline)' }} />
                            ) : (
                              <div className="h-16 w-16 rounded bg-white flex items-center justify-center text-[10px] text-ink-soft"
                                   style={{ border: '1px dashed var(--cline)' }}>no image</div>
                            )}
                            <div className="flex flex-col gap-1">
                              <label className="px-2 py-1 rounded-md text-xs text-lapis hover:bg-cream cursor-pointer inline-flex items-center gap-1"
                                     style={{ border: '1px solid var(--cline)' }}>
                                <ImageIcon size={12} /> {it.has_image ? 'Replace image' : 'Upload image'}
                                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                                       className="hidden" disabled={imgBusy}
                                       onChange={e => { void onPickImage(it.id, e.target.files?.[0]); e.target.value = ''; }} />
                              </label>
                              {it.has_image && (
                                <button type="button" onClick={() => void onRemoveImage(it.id)}
                                        disabled={imgBusy}
                                        className="px-2 py-1 rounded-md text-xs text-vermilion hover:bg-cream disabled:opacity-40 inline-flex items-center gap-1"
                                        style={{ border: '1px solid var(--cline)' }}>
                                  <Trash2 size={12} /> Remove
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="text-[11px] text-ink-soft">
                          {isTextItem
                            ? 'Table-of-contents title — per language (blank = the text’s own title)'
                            : it.kind === 'image_page'
                              ? 'Caption — per language (optional)'
                              : `${KIND_META[it.kind].label} content — per language (HTML: <p>, <em>, <strong>)`}
                        </div>
                        {current.languages.length === 0 && (
                          <span className="text-[11px] text-vermilion">Set the document's languages first.</span>
                        )}
                        {current.languages.map(code => (
                          <label key={code} className="flex items-start gap-2">
                            <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                            <textarea
                              defaultValue={furnitureBody(it.id, code)}
                              onBlur={e => void saveFurniture(it.id, code, e.target.value)}
                              rows={isTextItem ? 1 : 2}
                              placeholder={isTextItem ? 'e.g. Essence of Accomplishment' : (it.kind === 'copyright' ? 'Copyright © …' : 'content…')}
                              className="flex-1 px-2 py-1 rounded-md bg-white text-xs resize-y"
                              style={{ border: '1px solid var(--cline)' }}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })}
                {current.items.length === 0 && (
                  <div className="text-xs text-ink-soft py-4">Add pages below.</div>
                )}
              </div>

              {/* Add-item bar */}
              <div className="mt-4 flex items-center gap-1.5 flex-wrap text-xs">
                <span className="text-ink-soft mr-1">add</span>
                <div className="relative" ref={pickRef}>
                  <button
                    type="button"
                    onClick={() => setPickingText(v => !v)}
                    className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream"
                    style={{ border: '1px solid var(--cline)' }}
                  >
                    <FileText size={13} /> Text page…
                  </button>
                  {pickingText && (
                    <div className="absolute z-10 mt-1 w-72 max-h-72 overflow-auto rounded-md bg-white shadow-lg"
                         style={{ border: '1px solid var(--cline)' }}>
                      {pickable.map(t => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => { void addItem('text', t.id); setPickingText(false); }}
                          className="w-full text-left px-3 py-1.5 hover:bg-cream flex items-center gap-2"
                        >
                          <span className="tibetan-text-sm truncate flex-1">{t.title}</span>
                          <span className={`text-[10px] px-1 rounded ${
                            t.text_type === 'secondary' ? 'bg-jade/15 text-jade' : 'bg-cream text-ink-soft'}`}>
                            {t.text_type}
                          </span>
                        </button>
                      ))}
                      {pickable.length === 0 && <div className="px-3 py-2 text-ink-soft">No texts.</div>}
                    </div>
                  )}
                </div>
                {FURNITURE.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => void addItem(k)}
                    className="px-2 py-1 rounded-md flex items-center gap-1 text-ink-soft hover:bg-cream"
                    style={{ border: '1px solid var(--cline)' }}
                  >
                    {KIND_META[k].icon} {KIND_META[k].label}
                  </button>
                ))}
              </div>
            </div>

            {/* TOC preview */}
            <div className="w-80 shrink-0 overflow-auto px-4 py-4 bg-cream-hi"
                 style={{ borderLeft: '1px solid var(--cline)' }}>
              <div className="text-xs text-ink-soft mb-2 uppercase tracking-wide">Table of contents</div>
              {toc.length === 0 ? (
                <div className="text-xs text-ink-soft">Add a text page to populate the contents.</div>
              ) : (
                <div className="flex flex-col gap-3 text-sm">
                  {toc.map(entry => (
                    <div key={entry.item_id}>
                      <div className="font-medium text-lapis tibetan-text-sm">{entry.text_title}</div>
                      {entry.sections.length > 0
                        ? <TocSections sections={entry.sections} />
                        : <div className="text-xs text-ink-soft italic">no sections</div>}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 text-[11px] text-ink-soft italic">
                Page numbers appear once pagination is built.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
