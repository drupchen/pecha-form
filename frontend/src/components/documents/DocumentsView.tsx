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
  getLanguages, getFurniture, putFurniture, getDocumentLayout, extractTextPage,
  getVersions, patchDocumentItem, getOrgCopyright, getOrgImages, orgImageUrl,
  uploadItemImage, deleteItemImage, itemImageUrl, setItemImageSize, withUrlAuth,
  type Language, type DocumentItemKind, type DocumentItem, type DocumentFurnitureRow,
  type OrgImage,
  type DocumentSummary,
} from '../../api/client';
import { PaginationBench } from './PaginationBench';
import { VersionsPanel } from './Versions';
import { useCan } from '../../store/usePermissions';
import { compileDocument } from './compile';
import {
  deriveBooklet, TIBETAN_LANG, TITLE_BLOCKS, TITLE_BLOCK_META, coverFollowedBy,
  type TitleBlock,
} from './bookletRender';
import { cleanSpecimenHtml } from './StyleStudio';
import { RichLine, bodyToRich } from './RichLine';
import { orgImageFor, orgImagesOf, tocTitleSeed, furnitureBodyOf } from './bookletRender';

/** Furniture kinds with an editor panel of their own. (An aligned text has one too, but by
 *  carrying a text rather than by its kind — see `editable` at the item row.) */
const EDITABLE_FURNITURE: DocumentItemKind[] = ['cover', 'image_page', 'backcover'];
/** …and those whose picture the BOOKLET uploads. Only an image page: its picture is its own
 *  content. A cover and a back cover print the organization's — chosen from its lists, never
 *  uploaded here — so there is nothing on those pages for an uploader to do. */
const IMAGE_FURNITURE: DocumentItemKind[] = ['image_page'];
/** Pages that print one of the ORGANIZATION's images, each choosing from its own list. */
const ORG_IMAGE_PAGES: DocumentItemKind[] = ['cover', 'backcover'];

const KIND_META: Record<DocumentItemKind, { label: string; icon: React.ReactNode }> = {
  cover: { label: 'Cover', icon: <BookOpen size={14} /> },
  blank: { label: 'Blank page', icon: <Square size={14} /> },
  toc: { label: 'Table of contents', icon: <List size={14} /> },
  text: { label: 'Text', icon: <FileText size={14} /> },
  image_page: { label: 'Image', icon: <ImageIcon size={14} /> },
  backcover: { label: 'Back cover', icon: <BookMarked size={14} /> },
  textpage: { label: 'Aligned text', icon: <FileText size={14} /> },
};
const FURNITURE: DocumentItemKind[] = ['cover', 'blank', 'toc', 'image_page', 'backcover'];

/** The rail's two lists. An ALIGNED TEXT carries one text and the alignment of its Tibetan
 *  against its translations; a BOOKLET is what gets printed and reuses aligned texts. */
const SECTIONS: [ 'textpage' | 'booklet', string, string ][] = [
  ['textpage', 'Aligned texts', 'an aligned text'],
  ['booklet', 'Booklets', 'a booklet'],
];

/** The booklet's navigation outline (what the PDF's bookmarks contain): each text with
 *  its translation-pane headings nested by level, translated labels + reader folio. */

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
  const [newKind, setNewKind] = useState<'textpage' | 'booklet'>('booklet');
  const [editingTitle, setEditingTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pickingPage, setPickingPage] = useState(false);
  const [pickingNew, setPickingNew] = useState(false);
  const newPageRef = useRef<HTMLDivElement>(null);
  const [paginating, setPaginating] = useState(false);
  /** The bench is in overview: it wants the whole screen. */
  const [benchOverview, setBenchOverview] = useState(false);
  const [furniture, setFurniture] = useState<DocumentFurnitureRow[]>([]);
  const [editingItem, setEditingItem] = useState<number | null>(null);
  const [imgBust, setImgBust] = useState(0);   // cache-buster for image previews
  const [imgBusy, setImgBusy] = useState(false);
  // Per cover item: the Tibetan its text supplies. What the cover shows when the booklet has
  // no Tibetan of its own, and what the editor's field is seeded from. A TEXT item is in here
  // too, seeded from its own title — that is what its inner cover prints.
  const [sourceTibetan, setSourceTibetan] = useState<Map<number, string>>(new Map());
  /** Text items whose text carries a TAGGED TITLE. Only those have a title to place, so only
   *  those are offered the choice between a page of their own and heading their first page. */
  const [titledItems, setTitledItems] = useState<Set<number>>(new Set());
  /** The layout id of the text whose title the cover carries — read back from the derivation
   *  rather than re-derived, so this panel and the page agree on which text that is (and so
   *  which text therefore prints no title page of its own). Null when the cover carries
   *  nobody's: detached, or a booklet with no cover. */
  const [coverSourceItemId, setCoverSourceItemId] = useState<number | null>(null);
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
  /** Per language: the TOC entry this text supplies of its own — what the contents page prints
   *  when nobody has authored an entry for it, and so what the box below is seeded with.
   *  Described by the same `slotsFor` item as `sourceSlots`, filled by the same compiles. */
  const [tocSeeds, setTocSeeds] = useState<Map<string, string>>(new Map());
  const [navLang, setNavLang] = useState<string>('');
  const [showVersions, setShowVersions] = useState(false);
  const [latestSemver, setLatestSemver] = useState<string | null>(null);
  /** Bumped by "fill from the org template" — the only thing that rewrites a furniture body
   *  from outside its own field, and so the only thing that has to re-seed it. */
  const [fillEpoch, setFillEpoch] = useState(0);
  /** The organization's image library (seals, logos, marks). A cover or back cover picks one
   *  of these; the one marked for its kind stands in when it picks none. */
  const [orgImages, setOrgImages] = useState<OrgImage[]>([]);
  const pickPageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchList();
    fetchTexts();
    getLanguages().then(setLangs).catch(() => {});
    getOrgImages().then(setOrgImages).catch(() => setOrgImages([]));
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

  // Seed the cover's Tibetan from the compiled title lines. (The navigation outline used to
  // be built here too; it lives in the bench now, beside the pages it points at.)
  useEffect(() => {
    if (!current) return;
    const edition = current.languages.includes(navLang) ? navLang : (current.languages[0] ?? 'en');
    if (edition !== navLang) { setNavLang(edition); return; }
    const hasText = current.items.some(i => i.text_id != null);
    if (!hasText) return;
    let alive = true;
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
        // The Tibetan the cover shows when this booklet has not been given its own — the
        // string the editor's field is SEEDED from, so an override starts as a copy of what
        // is already on the page rather than as an empty box to retype it into.
        // One line per LINE. The cover draws each title line as its own block, so joining
        // them into one string would seed the field with a flattened title — and saving that
        // back would collapse the cover to a single line.
        const tibOf = (ls: { tokens: { render: string }[] }[]) =>
          ls.map((l) => l.tokens.map((t) => t.render).join('').trim())
            .filter(Boolean).join('\n');
        // A cover is seeded from the booklet's main title; a TEXT item — whose title page is
        // its inner cover — from its OWN title, which is the whole point of a page per text.
        // `titled` records which texts have a tagged title at all: without one there is
        // nothing to place and no choice to offer.
        const titled = new Set<number>();
        const seeds = new Map<number, string>();
        for (const it of current.items) {
          if (it.kind === 'cover') { seeds.set(it.id, tibOf(d.mainTitleLines)); continue; }
          if (it.text_id == null) continue;
          const own = compiled.titleByItem.get(it.layout_item_id ?? it.id) ?? [];
          if (!own.length) continue;
          titled.add(it.id);
          seeds.set(it.id, tibOf(own));
        }
        setSourceTibetan(seeds);
        setTitledItems(titled);
        setCoverSourceItemId(d.coverSourceItemId);
      } catch { /* the cover simply keeps its own text */ }
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
    // A text with no inner cover has no title BLOCKS and still has a TOC entry, so the gate is
    // "does this panel show anything seeded from a compile", not "does it show title slots".
    if (!current || !it || !(hasTitleBlocks(it) || it.text_id != null)) {
      setSourceSlots(new Map()); setTocSeeds(new Map()); setSlotsFor(null); return;
    }
    let alive = true;
    (async () => {
      const next = new Map<string, string[]>();
      const toc = new Map<string, string>();
      for (const lg of current.languages) {
        try {
          const c = await compileDocument(current.items, lg);
          if (!alive) return;
          // The same paragraphs the page reads: the title chunk's `<p>` structure, carried
          // on whichever title line has it. A text's INNER COVER follows its own text, which
          // is what makes a page per text worth having; a cover follows the text whose title
          // it carries — and a DETACHED cover follows none, so its fields seed from nothing
          // and an empty box is an empty box on the page too. That last part is not cosmetic:
          // `saveSlot` stores a value only when it DIFFERS from this seed, so seeding from a
          // text the cover has let go would file the words the user typed as "following it".
          const tl = (it.text_id != null
            ? c.titleByItem.get(it.layout_item_id ?? it.id)
            : (coverSourceItemId != null ? c.titleByItem.get(coverSourceItemId) : [])) ?? [];
          next.set(lg, tl.find(t => t.paragraphs?.length)?.paragraphs
                    ?? tl.map(t => t.translation).filter((x): x is string => !!x));
          // The contents entry, by the page's own rule — one function, so the box cannot show
          // one thing and the TOC print another.
          if (it.text_id != null) toc.set(lg, tocTitleSeed(c.titleByItem, it));
        } catch { /* a language that will not compile simply seeds nothing */ }
      }
      if (alive) { setSourceSlots(next); setTocSeeds(toc); setSlotsFor(it.id); }
    })();
    return () => { alive = false; };
  }, [current?.id, editingItem, current?.items, current?.languages, trVersion, coverSourceItemId]);

  /**
   * WHERE A TEXT'S TAGGED TITLE GOES, resolved.
   *
   * `'page'` — the text has an INNER COVER, a title page of its own before its first page.
   * `'body'` — no page; the title stays in the text and heads its first page.
   * `'none'` (and unset) — no inner title page and no title heading; this is the default.
   *
   * Must agree with `deriveBooklet`, which decides the same thing for the page itself.
   */
  const titleDisposition = (it: DocumentItem): 'none' | 'page' | 'body' =>
    it.title_disposition === 'page' || it.title_disposition === 'page_direct'
      ? 'page' : it.title_disposition === 'body' ? 'body' : 'none';
  const innerCoverOn = (it: DocumentItem): boolean => titleDisposition(it) === 'page';
  /** Pages that RENDER a text: the booklet's own ('text') and a reused aligned text page
   *  ('textpage'). Both get a table-of-contents entry, which is why this and not `kind`. */
  const isTextRow = (it: DocumentItem): boolean => it.text_id != null;

  /** Pages that print a title page's blocks — the cover, and a text showing its inner cover.
   *  Every field the cover's panel offers belongs to both. */
  const hasTitleBlocks = (it: DocumentItem): boolean =>
    it.kind === 'cover' || (titledItems.has(it.id) && innerCoverOn(it));

  /** The cover this text's inner cover follows, if a cover was seeded from this text — the
   *  same lookup the page makes, so the panel and the page agree on what a field follows. */
  const followedCover = (it: DocumentItem): DocumentItem | null =>
    (it.text_id != null ? coverFollowedBy(current?.items ?? [], it) : null);

  /** The aligned text this page's content was filled from, if it says so. Matched on the id
   *  `fillCoverFrom` writes — the layout id for a reused text page — which is the id the page
   *  itself resolves the binding by. */
  const seededFrom = (it: DocumentItem): DocumentItem | null =>
    (it.source_item_id != null
      ? (current?.items ?? []).find(i => (i.layout_item_id ?? i.id) === it.source_item_id) ?? null
      : null);

  /** A cover that STANDS ALONE: seeded from no aligned text, so what is authored on it prints
   *  and what is not stays blank. The same flag `deriveBooklet` reads to give it no title
   *  lines, which is what makes a blank slot print blank. */
  const coverDetached = (it: DocumentItem): boolean =>
    it.kind === 'cover' && (it.title_disposition ?? null) === 'own';

  /**
   * UNLINK THE COVER FROM THE ALIGNED TEXT — or link it back.
   *
   * A cover follows a text for its unauthored parts: every slot it has no words for prints
   * that text's corresponding paragraph, and its Tibetan is that text's title. That is right
   * for a booklet of one text, and wrong for a cover written for the whole book — where the
   * slots you leave empty are meant to BE empty, not to fill with the first text's words.
   *
   * Detaching keeps the words. That is the whole difference from "release" below, which
   * deletes them: this lets go of the text and leaves the page as you wrote it. The binding
   * goes with it, since a cover that carries nobody's title has no inner cover following it —
   * so every aligned text goes back to deriving its own title page from its own content.
   */
  const setCoverDetached = async (it: DocumentItem, detached: boolean) => {
    if (!current) return;
    try {
      await patchDocumentItem(it.id, detached
        ? { title_disposition: 'own', source_item_id: 0 }
        : { title_disposition: '' });
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not change the cover’s title' });
    }
  };

  /** True while this page has words of its own — any slot in any edition, or the Tibetan. */
  const hasOwnTitleText = (it: DocumentItem): boolean =>
    !!furnitureBody(it.id, TIBETAN_LANG)
    || (current?.languages ?? []).some(lg => TITLE_BLOCKS.some(b => !!furnitureBody(it.id, lg, b)));

  /**
   * Undo a fill: drop the copied words and let go of the text they came from.
   *
   * Filling writes the text's title into this page's slots as a COPY, so afterwards the page
   * no longer follows anything — which is right while you edit it, and wrong once you decide
   * the page is not about that text. Clearing every slot and the Tibetan puts the page back to
   * following (an absent row is what "follows" means), and clearing the binding releases the
   * text: its own inner cover stops taking this cover's words and spacing, and goes back to
   * its own title.
   */
  const releaseFromText = async (it: DocumentItem) => {
    if (!current) return;
    const from = seededFrom(it);
    if (!confirm(from
      ? `Delete the title text copied from “${from.text_title ?? from.ref_title ?? 'the aligned text'}” and release it?`
      : 'Delete this page’s own title text and follow the aligned text again?')) return;
    try {
      for (const lg of current.languages) {
        for (const block of TITLE_BLOCKS) await saveFurniture(it.id, lg, '', block);
      }
      await saveFurniture(it.id, TIBETAN_LANG, '');
      if (it.source_item_id != null) await patchDocumentItem(it.id, { source_item_id: 0 });
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not release the aligned text' });
    }
  };

  /**
   * WHICH ORG IMAGE THIS PAGE PRINTS.
   *
   * The library belongs to the organization and its images are inherited, not copied — so this
   * stores a REFERENCE, and replacing the picture in the settings changes this page with it.
   * `0` clears the reference, which puts the page back on the org's default for its kind: not
   * "no image", but "whatever the house prints here", which is where every page starts.
   *
   * The page's own uploaded image still outranks this. That is why both controls sit here
   * together — the upload above is this booklet's alone, the picker below is the house's.
   */
  const setOrgImage = async (it: DocumentItem, imageId: number | null) => {
    if (!current) return;
    try {
      await patchDocumentItem(it.id, { org_image_id: imageId ?? 0 });
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not change the image' });
    }
  };

  const setDisposition = async (it: DocumentItem, disposition: 'none' | 'page' | 'body') => {
    if (!current) return;
    try {
      // Written explicitly either way — never left to the default once the user has said so,
      // or adding a text above would silently change what an untouched page does.
      await patchDocumentItem(it.id, { title_disposition: disposition });
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not change the title page' });
    }
  };

  const setBlankBeforeTitle = async (it: DocumentItem, enabled: boolean) => {
    if (!current) return;
    try {
      await patchDocumentItem(it.id, { title_disposition: enabled ? 'page' : 'page_direct' });
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not change the page before the title' });
    }
  };

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
  /** What this text supplies for its contents entry in one edition — the seed, and the value
   *  the field is compared against. Empty until the compiles land, and only for the item they
   *  describe, so a stale map cannot seed the wrong text's entry. */
  const tocSeed = (itemId: number, langCode: string) =>
    (slotsFor === itemId ? tocSeeds.get(langCode) : '') ?? '';

  /**
   * This text's TABLE-OF-CONTENTS ENTRY in one edition, on the same terms as the cover's slots.
   *
   * Left equal to what the text supplies, nothing is stored and the entry goes on FOLLOWING the
   * text — so blurring an untouched field cannot quietly freeze a copy of the title, and
   * emptying the box hands the entry back rather than printing a blank line. Both sides pass
   * through the same sanitizer, so a difference can only ever be one the user actually made.
   */
  const saveTocTitle = async (itemId: number, langCode: string, html: string) => {
    const seed = cleanSpecimenHtml(tocSeed(itemId, langCode)).trim();
    const next = html.trim();
    await saveFurniture(itemId, langCode, next === seed ? '' : next);
  };

  /**
   * Fill a cover's zones from one of the booklet's aligned texts.
   *
   * A cover FOLLOWS the booklet's first text on its own — the slots seed from it live, and
   * stay empty in the data while they agree. That is silent about two cases the user meets:
   * a cover added after the texts, and a booklet holding several, where "the first" is not
   * necessarily the one whose title belongs on the cover. So this writes the chosen text's
   * title into the slots as an explicit copy, which can then be edited like any other.
   */
  const fillCoverFrom = async (into: DocumentItem, textItem: DocumentItem) => {
    if (!current) return;
    const coverId = into.id;
    const key = textItem.layout_item_id ?? textItem.id;
    try {
      // RECORD WHOSE TITLE THIS IS — on any page that carries title blocks. The seeding is a
      // copy, so afterwards nothing in the words says where they came from; this is what the
      // panel reads to say it, and what "release" undoes. On a COVER it means more: it is
      // also what decides whose inner cover follows this cover, content and spacing alike
      // (`coverFollowedBy`, which asks for `kind === 'cover'` and so cannot mistake an inner
      // cover's own record for a binding). A cover written by hand for a whole booklet is
      // seeded from no text and binds nobody.
      // Filling FROM a text is the opposite of standing alone, so a detached cover comes back
      // to following the text it is now filled from. Only on a cover: on a TEXT the same
      // column means where its own title goes, and clearing that would take away the very
      // inner cover being filled.
      await patchDocumentItem(coverId, into.kind === 'cover'
        ? { source_item_id: key, title_disposition: '' }
        : { source_item_id: key });
      for (const lg of current.languages) {
        const c = await compileDocument(current.items, lg);
        const tl = c.titleByItem.get(key) ?? [];
        const paras = tl.find(t => t.paragraphs?.length)?.paragraphs
                   ?? tl.map(t => t.translation).filter((x): x is string => !!x);
        for (const block of TITLE_BLOCKS) {
          // Only what the source actually has. An empty slot is not "blank" — `TitleContent`
          // reads it as "follow the text" and prints the seed, which is the FIRST text's
          // title. Writing '' would therefore both erase whatever was authored there and
          // show the other text's words in its place.
          const body = paras[TITLE_BLOCK_META[block].seed];
          if (body && body.trim()) await saveFurniture(coverId, lg, body, block);
        }
        if (lg === current.languages[0]) {
          // The Tibetan is one string for every edition (see `saveTibetan`), so it is written
          // once, from whichever compile came first — the tokens are the same in all of them.
          const tib = tl.map(l => l.tokens.map(t => t.render).join('').trim())
                        .filter(Boolean).join('\n');
          if (tib) await saveFurniture(coverId, TIBETAN_LANG, tib);
        }
      }
      // Re-read the items so the binding written above is in hand: it decides, from here on,
      // whose inner cover follows this cover.
      await open(current.id);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not fill the cover' });
    }
  };

  /**
   * Fill the back cover from the ORG'S COPYRIGHT TEMPLATE, one language at a time.
   *
   * Adding a back cover already seeds it (`_seed_copyright`, backend), which covers the
   * languages a booklet had at the time. This covers the rest: an edition added afterwards, a
   * template written after the booklet, and a page whose words have been cleared and wanted
   * back. It writes only where the org has something to say, and asks before replacing words
   * the booklet already carries — seeding a copy must never quietly overwrite an author.
   */
  const fillCopyrightFrom = async (it: DocumentItem) => {
    if (!current) return;
    try {
      const tpl = await getOrgCopyright();
      const usable = tpl.filter(t => current.languages.includes(t.lang) && t.body.trim());
      if (!usable.length) {
        useDocumentStore.setState({
          error: 'This organization has no copyright template for these languages yet '
               + '(Admin → Copyright).' });
        return;
      }
      const occupied = usable.filter(t => furnitureBody(it.id, t.lang).trim());
      if (occupied.length && !confirm(
        `Replace the back-cover text already written in ${occupied.map(t => t.lang).join(', ')}?`,
      )) return;
      for (const t of usable) await saveFurniture(it.id, t.lang, t.body);
      // Re-seed the boxes. They are uncontrolled, so without this the old words would sit in
      // them contradicting the page. Keyed on a COUNTER rather than on the body itself: the
      // body changes on every debounced keystroke-commit, and re-keying there would remount
      // the field mid-sentence and drop the caret.
      setFillEpoch(n => n + 1);
    } catch (e: any) {
      useDocumentStore.setState({ error: e.message || 'Could not read the org template' });
    }
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
      if (pickPageRef.current && !pickPageRef.current.contains(e.target as Node)) setPickingPage(false);
      if (newPageRef.current && !newPageRef.current.contains(e.target as Node)) setPickingNew(false);
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

  /** Open a document from the rail. An aligned text renders as its layout by itself (see the
   *  branch below); this only makes sure a booklet opened from a bench lands on its
   *  composition page rather than inheriting the previous document's bench. */
  /** Create an aligned text FROM a text: one action — the document takes the text's title,
   *  carries it, and opens on its layout, which is all an aligned text ever is. */
  const createAlignedText = async (t: { id: number; title: string }) => {
    const id = await create(t.title, 'textpage');
    if (id == null) return;
    await addItem('text', t.id);
    setPaginating(true);
  };

  const openDoc = async (d: DocumentSummary) => {
    setPaginating(false);
    await open(d.id);
  };

  /** Lift a booklet's own text page out into a reusable aligned text. The alignment travels
   *  with it (the item keeps its id), so the booklet still prints the same and the aligned
   *  text can now be added to other booklets already aligned. */
  const extract = async (itemId: number) => {
    if (!current) return;
    try {
      await extractTextPage(itemId);
      await open(current.id);
      await fetchList();
    } catch (e: any) { useDocumentStore.setState({ error: e.message || 'Could not extract the aligned text' }); }
  };

  // What this document IS decides what it may hold: a booklet composes aligned texts and
  // furniture; an aligned text carries its one text and nothing else.
  const isBooklet = (current?.kind ?? 'booklet') === 'booklet';
  const alignedTexts = list.filter(d => d.kind === 'textpage');
  const isTextPage = !isBooklet;
  /** The aligned texts a cover can take its title from, in page order. */
  const coverSources = (current?.items ?? []).filter(i => i.text_id != null);
  const hasOwnText = !!current?.items.some(i => i.text_id != null);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── Left rail: documents list ──
          It stays while a spread is being worked on, so moving between documents costs one
          click. OVERVIEW is the exception: every edition needs a column across the screen, and
          the rail is a column's worth of it. */}
      {!benchOverview && (
      <div className="w-64 shrink-0 flex flex-col bg-cream-hi overflow-hidden"
           style={{ borderRight: '1px solid var(--cline)' }}>
        <div className="px-4 py-3 flex items-center gap-2 font-display text-lg text-lapis"
             style={{ borderBottom: '1px solid var(--cline)' }}>
          <Library size={18} /> Documents
        </div>
        {/* An ALIGNED TEXT is one text plus its alignment, so it is created by CHOOSING that
            text — naming it separately was a step that could only introduce a mismatch. A
            BOOKLET is named: its name is its own, not a text's. */}
        {canEditDocs && newKind === 'textpage' && (
        <div className="px-3 py-2 flex flex-col gap-1 relative" style={{ borderBottom: '1px solid var(--cline)' }}
             ref={newPageRef}>
          <button
            type="button"
            onClick={() => setPickingNew(v => !v)}
            className="px-2 py-1 rounded-md text-sm text-lapis hover:bg-cream flex items-center gap-1"
            style={{ border: '1px solid var(--cline)' }}
          >
            <Plus size={14} /> New aligned text from a text…
          </button>
          {pickingNew && (
            <div className="absolute top-full left-3 right-3 z-30 max-h-72 overflow-auto rounded-md bg-white shadow-lg"
                 style={{ border: '1px solid var(--cline)' }}>
              {pickable.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setPickingNew(false); void createAlignedText(t); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-cream flex items-center gap-2 text-sm"
                >
                  <span className="tibetan-text-sm truncate flex-1">{t.title}</span>
                  <span className="text-[10px] text-ink-soft">{t.text_type}</span>
                </button>
              ))}
              {pickable.length === 0 && (
                <div className="px-3 py-2 text-ink-soft text-xs">No texts.</div>
              )}
            </div>
          )}
        </div>
        )}
        {canEditDocs && newKind === 'booklet' && (
        <div className="px-3 py-2 flex gap-1" style={{ borderBottom: '1px solid var(--cline)' }}>
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newTitle.trim()) { void create(newTitle.trim(), 'booklet'); setNewTitle(''); } }}
            placeholder="New booklet…"
            className="flex-1 min-w-0 px-2 py-1 rounded-md bg-white text-sm"
            style={{ border: '1px solid var(--cline)' }}
          />
          <button
            type="button"
            onClick={() => { if (newTitle.trim()) { void create(newTitle.trim(), 'booklet'); setNewTitle(''); } }}
            className="px-1.5 rounded-md text-lapis hover:bg-cream shrink-0"
            style={{ border: '1px solid var(--cline)' }}
            title="Create booklet"
          >
            <Plus size={16} />
          </button>
        </div>
        )}
        <div className="flex-1 overflow-auto py-1">
          {/* Two sections, because they are two different things. An ALIGNED TEXT is where the
              Tibetan and its translations are aligned once; a BOOKLET is what gets printed and
              reuses those alignments. The same aligned text can sit in a booklet of its own and
              inside a larger one without the work being done twice. */}
          {SECTIONS.map(([kind, label, blurb]) => {
            const rows = list.filter(d => (d.kind ?? 'booklet') === kind);
            return (
              <div key={kind} className="mb-1">
                <div className="px-4 pt-2 pb-1 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-bronze">{label}</span>
                  {canEditDocs && (
                    <button
                      type="button"
                      onClick={() => { setNewKind(kind); setPickingNew(kind === 'textpage'); }}
                      className={`text-[10px] px-1.5 rounded ${
                        newKind === kind ? 'bg-lapis/15 text-lapis' : 'text-ink-soft hover:bg-cream'
                      }`}
                      title={kind === 'textpage'
                        ? 'Choose a text to align'
                        : `The name box creates ${blurb}`}
                    >
                      + new
                    </button>
                  )}
                </div>
                {rows.length === 0 && (
                  <div className="px-4 pb-2 text-[11px] text-ink-soft/70 italic">
                    {kind === 'textpage' ? 'None yet — a booklet\'s text page can be extracted into one.'
                                         : 'None yet.'}
                  </div>
                )}
                {rows.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => void openDoc(d)}
                    className={`w-full text-left px-4 py-2 transition-colors ${
                      current?.id === d.id ? 'bg-lapis/10 text-lapis' : 'hover:bg-cream text-ink'
                    }`}
                  >
                    <div className="text-sm font-medium truncate">{d.title}</div>
                    <div className="text-[11px] text-ink-soft">
                      {/* PHYSICAL pages, recorded by the bench. The item count is a different
                          number and, for an aligned text, a misleading one — one item, and as
                          many pages as the text runs to. Rather than print a figure that is
                          wrong, say nothing until the bench has laid it out once. */}
                      {d.page_count != null
                        ? `${d.page_count} page${d.page_count === 1 ? '' : 's'}`
                        : d.kind === 'booklet'
                          ? `${d.item_count} item${d.item_count === 1 ? '' : 's'}`
                          : 'not laid out yet'}
                      {d.languages.length > 0 && ` · ${d.languages.join(' ')}`}
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* ── Right: the bench, or the composition page ──
          An ALIGNED TEXT is its layout: it has no pages to compose and no furniture to carry,
          so it opens the bench and stays there. The composition page belongs to booklets. */}
      {current && (paginating || (isTextPage && hasOwnText)) ? (
        <PaginationBench
          documentId={current.id}
          onClose={() => setPaginating(false)}
          onOverviewChange={setBenchOverview}
          onPageCount={() => void fetchList()}
        />
      ) : !current ? (
        <div className="flex-1 flex items-center justify-center text-ink-soft">
          Select a document, or create one.
        </div>
      ) : isTextPage ? (
        // An aligned text with no text yet: the one thing it needs, and nothing else.
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm">
          <span className="text-ink-soft">Choose the text this aligned text carries.</span>
          {canEditDocs && (
            <div className="w-72 max-h-72 overflow-auto rounded-md bg-white shadow-sm"
                 style={{ border: '1px solid var(--cline)' }}>
              {pickable.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void addItem('text', t.id)}
                  className="w-full text-left px-3 py-1.5 hover:bg-cream flex items-center gap-2"
                >
                  <span className="tibetan-text-sm truncate flex-1">{t.title}</span>
                  <span className="text-[10px] text-ink-soft">{t.text_type}</span>
                </button>
              ))}
              {pickable.length === 0 && <div className="px-3 py-2 text-ink-soft">No texts.</div>}
            </div>
          )}
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
              // Any page that CARRIES a text: the booklet's own, or an aligned text it
              // reuses (kind 'textpage', resolved to its text by the API). Testing the kind
              // left every booklet of aligned texts unopenable.
              disabled={!current.items.some(i => i.text_id != null)}
              className="px-2 py-1 rounded-md text-lapis hover:bg-cream text-xs flex items-center gap-1 disabled:opacity-40"
              style={{ border: '1px solid var(--cline)' }}
              title="Open the pagination bench"
            >
              <LayoutTemplate size={13} /> layout
            </button>
            {isBooklet && (
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
            )}
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
                  // Every page that RENDERS a text — the booklet's own and a reused aligned
                  // text page alike. `isTextItem` is only the former, which is why the
                  // contents-title field used to miss every booklet built out of text pages.
                  const isText = isTextRow(it);
                  // An ALIGNED TEXT in a booklet is a 'textpage' item, and it too has a panel
                  // now: the title it carries can head a page of its own — its inner cover —
                  // and those fields are edited here, beside the text they belong to.
                  const editable = isTextItem || it.text_id != null
                    || EDITABLE_FURNITURE.includes(it.kind);
                  return (
                  <div key={it.id}>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white"
                         style={{ border: '1px solid var(--cline)' }}>
                      <span className="text-ink-soft w-6 text-right text-xs">{i + 1}</span>
                      <span className="text-lapis">{KIND_META[it.kind].icon}</span>
                      <span className="text-sm flex-1 truncate">
                        {it.kind === 'text'
                          ? (it.text_title ?? <span className="text-vermilion">missing text</span>)
                          : it.kind === 'textpage'
                            ? <>
                                {it.text_title ?? it.ref_title ?? <span className="text-vermilion">missing text page</span>}
                                <span className="ml-2 text-[10px] px-1.5 rounded-full bg-jade/15 text-jade">
                                  aligned text
                                </span>
                              </>
                            : <span className="text-ink-soft">{KIND_META[it.kind].label}</span>}
                      </span>
                      {/* A booklet's OWN text page can be lifted out into a reusable aligned text.
                          The item is moved, not copied — its id is what its alignment is keyed by,
                          so every break, split, gap and width comes along and this booklet prints
                          exactly as before. */}
                      {isTextItem && isBooklet && canEditDocs && (
                        <button type="button"
                                onClick={() => void extract(it.id)}
                                className="text-[10px] px-1.5 py-0.5 rounded text-lapis hover:bg-cream shrink-0"
                                style={{ border: '1px solid var(--cline)' }}
                                title="Move this text page out into a reusable aligned text, keeping its alignment — then it can be used in other booklets too">
                          extract
                        </button>
                      )}
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
                        {/* WHERE THIS TEXT'S TAGGED TITLE GOES. Offered only where there is a
                            title to place: a text without one has nothing to decide, and its
                            page simply shows what it has. The fields below appear with the
                            page — an inner cover is the cover minus the seal, so it is edited
                            with the cover's own controls. */}
                        {titledItems.has(it.id) && (
                          <div className="flex items-center gap-2 pb-1.5 mb-0.5 text-[11px]"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            <span className="text-ink-soft">Its title</span>
                            {([['none', 'no inner title page'],
                               ['page', 'on a page of its own'],
                               ['body', 'heading its first page']] as const).map(([disposition, label]) => (
                              <button key={label} type="button"
                                      onClick={() => void setDisposition(it, disposition)}
                                      className={`px-2 py-0.5 rounded-md ${
                                        titleDisposition(it) === disposition
                                          ? 'bg-lapis text-white' : 'text-lapis hover:bg-cream'}`}
                                      style={{ border: '1px solid var(--cline)' }}>
                                {label}
                              </button>
                            ))}
                            {titleDisposition(it) === 'page' && (
                              <label className="ml-1 flex items-center gap-1 text-lapis cursor-pointer">
                                <input type="checkbox"
                                       checked={it.title_disposition !== 'page_direct'}
                                       onChange={e => void setBlankBeforeTitle(it, e.target.checked)} />
                                empty page before
                              </label>
                            )}
                          </div>
                        )}
                        {/* WHERE THE COVER'S TITLE COMES FROM — the same shape of choice, for
                            the page at the other end of it. A cover seeds every part it has no
                            words of its own for from an aligned text, which is what a booklet
                            of one text wants and what a book with a title of its own does not:
                            there, an empty slot is meant to BE empty. Detaching keeps whatever
                            has been written here — it lets the text go, it does not delete
                            (that is "release" below). */}
                        {it.kind === 'cover' && (
                          <div className="flex items-center gap-2 pb-1.5 mb-0.5 text-[11px]"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            <span className="text-ink-soft">Its title</span>
                            {([[false, 'from the aligned text'],
                               [true, 'its own']] as const).map(([own, label]) => (
                              <button key={label} type="button"
                                      onClick={() => void setCoverDetached(it, own)}
                                      className={`px-2 py-0.5 rounded-md ${
                                        coverDetached(it) === own
                                          ? 'bg-lapis text-white' : 'text-lapis hover:bg-cream'}`}
                                      style={{ border: '1px solid var(--cline)' }}
                                      title={own
                                        ? 'This cover stands alone: what is written here prints, '
                                          + 'and what is not stays blank. Every aligned text then '
                                          + 'gets its own title page, from its own content.'
                                        : 'Every part this cover has no words of its own for '
                                          + 'follows an aligned text’s title.'}>
                                {label}
                              </button>
                            ))}
                            {coverDetached(it)
                              ? <span className="text-ink-soft">— blank stays blank</span>
                              : <span className="text-ink-soft">
                                  — {seededFrom(it)
                                       ? <span className="text-ink">
                                           {seededFrom(it)!.text_title ?? seededFrom(it)!.ref_title
                                             ?? `#${it.source_item_id}`}
                                         </span>
                                       : 'the first'}
                                </span>}
                          </div>
                        )}
                        {IMAGE_FURNITURE.includes(it.kind) && (
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
                        {/* THE PAGE'S IMAGE — the organization's, chosen from the list for
                            this kind of page. There is no uploader here: a cover prints a
                            house seal and a back cover a house mark, and both belong to the
                            organization rather than to one booklet (Admin → Cover & back cover
                            images). The box shows what will actually print, so choosing in the
                            menu fills it in. */}
                        {ORG_IMAGE_PAGES.includes(it.kind) && (() => {
                          const kind = it.kind === 'cover' ? 'cover' : 'backcover';
                          const list = orgImagesOf(orgImages, kind);
                          const shown = orgImageFor(orgImages, it, kind);
                          const label = kind === 'cover' ? 'Cover seal' : 'Back-cover image';
                          const fallback = list.find(i => i.is_default);
                          return (
                            <div className="flex items-start gap-3 pb-1.5 mb-0.5"
                                 style={{ borderBottom: '1px solid var(--cline)' }}>
                              {/* The image location, filled by whatever the page resolves to:
                                  the legacy own upload if this booklet still has one, else the
                                  chosen house image, else nothing. */}
                              {it.has_image ? (
                                <img src={withUrlAuth(`${itemImageUrl(it.id)}?v=${imgBust}`)} alt=""
                                     className="h-16 w-16 object-contain rounded bg-white shrink-0"
                                     style={{ border: '1px solid var(--cline)' }} />
                              ) : shown ? (
                                <img src={withUrlAuth(orgImageUrl(shown.id))} alt=""
                                     className="h-16 w-16 object-contain rounded bg-white shrink-0"
                                     style={{ border: '1px solid var(--cline)' }} />
                              ) : (
                                <div className="h-16 w-16 rounded bg-white shrink-0 flex items-center justify-center text-[10px] text-ink-soft text-center px-1"
                                     style={{ border: '1px dashed var(--cline)' }}>
                                  {kind === 'cover' ? 'ༀ glyph' : 'no image'}
                                </div>
                              )}
                              <div className="flex flex-col gap-1 min-w-0">
                                <span className="text-[11px] text-ink-soft">{label}</span>
                                {list.length === 0 ? (
                                  <span className="text-[11px] text-ink-soft">
                                    The organization has no {label.toLowerCase()}s yet —
                                    add one in Admin → Cover &amp; back cover images.
                                  </span>
                                ) : (
                                  <select
                                    value={it.org_image_id ?? ''}
                                    disabled={!canEditDocs}
                                    onChange={e => void setOrgImage(
                                      it, e.target.value === '' ? null : Number(e.target.value))}
                                    className="px-2 py-1 rounded-md bg-white text-xs"
                                    style={{ border: '1px solid var(--cline)' }}>
                                    <option value="">
                                      {fallback
                                        ? `The organization’s — ${fallback.name || `#${fallback.id}`}`
                                        : 'The organization’s — none set'}
                                    </option>
                                    {list.map(i => (
                                      <option key={i.id} value={i.id}>{i.name || `#${i.id}`}</option>
                                    ))}
                                  </select>
                                )}
                                {/* A booklet that uploaded its own picture before these became
                                    the organization's still prints it — say so, and offer the
                                    way back rather than leaving an image nothing can explain. */}
                                {it.has_image && (
                                  <span className="text-[11px] text-vermilion flex items-center gap-1.5">
                                    This page carries its own uploaded image, which wins.
                                    <button type="button" onClick={() => void onRemoveImage(it.id)}
                                            disabled={imgBusy}
                                            className="text-lapis hover:underline disabled:opacity-40">
                                      remove it
                                    </button>
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                        {/* THE CONTENTS ENTRY — what this text is called on the table of
                            contents, per edition. Its own block rather than part of the
                            free-form body below, because a text that also shows an inner cover
                            has both, and both belong on its panel: one is the entry in the
                            list, the other the title page itself. */}
                        {isText && current.languages.length > 0 && (
                          <div className="flex flex-col gap-1 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            <div className="text-[11px] text-ink-soft">
                              Table-of-contents title — per language
                            </div>
                            {current.languages.map(code => {
                              // Read by BOTH ids, as the page does: a row written before this
                              // text was extracted into its own page carries the layout id, and
                              // looking it up by one id only showed an override on the page that
                              // the box swore was not there.
                              const own = furnitureBodyOf(furniture, it, code) ?? '';
                              const seed = tocSeed(it.id, code);
                              return (
                                <div key={code} className="flex items-start gap-2">
                                  <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                                  <RichLine
                                    // Re-seed when the override appears or goes: the box is
                                    // uncontrolled, so "reset" would otherwise leave the old
                                    // words sitting in it, contradicting the page.
                                    key={`toc-${it.id}-${code}-${own ? 'own' : 'src'}-${seed}`}
                                    html={own || seed}
                                    placeholder={slotsFor === it.id ? 'follows the text' : 'loading…'}
                                    onCommit={h => void saveTocTitle(it.id, code, h)} />
                                  {own ? (
                                    <button type="button"
                                            onClick={() => void saveFurniture(it.id, code, '')}
                                            className="text-[10px] text-lapis hover:underline shrink-0"
                                            title="Discard this entry and follow the text's own title again">
                                      reset
                                    </button>
                                  ) : (
                                    <span className="text-[10px] text-jade shrink-0">following</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {hasTitleBlocks(it) && followedCover(it) && (
                          <div className="text-[11px] text-jade pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            Content and placement are drawn from the linked cover page, without
                            its seal. The complete title block is centred on the page; adjust it
                            vertically in the booklet preview.
                          </div>
                        )}
                        {hasTitleBlocks(it) && !followedCover(it) && (
                          <div className="flex flex-col gap-1 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            <div className="text-[11px] text-ink-soft flex items-center gap-2">
                              <span>Tibetan title — one line per line. Every edition prints it.</span>
                              {/* A DETACHED cover follows nothing, so neither chip is true of
                                  it: clearing the box leaves the page blank rather than handing
                                  it back to a text, and saying "reset to the text's" would
                                  promise a title that is not coming. */}
                              {furnitureBody(it.id, TIBETAN_LANG) ? (
                                coverDetached(it) ? (
                                  <button type="button"
                                          onClick={() => void saveFurniture(it.id, TIBETAN_LANG, '')}
                                          className="text-lapis hover:underline"
                                          title="Clear this cover's Tibetan title. It stands alone, so the page prints none.">
                                    clear
                                  </button>
                                ) : (
                                  <button type="button"
                                          onClick={() => void saveFurniture(it.id, TIBETAN_LANG, '')}
                                          className="text-lapis hover:underline"
                                          title="Discard this booklet's own Tibetan and follow the text again">
                                    reset to the text’s
                                  </button>
                                )
                              ) : (
                                <span className={coverDetached(it) ? 'text-ink-soft' : 'text-jade'}>
                                  {coverDetached(it) ? 'blank — this cover stands alone' : 'following the text'}
                                </span>
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
                        {hasTitleBlocks(it) && !followedCover(it) && current.languages.length > 0 && (
                          <div className="flex flex-col gap-2 pb-1.5 mb-0.5"
                               style={{ borderBottom: '1px solid var(--cline)' }}>
                            {/* A cover already follows the booklet's FIRST aligned text. This
                                is for the two cases that leaves out: a cover added after the
                                texts, and a booklet holding several — where the title that
                                belongs on the cover is a choice, not a position. */}
                            {canEditDocs && coverSources.length > 0 && (
                              <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                                <span className="text-ink-soft">
                                  fill {coverSources.length > 1 ? 'from' : 'from the aligned text'}
                                </span>
                                {coverSources.map(src => (
                                  <button
                                    key={src.id}
                                    type="button"
                                    onClick={() => void fillCoverFrom(it, src)}
                                    className="px-1.5 py-0.5 rounded text-lapis hover:bg-cream"
                                    style={{ border: '1px solid var(--cline)' }}
                                    title={`Copy this text's title into the cover's zones — every edition, and the Tibetan`}
                                  >
                                    {coverSources.length > 1
                                      ? (src.text_title ?? src.ref_title ?? `#${src.id}`)
                                      : 'fill'}
                                  </button>
                                ))}
                                {/* WHOSE TITLE IS ON THIS PAGE. Filling copies the words, so
                                    afterwards nothing on the page says where they came from —
                                    and on a cover that is also what decides whose inner cover
                                    follows it. Say it, and offer the way back. */}
                                {seededFrom(it) && (
                                  <span className="text-ink-soft">
                                    · filled from{' '}
                                    <span className="text-ink">
                                      {seededFrom(it)!.text_title ?? seededFrom(it)!.ref_title
                                        ?? `#${it.source_item_id}`}
                                    </span>
                                  </span>
                                )}
                                {(seededFrom(it) || hasOwnTitleText(it)) && (
                                  <button type="button"
                                          onClick={() => void releaseFromText(it)}
                                          className="px-1.5 py-0.5 rounded text-vermilion hover:bg-cream"
                                          style={{ border: '1px solid var(--cline)' }}
                                          title={'Delete the title text this page carries and '
                                            + 'follow the aligned text again. On a cover it also '
                                            + 'releases that text, whose own title page stops '
                                            + 'following this cover.'}>
                                    release
                                  </button>
                                )}
                              </div>
                            )}
                            {TITLE_BLOCKS.map(block => (
                              <div key={block} className="flex flex-col gap-1">
                                <div className="text-[11px] text-ink-soft">
                                  {TITLE_BLOCK_META[block].label} — per language
                                </div>
                                {current.languages.map(code => {
                                  const own = furnitureBody(it.id, code, block);
                                  // What this field FOLLOWS, which must be what the page
                                  // prints: an inner cover whose cover was seeded from this
                                  // text follows that cover's words before the text's own, so
                                  // the box would otherwise show one thing and the page
                                  // another (see `inheritedBodyOf`).
                                  const follows = followedCover(it);
                                  const seed = (follows ? furnitureBody(follows.id, code, block) : '')
                                            || slotSeed(it.id, code, block);
                                  return (
                                    <div key={code} className="flex items-start gap-2">
                                      <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                                      <RichLine
                                        // Re-seed when the override appears or goes: the box
                                        // is uncontrolled, so "reset" would otherwise leave
                                        // the old text sitting in it, contradicting the page.
                                        key={`${block}-${code}-${own ? 'own' : 'src'}-${seed}`}
                                        html={own || seed}
                                        placeholder={slotsFor !== it.id ? 'loading…'
                                                     : coverDetached(it) ? 'blank' : 'follows the text'}
                                        onCommit={h => void saveSlot(it.id, code, block, h)} />
                                      {own ? (
                                        <button type="button"
                                                onClick={() => void saveFurniture(it.id, code, '', block)}
                                                className="text-[10px] text-lapis hover:underline shrink-0"
                                                title={coverDetached(it)
                                                  ? 'Clear this slot. The cover stands alone, so the page prints nothing here.'
                                                  : 'Discard this booklet’s own text and follow the text again'}>
                                          {coverDetached(it) ? 'clear' : 'reset'}
                                        </button>
                                      ) : (
                                        // A detached cover follows nothing, so an empty slot
                                        // is a blank on the page, not an inherited word.
                                        <span className={`text-[10px] shrink-0 ${
                                          coverDetached(it) ? 'text-ink-soft' : 'text-jade'}`}>
                                          {coverDetached(it) ? 'blank' : 'following'}
                                        </span>
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
                        {!hasTitleBlocks(it) && !isTextRow(it) && (
                        <div className="text-[11px] text-ink-soft">
                          {it.kind === 'image_page'
                            ? 'Caption — per language (optional; select text for italic/bold, Enter for a new line)'
                            : 'Back-cover text — per language (optional; select text for italic/bold, Enter for a new line)'}
                        </div>
                        )}
                        {current.languages.length === 0 && (
                          <span className="text-[11px] text-vermilion">Set the document's languages first.</span>
                        )}
                        {/* The org's copyright template. The page was already seeded from it
                            when it was added; this is for an edition added since, a template
                            written since, or words cleared and wanted back. */}
                        {it.kind === 'backcover' && canEditDocs && current.languages.length > 0 && (
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <button type="button"
                                    onClick={() => void fillCopyrightFrom(it)}
                                    className="px-1.5 py-0.5 rounded text-lapis hover:bg-cream"
                                    style={{ border: '1px solid var(--cline)' }}
                                    title={'Copy this organization’s copyright template into '
                                      + 'every edition below. Set it in Admin → Copyright.'}>
                              fill from the org template
                            </button>
                            <span className="text-ink-soft">
                              · {'{{version}}'} and {'{{year}}'} resolve when the page prints
                            </span>
                          </div>
                        )}
                        {/* A plain <div>, NOT a <label>: a label around the contentEditable
                            RichLine re-targets the click on mouse-up and blurs it the instant you
                            click in (the title-slot rows are <div>s for the same reason). */}
                        {!hasTitleBlocks(it) && !isTextRow(it) && current.languages.map(code => (
                          <div key={code} className="flex items-start gap-2">
                            <span className="w-6 shrink-0 text-[11px] text-ink-soft pt-1.5">{code}</span>
                            <RichLine
                              key={`body-${it.id}-${code}-${fillEpoch}`}
                              html={bodyToRich(furnitureBody(it.id, code))}
                              placeholder={it.kind === 'backcover' ? 'e.g. Copyright © …' : 'Caption…'}
                              onCommit={h => void saveFurniture(it.id, code, h)} />
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

              {/* Add-item bar. Only a booklet composes: an aligned text never reaches this
                  page — it opens as its layout, and picks its text from its own panel. */}
              {canEditDocs && (
              <div className="mt-4 flex items-center gap-1.5 flex-wrap text-xs">
                <span className="text-ink-soft mr-1">add</span>
                {/* Reuse an ALIGNED TEXT: the alignment travels with it, so the same text can
                    stand in its own booklet and inside a larger one without being aligned twice.
                    Only offered on a booklet — an aligned text holds one text and nothing else. */}
                {isBooklet && (
                <div className="relative" ref={pickPageRef}>
                  <button
                    type="button"
                    onClick={() => setPickingPage(v => !v)}
                    className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream"
                    style={{ border: '1px solid var(--cline)' }}
                  >
                    <FileText size={13} /> Aligned text…
                  </button>
                  {pickingPage && (
                    <div className="absolute z-10 mt-1 w-72 max-h-72 overflow-auto rounded-md bg-white shadow-lg"
                         style={{ border: '1px solid var(--cline)' }}>
                      {alignedTexts.map(d => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => { void addItem('textpage', null, d.id); setPickingPage(false); }}
                          className="w-full text-left px-3 py-1.5 hover:bg-cream flex items-center gap-2"
                        >
                          <span className="tibetan-text-sm truncate flex-1">{d.title}</span>
                          <span className="text-[10px] text-ink-soft">{d.languages.join(' ')}</span>
                        </button>
                      ))}
                      {alignedTexts.length === 0 && (
                        <div className="px-3 py-2 text-ink-soft">
                          None yet — extract one from a booklet's text page.
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )}
                {isBooklet && FURNITURE.map(k => (
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
