import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Library, Plus, Trash2, ChevronUp, ChevronDown, FileText, Image as ImageIcon,
  BookOpen, List, Square, BookMarked, LayoutTemplate, Pencil, GitBranch,
} from 'lucide-react';
import { useDocumentStore } from '../../store/useDocumentStore';
import { useTextStore } from '../../store/useTextStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore } from '../../store/useTranslationStore';
import {
  getLanguages, getFurniture, putFurniture, getDocumentLayout,
  getVersions,
  uploadItemImage, deleteItemImage, itemImageUrl, setItemImageSize, withUrlAuth,
  type Language, type DocumentItemKind, type DocumentItem, type DocumentFurnitureRow,
} from '../../api/client';
import { PaginationBench } from './PaginationBench';
import { VersionsPanel } from './Versions';
import { useCan } from '../../store/usePermissions';
import { compileDocument } from './compile';
import {
  deriveBooklet, TIBETAN_LANG, TITLE_BLOCKS, TITLE_BLOCK_META,
  type NavNode, type TitleBlock,
} from './bookletRender';
import { cleanSpecimenHtml, stripAttrs } from './StyleStudio';

/** Furniture kinds with an editor: per-language authored text and an uploaded, resizable
 *  image. These were two identically-populated constants — two names for one concept, which
 *  implied a distinction the code never made. */
const EDITABLE_FURNITURE: DocumentItemKind[] = ['cover', 'image_page', 'backcover'];

/**
 * One title slot's text, edited as it will PRINT rather than as the markup behind it.
 *
 * A title page's slots carry emphasis (a work's name inside "From …") and deliberate line
 * breaks. Typed as source those are `<em>` and `<br>` — which is asking someone setting a
 * title page to read HTML, and to spot the difference between the two when the whole point
 * of the field is how the line looks.
 *
 * Uncontrolled: `innerHTML` is written once, or the caret jumps to the front on every
 * keystroke. The parent re-`key`s the element when the override appears or goes, which is
 * what re-seeds it.
 *
 * `cleanSpecimenHtml` is the Style Studio's sanitizer, reused deliberately rather than
 * copied: it keeps exactly `<strong>`/`<em>`/`<br>` and unwraps everything else — including
 * the inline `style` contentEditable freezes the computed font into, which would otherwise
 * outrank the block's role and pin this line's size forever.
 */
const RichLine: React.FC<{
  html: string; placeholder?: string; onCommit: (html: string) => void;
}> = ({ html, placeholder, onCommit }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (ref.current) ref.current.innerHTML = html; }, []); // eslint-disable-line

  /**
   * Commit while typing, not only on the way out.
   *
   * Blur alone is not enough to be safe: collapsing the panel unmounts the field, and an
   * unmount is not a blur — the edit would simply be gone, with nothing to say so. The
   * debounce keeps that from being a write per keystroke, and `commit` is idempotent
   * (`saveFurniture` returns early when the value has not moved), so the blur and the unmount
   * below can both call it without writing twice.
   */
  const timer = useRef<number>(0);
  const commit = () => {
    if (!ref.current) return;
    onCommit(cleanSpecimenHtml(ref.current.innerHTML));
  };
  const commitSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, 600);
  };
  // Flush on the way out — the debounce may still be pending when the panel closes.
  useEffect(() => () => { window.clearTimeout(timer.current); commit(); }, []); // eslint-disable-line

  const exec = (cmd: 'bold' | 'italic') => {
    ref.current?.focus();
    document.execCommand(cmd);
    stripAttrs(ref.current!);
    commitSoon();
  };
  return (
    <span className="flex-1 flex items-start gap-1">
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="flex-1 px-2 py-1 rounded-md bg-white text-xs bk-richline"
        style={{ border: '1px solid var(--cline)', minHeight: '1.75rem' }}
        onFocus={() => setFocused(true)}
        onInput={() => { stripAttrs(ref.current!); commitSoon(); }}
        onKeyDown={e => {
          // Enter is a LINE BREAK here, never a new paragraph: a slot is one block, and its
          // breaks are where the type turns, not where a new block starts.
          if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
        }}
        onBlur={() => { setFocused(false); window.clearTimeout(timer.current); commit(); }}
      />
      {/* Shown only while the field has focus — six slots times four languages would be a
          wall of buttons otherwise. `onMouseDown` preventDefault keeps the caret (and the
          selection the command applies to) instead of blurring the field. */}
      {focused && (
        <span className="flex gap-0.5 shrink-0 pt-0.5">
          {(['bold', 'italic'] as const).map(cmd => (
            <button key={cmd} type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => exec(cmd)}
                    title={cmd === 'bold' ? 'Bold (Ctrl+B)' : 'Italic (Ctrl+I)'}
                    className="w-5 h-5 rounded text-[11px] text-ink-soft hover:text-lapis hover:bg-cream"
                    style={{ border: '1px solid var(--cline)',
                             fontWeight: cmd === 'bold' ? 700 : 400,
                             fontStyle: cmd === 'italic' ? 'italic' : 'normal' }}>
              {cmd === 'bold' ? 'B' : 'I'}
            </button>
          ))}
        </span>
      )}
    </span>
  );
};

/** A furniture body was authored as `<p>`-delimited paragraphs; the rich editor (like the title
 *  slots) speaks `<br>`. Convert paragraph boundaries to line breaks so opening a legacy body in
 *  `RichLine` shows its lines and re-saves them as `<br>` rather than joining them. `splitParagraphs`
 *  renders a `<br>`-only body as one centred block, so the page is unchanged. */
function bodyToRich(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '<br>')
    .replace(/<\/?p[^>]*>/gi, '')
    .trim();
}

const KIND_META: Record<DocumentItemKind, { label: string; icon: React.ReactNode }> = {
  cover: { label: 'Cover', icon: <BookOpen size={14} /> },
  blank: { label: 'Blank page', icon: <Square size={14} /> },
  toc: { label: 'Table of contents', icon: <List size={14} /> },
  text: { label: 'Text', icon: <FileText size={14} /> },
  image_page: { label: 'Image', icon: <ImageIcon size={14} /> },
  backcover: { label: 'Back cover', icon: <BookMarked size={14} /> },
};
const FURNITURE: DocumentItemKind[] = ['cover', 'blank', 'toc', 'image_page', 'backcover'];

/** The booklet's navigation outline (what the PDF's bookmarks contain): each text with
 *  its translation-pane headings nested by level, translated labels + reader folio. */
const NavOutline: React.FC<{ nodes: NavNode[]; depth?: number }> = ({ nodes, depth = 0 }) => (
  <div>
    {nodes.map((n, i) => (
      <div key={i}>
        <div style={{ paddingLeft: depth * 12 }} className="flex items-baseline gap-1 py-0.5">
          <span className={depth === 0 ? 'font-medium text-lapis' : 'text-ink-soft'}>
            {n.title || '—'}
          </span>
          <span className="flex-1 border-b border-dotted self-end mb-1"
                style={{ borderColor: 'var(--cline)' }} />
          <span className="text-ink-soft text-xs shrink-0">{n.folio}</span>
        </div>
        {n.children.length > 0 && <NavOutline nodes={n.children} depth={depth + 1} />}
      </div>
    ))}
  </div>
);

/**
 * Documents bench (Phase D1). Compose a booklet: order pages (text pages + furniture),
 * pick the publication languages, and preview the auto-generated table of contents.
 * Pagination and PDF export are the next phases; this is structure only.
 */
export const DocumentsView: React.FC = () => {
  // Permission-read on Documents: browse, open, preview and export stay; every
  // structural edit (create/rename/delete, pages, languages, furniture) hides.
  const canEditDocs = useCan('documents').canModify;
  const list = useDocumentStore(s => s.list);
  const current = useDocumentStore(s => s.current);
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
  const treeVersion = useTreeNodeStore(s => s.version);
  const trVersion = useTranslationStore(s => s.version);

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
  const [navPreview, setNavPreview] = useState<NavNode[]>([]);
  // Per cover item: the Tibetan its text supplies. What the cover shows when the booklet has
  // no Tibetan of its own, and what the editor's field is seeded from.
  const [sourceTibetan, setSourceTibetan] = useState<Map<number, string>>(new Map());
  /**
   * Per language: the paragraphs of the text's title translation, which are what the title
   * page's slots follow when the booklet has not overridden them — `[0]` the main title,
   * `[1]` the sub-title, `[2]` the origin, `[3]` the author.
   *
   * Compiled only while a title-bearing panel is OPEN, and once per language. The nav
   * preview above compiles the selected edition only; seeding every field needs them all,
   * which is too much work to do on merely opening the document.
   */
  const [sourceSlots, setSourceSlots] = useState<Map<string, string[]>>(new Map());
  const [slotsFor, setSlotsFor] = useState<number | null>(null);   // which item they describe
  const [navLang, setNavLang] = useState<string>('');
  const [navLoading, setNavLoading] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [latestSemver, setLatestSemver] = useState<string | null>(null);
  const pickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchList();
    fetchTexts();
    getLanguages().then(setLangs).catch(() => {});
  }, [fetchList, fetchTexts]);

  // Load furniture content whenever the open document changes.
  useEffect(() => {
    if (current) {
      getFurniture(current.id).then(setFurniture).catch(() => setFurniture([]));
    } else { setFurniture([]); }
    setEditingItem(null);
    setShowVersions(false);
  }, [current?.id]);

  // The current-version chip: the newest 'ready' semver. Refreshed on open and whenever the
  // versions drawer closes (a bump made there may have produced a new tip).
  const refreshLatestVersion = useCallback(() => {
    if (!current) { setLatestSemver(null); return; }
    getVersions(current.id)
      .then(vs => setLatestSemver(vs.find(v => v.status === 'ready')?.semver ?? null))
      .catch(() => setLatestSemver(null));
  }, [current?.id]);
  useEffect(() => { refreshLatestVersion(); }, [refreshLatestVersion]);

  // Compute the real navigation outline (what the PDF bookmarks contain) for the preview
  // pane — same pipeline as the print page, so preview == PDF navigation.
  useEffect(() => {
    if (!current) { setNavPreview([]); return; }
    const edition = current.languages.includes(navLang) ? navLang : (current.languages[0] ?? 'en');
    if (edition !== navLang) { setNavLang(edition); return; }
    const hasText = current.items.some(i => i.kind === 'text' && i.text_id != null);
    if (!hasText) { setNavPreview([]); return; }
    let alive = true;
    setNavLoading(true);
    (async () => {
      try {
        const [compiled, layout, furn] = await Promise.all([
          compileDocument(current.items, edition),
          getDocumentLayout(current.id),
          getFurniture(current.id),
        ]);
        if (!alive) return;
        const d = deriveBooklet(current.items, layout.rows, compiled.lines, compiled.titleByItem,
                               furn, edition, false, compiled.headingsByItem);
        setNavPreview(d.navOutline);
        // The Tibetan the cover shows when this booklet has not been given its own — the
        // string the editor's field is SEEDED from, so an override starts as a copy of what
        // is already on the page rather than as an empty box to retype it into.
        // One line per LINE. The cover draws each title line as its own block, so joining
        // them into one string would seed the field with a flattened title — and saving that
        // back would collapse the cover to a single line.
        const tibOf = (ls: { tokens: { render: string }[] }[]) =>
          ls.map((l) => l.tokens.map((t) => t.render).join('').trim())
            .filter(Boolean).join('\n');
        setSourceTibetan(new Map(current.items
          .filter((it) => it.kind === 'cover')
          .map((it) => [it.id, tibOf(d.mainTitleLines)])));
      } catch { if (alive) setNavPreview([]); }
      finally { if (alive) setNavLoading(false); }
    })();
    return () => { alive = false; };
    // The outline is the TRANSLATION pane's headings (tree depth still nests them), so
    // curating either re-derives the preview without a reload.
  }, [current?.id, current?.items, navLang, treeVersion, trVersion]);

  /**
   * Seed the title slots for the panel that is open, one compile per language.
   *
   * Gated on the panel rather than the document because it is N compiles, and nobody pays
   * for them until they actually open a cover. `slotsFor` records which item the map
   * describes, so a stale map cannot seed the wrong page's fields.
   */
  useEffect(() => {
    const it = current?.items.find(i => i.id === editingItem);
    if (!current || !it || it.kind !== 'cover') { setSourceSlots(new Map()); setSlotsFor(null); return; }
    let alive = true;
    (async () => {
      const next = new Map<string, string[]>();
      for (const lg of current.languages) {
        try {
          const c = await compileDocument(current.items, lg);
          if (!alive) return;
          // The same paragraphs the page reads: the title chunk's `<p>` structure, carried
          // on whichever title line has it.
          const tl = [...c.titleByItem.values()][0] ?? [];
          next.set(lg, tl.find(t => t.paragraphs?.length)?.paragraphs
                    ?? tl.map(t => t.translation).filter((x): x is string => !!x));
        } catch { /* a language that will not compile simply seeds nothing */ }
      }
      if (alive) { setSourceSlots(next); setSlotsFor(it.id); }
    })();
    return () => { alive = false; };
  }, [current?.id, editingItem, current?.items, current?.languages, trVersion]);

  /** What the text supplies for one slot in one edition — the seed, and the "following the
   *  text" value the field is compared against. */
  const slotSeed = (itemId: number, langCode: string, block: TitleBlock) =>
    (slotsFor === itemId ? sourceSlots.get(langCode)?.[TITLE_BLOCK_META[block].seed] : '') ?? '';

  const furnitureBody = (itemId: number, langCode: string, block = '') =>
    furniture.find(f => f.item_id === itemId && f.lang === langCode
                     && (f.block ?? '') === block)?.body ?? '';


  /**
   * The cover's Tibetan, when this booklet has been given its own.
   *
   * Left equal to the text's, nothing is stored and the cover goes on FOLLOWING the text —
   * so a blur on an untouched field does not quietly freeze a copy of it, and clearing the
   * box hands it back. That is the difference between seeding a field and forking the data.
   */
  const saveTibetan = async (itemId: number, body: string) => {
    const source = (sourceTibetan.get(itemId) ?? '').trim();
    const next = body.trim();
    await saveFurniture(itemId, TIBETAN_LANG, next === source ? '' : next);
  };
  /**
   * One title slot, on the same terms as the Tibetan above: left equal to what the text
   * supplies, nothing is stored and the slot goes on FOLLOWING the text. So blurring an
   * untouched field cannot quietly freeze a copy of it, and emptying the box hands the slot
   * back to the text rather than blanking the page.
   */
  const saveSlot = async (itemId: number, langCode: string, block: TitleBlock, html: string) => {
    // Both sides are the stored HTML — the field edits marks and breaks, not their markup,
    // and hands back the same shape it was given. An untouched field therefore equals its
    // seed exactly and does not read as an override. The seed goes through the same
    // sanitizer so a difference can only ever be one the user actually made.
    const seed = cleanSpecimenHtml(slotSeed(itemId, langCode, block)).trim();
    const next = html.trim();
    await saveFurniture(itemId, langCode, next === seed ? '' : next, block);
  };
  const saveFurniture = async (
    itemId: number, langCode: string, body: string, block = '',
  ) => {
    if (!current) return;
    if (body === furnitureBody(itemId, langCode, block)) return;
    try {
      const row = await putFurniture(current.id, { item_id: itemId, lang: langCode, block, body });
      setFurniture(prev => [
        ...prev.filter(f => !(f.item_id === itemId && f.lang === langCode
                           && (f.block ?? '') === block)), row,
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
  const sizeTimer = useRef<number>(0);
  /**
   * The size being typed, held until the debounce fires.
   *
   * Both inputs share one timer, so typing a width and then a height inside the window
   * cancels the width's call — and each input used to read the OTHER dimension off the
   * item prop, which the cancelled call had not yet updated. The second call therefore
   * resubmitted the pre-edit width and the width edit was silently lost. Accumulating both
   * dimensions here means whichever call lands carries the latest of each.
   */
  const pendingSize = useRef<{ itemId: number; w: number | null; h: number | null } | null>(null);
  const onResizeImage = (itemId: number, dim: 'w' | 'h', value: number | null, it: DocumentItem) => {
    if (!current) return;
    const base = pendingSize.current?.itemId === itemId
      ? pendingSize.current
      : { itemId, w: it.image_width_mm ?? null, h: it.image_height_mm ?? null };
    const next = { ...base, itemId, [dim]: value };
    pendingSize.current = next;
    window.clearTimeout(sizeTimer.current);
    sizeTimer.current = window.setTimeout(async () => {
      pendingSize.current = null;
      try { await setItemImageSize(itemId, next.w, next.h); await open(current.id); }
      catch { /* ignore */ }
    }, 400);
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
        {canEditDocs && (
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
        )}
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
              <h2 className={`font-display text-xl text-lapis truncate max-w-sm ${canEditDocs ? 'cursor-text' : ''}`}
                  title={canEditDocs ? 'Click to rename' : undefined}
                  onClick={canEditDocs ? startRename : undefined}>
                {current.title}
              </h2>
            )}
            {latestSemver && (
              <span className="px-1.5 py-0.5 rounded-full text-[11px] text-lapis bg-cream-hi shrink-0"
                    style={{ border: '1px solid var(--cline)' }}
                    title="Latest published version">
                v{latestSemver}
              </span>
            )}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-ink-soft mr-1">languages</span>
              {languages.map(l => {
                const on = current.languages.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    disabled={!canEditDocs}
                    onClick={() => canEditDocs && toggleLang(l.code)}
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
              onClick={() => setShowVersions(s => !s)}
              className={`px-2 py-1 rounded-md text-xs flex items-center gap-1 ${
                showVersions ? 'bg-lapis text-cream-hi' : 'text-lapis hover:bg-cream'}`}
              style={{ border: '1px solid var(--cline)' }}
              title="Versions: freeze and consult frozen PDFs"
            >
              <GitBranch size={13} /> versions
            </button>
            <div className="flex-1" />
            {error && <span className="text-vermilion text-xs truncate max-w-xs" title={error}>{error}</span>}
            {canEditDocs && (
            <button
              type="button"
              onClick={() => { if (confirm(`Delete "${current.title}"?`)) void remove(current.id); }}
              className="px-2 py-1 rounded-md text-vermilion hover:bg-cream text-xs flex items-center gap-1"
              style={{ border: '1px solid var(--cline)' }}
            >
              <Trash2 size={13} /> delete
            </button>
            )}
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
                      {editable && canEditDocs && (
                        <button type="button"
                                onClick={() => setEditingItem(editingItem === it.id ? null : it.id)}
                                className={`p-0.5 hover:text-lapis ${editingItem === it.id ? 'text-lapis' : 'text-ink-soft'}`}
                                title={isTextItem ? 'Edit table-of-contents title (per language)' : 'Edit content (per language)'}>
                          <Pencil size={13} />
                        </button>
                      )}
                      {canEditDocs && (<>
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
                      </>)}
                    </div>
                    {editable && canEditDocs && editingItem === it.id && (
                      <div className="ml-8 mt-1 mb-2 p-2 rounded-md bg-cream-hi flex flex-col gap-1.5"
                           style={{ border: '1px solid var(--cline)' }}>
                        {EDITABLE_FURNITURE.includes(it.kind) && (
                          <div className="flex items-center gap-3 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            {it.has_image ? (
                              <img src={withUrlAuth(`${itemImageUrl(it.id)}?v=${imgBust}`)} alt=""
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
                              {it.has_image && (
                                <div className="flex items-center gap-1 text-[10px] text-ink-soft mt-0.5"
                                     title="Display size in mm. Set one and leave the other blank to keep the aspect ratio. Shared by every edition.">
                                  <span>size</span>
                                  <input type="number" min={0} step={1} defaultValue={it.image_width_mm ?? ''}
                                         placeholder="w" className="w-11 px-1 py-0.5 rounded bg-white"
                                         style={{ border: '1px solid var(--cline)' }}
                                         onChange={e => onResizeImage(it.id, 'w', e.target.value === '' ? null : Number(e.target.value), it)} />
                                  <span>×</span>
                                  <input type="number" min={0} step={1} defaultValue={it.image_height_mm ?? ''}
                                         placeholder="h" className="w-11 px-1 py-0.5 rounded bg-white"
                                         style={{ border: '1px solid var(--cline)' }}
                                         onChange={e => onResizeImage(it.id, 'h', e.target.value === '' ? null : Number(e.target.value), it)} />
                                  <span>mm</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {it.kind === 'cover' && (
                          <div className="flex flex-col gap-1 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            <div className="text-[11px] text-ink-soft flex items-center gap-2">
                              <span>Tibetan title — one line per line. Every edition prints it.</span>
                              {furnitureBody(it.id, TIBETAN_LANG) ? (
                                <button type="button"
                                        onClick={() => void saveFurniture(it.id, TIBETAN_LANG, '')}
                                        className="text-lapis hover:underline"
                                        title="Discard this booklet's own Tibetan and follow the text again">
                                  reset to the text’s
                                </button>
                              ) : (
                                <span className="text-jade">following the text</span>
                              )}
                            </div>
                            <textarea
                              // Re-seed when the override appears or goes: the box is
                              // uncontrolled, so without this "reset" would leave the old
                              // text sitting in it, contradicting the page.
                              key={`tib-${it.id}-${furnitureBody(it.id, TIBETAN_LANG) ? 'own' : 'src'}`}
                              defaultValue={furnitureBody(it.id, TIBETAN_LANG)
                                            || (sourceTibetan.get(it.id) ?? '')}
                              onBlur={e => void saveTibetan(it.id, e.target.value)}
                              rows={2} spellCheck={false}
                              placeholder="The text has no Tibetan title yet"
                              className="flex-1 px-2 py-1 rounded bg-white text-sm resize-y"
                              style={{ border: '1px solid var(--cline)',
                                       fontFamily: "'Chogyal', 'Jomolhari', serif", lineHeight: 1.6 }} />
                          </div>
                        )}
                        {/* The cover's translated slots, in the order the page prints them.
                            Each follows the text until it is overridden, exactly as the
                            Tibetan above does — so this panel now mirrors the page instead of
                            offering one field that did nothing. */}
                        {it.kind === 'cover' && current.languages.length > 0 && (
                          <div className="flex flex-col gap-2 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            {TITLE_BLOCKS.map(block => (
                              <div key={block} className="flex flex-col gap-1">
                                <div className="text-[11px] text-ink-soft">
                                  {TITLE_BLOCK_META[block].label} — per language
                                </div>
                                {current.languages.map(code => {
                                  const own = furnitureBody(it.id, code, block);
                                  const seed = slotSeed(it.id, code, block);
                                  return (
                                    <div key={code} className="flex items-start gap-2">
                                      <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                                      <RichLine
                                        // Re-seed when the override appears or goes: the box
                                        // is uncontrolled, so "reset" would otherwise leave
                                        // the old text sitting in it, contradicting the page.
                                        key={`${block}-${code}-${own ? 'own' : 'src'}-${seed}`}
                                        html={own || seed}
                                        placeholder={slotsFor === it.id ? 'follows the text' : 'loading…'}
                                        onCommit={h => void saveSlot(it.id, code, block, h)} />
                                      {own ? (
                                        <button type="button"
                                                onClick={() => void saveFurniture(it.id, code, '', block)}
                                                className="text-[10px] text-lapis hover:underline shrink-0"
                                                title="Discard this booklet's own text and follow the text again">
                                          reset
                                        </button>
                                      ) : (
                                        <span className="text-[10px] text-jade shrink-0">following</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* The free-form body. The cover has none: every one of its elements
                            is a named slot above, and the generic box it used to show was
                            never rendered on the page at all. */}
                        {it.kind !== 'cover' && (
                        <div className="text-[11px] text-ink-soft">
                          {isTextItem
                            ? 'Table-of-contents title — per language (blank = the text’s own title)'
                            : it.kind === 'image_page'
                              ? 'Caption — per language (optional; select text for italic/bold, Enter for a new line)'
                              : 'Back-cover text — per language (optional; select text for italic/bold, Enter for a new line)'}
                        </div>
                        )}
                        {current.languages.length === 0 && (
                          <span className="text-[11px] text-vermilion">Set the document's languages first.</span>
                        )}
                        {/* TOC title: a plain one-line field. Other furniture bodies (back cover,
                            image caption) use the same rich editor as the title slots — what you
                            see is what prints, with italic/bold and line breaks, no HTML tags. */}
                        {/* A plain <div>, NOT a <label>: a label around the contentEditable
                            RichLine re-targets the click on mouse-up and blurs it the instant you
                            click in (the title-slot rows are <div>s for the same reason). */}
                        {it.kind !== 'cover' && current.languages.map(code => (
                          <div key={code} className="flex items-start gap-2">
                            <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                            {isTextItem ? (
                              <textarea
                                defaultValue={furnitureBody(it.id, code)}
                                onBlur={e => void saveFurniture(it.id, code, e.target.value)}
                                rows={1}
                                placeholder="e.g. Essence of Accomplishment"
                                className="flex-1 px-2 py-1 rounded-md bg-white text-xs resize-y"
                                style={{ border: '1px solid var(--cline)' }}
                              />
                            ) : (
                              <RichLine
                                key={`body-${it.id}-${code}`}
                                html={bodyToRich(furnitureBody(it.id, code))}
                                placeholder={it.kind === 'backcover' ? 'e.g. Copyright © …' : 'Caption…'}
                                onCommit={h => void saveFurniture(it.id, code, h)} />
                            )}
                          </div>
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
              {canEditDocs && (
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
              )}
            </div>

            {/* Navigation-outline preview — what the PDF's bookmarks will contain. */}
            <div className="w-80 shrink-0 overflow-auto px-4 py-4 bg-cream-hi"
                 style={{ borderLeft: '1px solid var(--cline)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-ink-soft uppercase tracking-wide">PDF navigation</span>
                {current.languages.length > 1 && (
                  <div className="flex items-center gap-1">
                    {current.languages.map(code => (
                      <button key={code} type="button" onClick={() => setNavLang(code)}
                              className={`px-1.5 py-0.5 rounded text-[11px] ${
                                navLang === code ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}>
                        {code}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {navLoading ? (
                <div className="text-xs text-ink-soft">Building outline…</div>
              ) : navPreview.length === 0 ? (
                <div className="text-xs text-ink-soft">Add a text page to populate the contents.</div>
              ) : (
                <div className="text-sm">
                  <NavOutline nodes={navPreview} />
                </div>
              )}
              <div className="mt-4 text-[11px] text-ink-soft italic">
                The printed TOC page lists one line per text; this full outline is the PDF’s
                clickable navigation. Folios reflect the current pagination.
              </div>
            </div>

            {showVersions && (
              <VersionsPanel
                documentId={current.id}
                languages={current.languages}
                canEdit={canEditDocs}
                onClose={() => { setShowVersions(false); refreshLatestVersion(); }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
