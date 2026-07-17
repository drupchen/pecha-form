export const API_BASE = "http://localhost:8001/api";

export async function uploadText(file: File, title?: string) {
  const formData = new FormData();
  formData.append('file', file);
  if (title) formData.append('title', title);

  const res = await fetch(`${API_BASE}/texts`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listTexts() {
  const res = await fetch(`${API_BASE}/texts`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getText(id: number) {
  const res = await fetch(`${API_BASE}/texts/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Root display units with accepted root suggestions applied to the text but raw
// offsets preserved — used by the Alignment tab's main-text column.
export async function getCorrectedUnits(id: number): Promise<[number, number, string][]> {
  const res = await fetch(`${API_BASE}/texts/${id}/corrected-units`);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).units;
}

// The corrected root syllable layer for the workspace tagger (Phase 3 E1): one
// entry per syllable, corrected text applied. The editor renders this as the live
// selectable text and derives both syllable-UUID anchors and raw offsets from it.
export interface EditorToken {
  idx: number;
  id: string;              // stable syllable uuid (skeleton; inserted tokens are net-new)
  text: string;            // corrected text
  nature: string;          // TEXT / PUNCT / SPACE / ...
  inserted: boolean;       // net-new suggestion token (zero-width, no skeleton anchor)
  start_offset: number;    // skeleton char offset into raw_text (== end_offset when inserted)
  end_offset: number;
  original?: string;       // pre-correction text, when it differs
  // Secondary-text (composed) provenance — present only for a derived text's tokens.
  source?: 'parent-link' | 'transclusion' | 'override' | 'added';
  parent_syl_id?: string;  // override provenance: the parent syllable replaced
  src_text_id?: number;    // transclusion provenance: the source text
  /** The derivation op that emitted this token — disambiguates OCCURRENCES when the
   *  same source is transcluded several times (same uuids repeat in the stream). */
  op_id?: number;
}

export async function getEditorTokens(id: number): Promise<EditorToken[]> {
  const res = await fetch(`${API_BASE}/texts/${id}/editor-tokens`);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).tokens;
}

// --------------------------------------------------------------------------
// Translation layer (Phase T1): languages, chunks, canonical translations.
// A chunk = the unit of translation (empty-line-delimited stretch), anchored to
// origin-text syllables so translations ripple into every booklet reusing them.
// --------------------------------------------------------------------------

export interface Language { code: string; name: string }

export interface Translation {
  lang: string;
  body: string;
  status: 'draft' | 'final';
  translated_from: string | null;
  updated_at: string;
}

export interface TranslationChunk {
  id: number;
  origin_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  kind: 'text' | 'title';
  /** Title level for heading chunks (sapche/title), null = not a heading.
   *  Language-independent — feeds TOC + PDF heading styles. */
  level: number | null;
  /** The chunk's FULL Tibetan text from its origin — shown whole even when the
   *  booklet includes it only partially. */
  text: string;
  translations: Translation[];
}

export async function getLanguages(): Promise<Language[]> {
  const res = await fetch(`${API_BASE}/languages`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getTextTranslations(textId: number): Promise<TranslationChunk[]> {
  const res = await fetch(`${API_BASE}/texts/${textId}/translations`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function upsertTranslation(body: {
  context_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  lang: string;
  body: string;
  status?: 'draft' | 'final';
  translated_from?: string | null;
}): Promise<TranslationChunk> {
  const res = await fetch(`${API_BASE}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Phase T2: booklet overrides, watermarks, suggestions, scramble layouts ──

export interface TranslationOverride {
  chunk_id: number;
  lang: string;
  body: string;
  base_updated_at: string | null;
  updated_at: string;
}

export interface TranslationSuggestion {
  id: number;
  chunk_id: number;
  lang: string;
  body: string;
  from_text_id: number | null;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
}

export interface ChunkLayout {
  id: number;
  text_id: number | null;      // null = global default; else booklet-specific
  kind: 'move' | 'title';
  src_start_syl_id: string | null;
  src_end_syl_id: string | null;
  /** 'segment'/'title': lands BEFORE the chunk starting here. 'inline': lands beside
   *  this very syllable, INSIDE its chunk (after it when `anchor_after`). null = end. */
  anchor_syl_id: string | null;
  /** The translator's two move gestures: 'inline' = the hairline (the fragment is
   *  integrated into the destination chunk's text and translated there), 'segment' =
   *  the bar between chunks (the fragment stands as its own segment, with its own
   *  translation). Legacy rows read back as 'inline'. */
  move_mode: 'inline' | 'segment';
  anchor_after: boolean;
  level: number | null;
  disabled: boolean;
  position: number;
  titles: Record<string, string>;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
const J = { 'Content-Type': 'application/json' };

export const getOverrides = (textId: number) =>
  jfetch<TranslationOverride[]>(`${API_BASE}/texts/${textId}/translation-overrides`);
export const putOverride = (textId: number, body: { chunk_id: number; lang: string; body: string }) =>
  jfetch<TranslationOverride>(`${API_BASE}/texts/${textId}/translation-overrides`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });
export const ackOverride = (textId: number, body: { chunk_id: number; lang: string }) =>
  jfetch<TranslationOverride>(`${API_BASE}/texts/${textId}/translation-overrides/ack`,
    { method: 'POST', headers: J, body: JSON.stringify(body) });
export const deleteOverride = (textId: number, chunkId: number, lang: string) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/texts/${textId}/translation-overrides/${chunkId}/${lang}`,
    { method: 'DELETE' });

export const getSeen = (textId: number) =>
  jfetch<{ chunk_id: number; lang: string; seen_updated_at: string }[]>(
    `${API_BASE}/texts/${textId}/translation-seen`);
export const markSeen = (textId: number, body: { chunk_id: number; lang: string; seen_updated_at: string }) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/texts/${textId}/translation-seen`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });

export const getSuggestions = (textId: number) =>
  jfetch<TranslationSuggestion[]>(`${API_BASE}/texts/${textId}/translation-suggestions`);
export const createSuggestion = (body: { chunk_id: number; lang: string; body: string; from_text_id?: number | null }) =>
  jfetch<TranslationSuggestion>(`${API_BASE}/translation-suggestions`,
    { method: 'POST', headers: J, body: JSON.stringify(body) });
export const resolveSuggestion = (id: number, accept: boolean) =>
  jfetch<TranslationSuggestion>(`${API_BASE}/translation-suggestions/${id}/resolve`,
    { method: 'POST', headers: J, body: JSON.stringify({ accept }) });

export const getLayouts = (textId: number) =>
  jfetch<ChunkLayout[]>(`${API_BASE}/texts/${textId}/chunk-layouts`);
export const createLayout = (body: {
  text_id?: number | null; kind: 'move' | 'title';
  src_start_syl_id?: string | null; src_end_syl_id?: string | null;
  anchor_syl_id?: string | null; move_mode?: 'inline' | 'segment';
  anchor_after?: boolean; level?: number | null;
}) =>
  jfetch<ChunkLayout>(`${API_BASE}/chunk-layouts`,
    { method: 'POST', headers: J, body: JSON.stringify(body) });
export const patchLayout = (id: number, body: {
  anchor_syl_id?: string; level?: number; disabled?: boolean; clear_anchor?: boolean;
}) =>
  jfetch<ChunkLayout>(`${API_BASE}/chunk-layouts/${id}`,
    { method: 'PATCH', headers: J, body: JSON.stringify(body) });
export const deleteLayout = (id: number) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/chunk-layouts/${id}`, { method: 'DELETE' });
export const putLayoutTitle = (id: number, body: { lang: string; body: string }) =>
  jfetch<ChunkLayout>(`${API_BASE}/chunk-layouts/${id}/title`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });

export async function setChunkLevel(body: {
  context_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  level: number | null;
}): Promise<TranslationChunk> {
  const res = await fetch(`${API_BASE}/translation-chunks/level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Phonetics layer (Phase P): line-level romanization, rippling like translations.
// A row = one recitation line, anchored to origin-text syllables so it auto-
// populates every document that includes the same primary/secondary. `kind`:
// 'bo' = Tibetan phonetics, 'skt' = Sanskrit mantra romanization.
// --------------------------------------------------------------------------

export interface Phonetic {
  id: number;
  origin_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  kind: 'bo' | 'skt';
  /** The booklet language this phonetics body is written for (en/fr/de/pt). */
  lang: string;
  body: string;
  status: 'auto' | 'edited' | 'reviewed';
  /** The line's FULL Tibetan text from its origin (shown whole even if included
   *  only partially by this document). */
  text: string;
  updated_at: string;
}

export const getPhonetics = (textId: number, lang: string) =>
  jfetch<Phonetic[]>(`${API_BASE}/texts/${textId}/phonetics?lang=${encodeURIComponent(lang)}`);

export const putPhonetic = (body: {
  context_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  kind: 'bo' | 'skt';
  lang: string;
  body: string;
  status: 'auto' | 'edited' | 'reviewed';
}) =>
  jfetch<Phonetic>(`${API_BASE}/phonetics`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });

export const deletePhonetic = (body: {
  context_text_id: number;
  start_syl_id: string;
  end_syl_id: string;
  kind: 'bo' | 'skt';
  lang: string;
}) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/phonetics`,
    { method: 'DELETE', headers: J, body: JSON.stringify(body) });

// --------------------------------------------------------------------------
// Documents (Phase D1): booklets assembled from ordered pages, in a set of
// languages. Structure only — pagination (D2) and PDF (D3) come later.
// --------------------------------------------------------------------------

export type DocumentItemKind =
  'cover' | 'blank' | 'toc' | 'copyright' | 'text' | 'image_page' | 'backcover';

export interface DocumentItem {
  id: number;
  document_id: number;
  position: number;
  kind: DocumentItemKind;
  text_id: number | null;
  text_title: string | null;
  caption: string | null;
  body: string | null;
  /** image-carrying furniture (cover/copyright/image_page/backcover): whether an image
   *  has been uploaded, and its display size in mm (null = natural). */
  has_image?: boolean;
  image_width_mm?: number | null;
  image_height_mm?: number | null;
}

/** The served-image URL for an image_page item (append a cache-buster when it changes). */
export const itemImageUrl = (itemId: number) => `${API_BASE}/document-items/${itemId}/image`;

/** Upload/replace the image for an image_page item. */
export async function uploadItemImage(itemId: number, file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/document-items/${itemId}/image`, { method: 'PUT', body: fd });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteItemImage(itemId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/document-items/${itemId}/image`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

/** Set an image's display size in mm (null clears a dimension → natural). */
export async function setItemImageSize(
  itemId: number, widthMm: number | null, heightMm: number | null,
): Promise<void> {
  const res = await fetch(`${API_BASE}/document-items/${itemId}/image/size`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width_mm: widthMm, height_mm: heightMm }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ── Style designer (Phase 4) ──
export interface OrgFont { id: number; family: string; weight: number; italic: boolean; mime: string }
type StyleMap = Record<string, Record<string, unknown>>;

export const getOrgStyles = (orgId = 1): Promise<StyleMap> =>
  fetch(`${API_BASE}/styles?org_id=${orgId}`).then(r => r.json());
export const putOrgStyle = (role: string, props: Record<string, unknown>, orgId = 1) =>
  fetch(`${API_BASE}/styles/${role}?org_id=${orgId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ props }),
  }).then(r => { if (!r.ok) throw new Error(r.statusText); });
export const deleteOrgStyle = (role: string, orgId = 1) =>
  fetch(`${API_BASE}/styles/${role}?org_id=${orgId}`, { method: 'DELETE' });

/** The org's page format and guides: sheet size + the four margins the text block and the
 *  binding/folio guides are drawn from. Always complete — never a blank meaning "inherit".
 *  A booklet that states no geometry of its own follows this. */
export type OrgLayout = {
  page_width_mm: number; page_height_mm: number;
  margin_top_mm: number; margin_bottom_mm: number;
  margin_bind_mm: number; margin_outer_mm: number;
};
export const getOrgLayout = (orgId = 1): Promise<OrgLayout> =>
  fetch(`${API_BASE}/org-layout?org_id=${orgId}`).then(r => r.json());
export const putOrgLayout = (config: Partial<OrgLayout>, orgId = 1): Promise<OrgLayout> =>
  fetch(`${API_BASE}/org-layout?org_id=${orgId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
  }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });

export const getDocStyles = (docId: number): Promise<StyleMap> =>
  fetch(`${API_BASE}/documents/${docId}/styles`).then(r => r.json());
export const putDocStyle = (docId: number, role: string, props: Record<string, unknown>) =>
  fetch(`${API_BASE}/documents/${docId}/styles/${role}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ props }),
  }).then(r => { if (!r.ok) throw new Error(r.statusText); });
export const deleteDocStyle = (docId: number, role: string) =>
  fetch(`${API_BASE}/documents/${docId}/styles/${role}`, { method: 'DELETE' });

export const getOrgFonts = (orgId = 1): Promise<OrgFont[]> =>
  fetch(`${API_BASE}/org-fonts?org_id=${orgId}`).then(r => r.json());
export const orgFontFileUrl = (fontId: number) => `${API_BASE}/org-fonts/${fontId}/file`;
export async function uploadOrgFont(
  file: File, family: string, weight = 400, italic = false, orgId = 1,
): Promise<OrgFont> {
  const fd = new FormData();
  fd.append('file', file); fd.append('family', family);
  fd.append('weight', String(weight)); fd.append('italic', String(italic));
  fd.append('org_id', String(orgId));
  const res = await fetch(`${API_BASE}/org-fonts`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
export const deleteOrgFont = (fontId: number) =>
  fetch(`${API_BASE}/org-fonts/${fontId}`, { method: 'DELETE' });

/** The org's cover SEAL — a template-level image printed where the ༀ ornament sits, on every
 *  booklet's cover. A booklet's own cover image (uploadItemImage) overrides it. */
export interface OrgSeal { has_image: boolean; width_mm: number | null; height_mm: number | null }

export const getOrgSeal = (orgId = 1): Promise<OrgSeal> =>
  fetch(`${API_BASE}/org-seal?org_id=${orgId}`).then(r => r.json());
export const orgSealUrl = (orgId = 1) => `${API_BASE}/org-seal/file?org_id=${orgId}`;
export async function uploadOrgSeal(file: File, orgId = 1): Promise<OrgSeal> {
  const fd = new FormData();
  fd.append('file', file); fd.append('org_id', String(orgId));
  const res = await fetch(`${API_BASE}/org-seal`, { method: 'PUT', body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
/** Display size in mm; null on a dimension = the image's natural size. */
export async function setOrgSealSize(
  widthMm: number | null, heightMm: number | null, orgId = 1,
): Promise<OrgSeal> {
  const res = await fetch(`${API_BASE}/org-seal?org_id=${orgId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width_mm: widthMm, height_mm: heightMm }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
export const deleteOrgSeal = (orgId = 1) =>
  fetch(`${API_BASE}/org-seal?org_id=${orgId}`, { method: 'DELETE' });

// docx style templates
export const styleTemplateUrl = (target: 'org' | 'document', documentId?: number, orgId = 1) =>
  `${API_BASE}/style-template.docx?target=${target}&org_id=${orgId}` +
  (documentId != null ? `&document_id=${documentId}` : '');
export async function importStyleTemplate(
  file: File, target: 'org' | 'document', documentId?: number, orgId = 1,
): Promise<{ applied: string[]; count: number }> {
  const fd = new FormData();
  fd.append('file', file); fd.append('target', target); fd.append('org_id', String(orgId));
  if (documentId != null) fd.append('document_id', String(documentId));
  const res = await fetch(`${API_BASE}/style-template/import`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Style Studio specimen (per-org editable sample)
export const getStyleSample = (orgId = 1): Promise<{ content: string }> =>
  fetch(`${API_BASE}/style-sample?org_id=${orgId}`).then(r => r.json());
export const putStyleSample = (content: string, orgId = 1) =>
  fetch(`${API_BASE}/style-sample?org_id=${orgId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
  }).then(r => { if (!r.ok) throw new Error(r.statusText); });

export interface DocumentSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  languages: string[];
}

export interface DocumentDetail extends DocumentSummary {
  items: DocumentItem[];
}

export interface TocSection { title: string | null; level: number | null; children: TocSection[] }
export interface TocEntry { item_id: number; text_id: number; text_title: string; sections: TocSection[] }

export const getDocuments = () => jfetch<DocumentSummary[]>(`${API_BASE}/documents`);
export const createDocument = (title: string) =>
  jfetch<DocumentSummary>(`${API_BASE}/documents`,
    { method: 'POST', headers: J, body: JSON.stringify({ title }) });
export const getDocument = (id: number) => jfetch<DocumentDetail>(`${API_BASE}/documents/${id}`);
export const renameDocument = (id: number, title: string) =>
  jfetch<DocumentSummary>(`${API_BASE}/documents/${id}`,
    { method: 'PATCH', headers: J, body: JSON.stringify({ title }) });
export const deleteDocument = (id: number) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/documents/${id}`, { method: 'DELETE' });

export const addDocumentItem = (id: number, body: {
  kind: DocumentItemKind; text_id?: number | null; caption?: string | null; body?: string | null;
}) =>
  jfetch<DocumentItem>(`${API_BASE}/documents/${id}/items`,
    { method: 'POST', headers: J, body: JSON.stringify(body) });
export const patchDocumentItem = (itemId: number, body: {
  text_id?: number | null; caption?: string | null; body?: string | null;
}) =>
  jfetch<DocumentItem>(`${API_BASE}/document-items/${itemId}`,
    { method: 'PATCH', headers: J, body: JSON.stringify(body) });
export const deleteDocumentItem = (itemId: number) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/document-items/${itemId}`, { method: 'DELETE' });
export const reorderDocumentItems = (id: number, orderedIds: number[]) =>
  jfetch<DocumentItem[]>(`${API_BASE}/documents/${id}/items/reorder`,
    { method: 'POST', headers: J, body: JSON.stringify({ ordered_ids: orderedIds }) });

export const setDocumentLanguages = (id: number, langs: string[]) =>
  jfetch<string[]>(`${API_BASE}/documents/${id}/languages`,
    { method: 'PUT', headers: J, body: JSON.stringify({ langs }) });
export const getDocumentToc = (id: number) => jfetch<TocEntry[]>(`${API_BASE}/documents/${id}/toc`);

// ── D2 pagination layout: shared page breaks + per-line balancing, on the document ──

/** `width_*` = a signed per-line-block width delta in mm (see `WidthTarget` in
 *  bookletRender): positive overflows the block toward its page's right physical border,
 *  negative narrows it so the text wraps. One kind per rendered block — the layout row's
 *  unique key is (document, item, anchor_syl_id, kind, lang), so the target lives in the
 *  kind. (Their positive-only predecessor `wrap_extend` is retired — nothing read it.) */
export type DocumentLayoutKind =
  | 'page_break' | 'line_space' | 'line_nospace' | 'hairline' | 'recto_cut'
  | 'width_tibetan' | 'width_phonetics' | 'width_translation' | 'width_section'
  | 'gap_fill_verso' | 'gap_fill_recto' | 'width_furniture'
  /** `page_shift_*`: SIGNED mm the whole page's content is moved down (+) or up (-) — what is
   *  left once opening the empty lines has reached the limit of decent spacing. It may
   *  legitimately place ink between the text block's foot and the sheet's edge. */
  | 'page_shift_verso' | 'page_shift_recto'
  /** The user's vetoes on the auto-flow: it must not SPLIT this line / not re-place a
   *  lifted automatic BREAK here. Written by the explicit removal paths, deleted by
   *  placing a split/break there again. Flow constraints only — never rendered. */
  | 'no_split' | 'no_break';

export interface DocumentLayoutRow {
  id: number;
  document_id: number;
  item_id: number;
  anchor_syl_id: string;
  kind: DocumentLayoutKind;
  char_offset: number | null;
  value: number | null;
  lang: string | null;   // '' / null = shared across all editions
}

/** Page geometry + type sizes (mm / pt). Built-in defaults, per-document overrides. */
export interface LayoutConfig {
  page_width_mm: number; page_height_mm: number;
  margin_top_mm: number; margin_bottom_mm: number;
  margin_bind_mm: number; margin_outer_mm: number;
  tibetan_pt: number; phonetics_pt: number; translation_pt: number;
  leading: number;
  /** Seconds of quiet before the automatic breaks re-flow themselves — the clock restarts on
   *  every upstream change. Not geometry, but per-document user config, which is what this
   *  already is. */
  reflow_delay_s: number;
}

export interface DocumentLayout {
  config: LayoutConfig;
  rows: DocumentLayoutRow[];
  /** What the stored breaks were flowed against — a per-line `hash:syllables` signature of
   *  the stream, and a hash of the styles + geometry. The bench diffs them to count how many
   *  syllables have changed since, and re-flows once that passes the threshold. Null = never
   *  recorded, so nothing is assumed. */
  pagination_sig: string | null;
  pagination_fp: string | null;
}

export const getDocumentLayout = (id: number) =>
  jfetch<DocumentLayout>(`${API_BASE}/documents/${id}/layout`);
/** Record what a just-written set of breaks fits. Only the bench, only after a flow. */
export const putPaginationStamp = (id: number, pagination_sig: string, pagination_fp: string) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/documents/${id}/pagination-stamp`,
    { method: 'PUT', headers: J, body: JSON.stringify({ pagination_sig, pagination_fp }) });
export const putLayoutConfig = (id: number, config: Partial<LayoutConfig>) =>
  jfetch<DocumentLayout>(`${API_BASE}/documents/${id}/layout-config`,
    { method: 'PUT', headers: J, body: JSON.stringify({ config }) });
export const putLayoutRow = (id: number, body: {
  item_id: number; anchor_syl_id: string; kind: DocumentLayoutKind;
  char_offset?: number | null; value?: number | null; lang?: string | null;
}) =>
  jfetch<DocumentLayoutRow>(`${API_BASE}/documents/${id}/layout`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });
export const deleteLayoutRow = (id: number, body: {
  item_id: number; anchor_syl_id: string; kind: DocumentLayoutKind; lang?: string | null;
}) =>
  jfetch<{ ok: boolean }>(`${API_BASE}/documents/${id}/layout`,
    { method: 'DELETE', headers: J, body: JSON.stringify(body) });

// Per-language furniture content (copyright text, cover/title overrides, captions).
export interface DocumentFurnitureRow { item_id: number; lang: string; body: string }
export const getFurniture = (id: number) =>
  jfetch<DocumentFurnitureRow[]>(`${API_BASE}/documents/${id}/furniture`);
export const putFurniture = (id: number, body: { item_id: number; lang: string; body: string }) =>
  jfetch<DocumentFurnitureRow>(`${API_BASE}/documents/${id}/furniture`,
    { method: 'PUT', headers: J, body: JSON.stringify(body) });

export async function deleteText(id: number) {
  const res = await fetch(`${API_BASE}/texts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Edit a text's list metadata: title (inline rename) and/or group (collection label;
// empty string clears the group to ungrouped). Only provided fields change.
export async function updateTextMeta(
  id: number, patch: { title?: string; text_group?: string | null }
) {
  const res = await fetch(`${API_BASE}/texts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Group registry (Part 12): persistent group paths so empty groups survive. ---

export async function listTextGroups(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/text-groups`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Register a (possibly empty) group path. Returns the full updated path list.
export async function createTextGroup(path: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/text-groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Reorganize a group: nest `src` under `dest` ("" = top level). Rewrites all texts + paths.
export async function moveTextGroup(src: string, dest: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/text-groups/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src_path: src, dest_path: dest }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Reorder a group (Part 13): place `src` under `parent` ("" = root), immediately before the
// sibling `beforePath` ("" = append). Reorders root columns and promotes a sub-group to root.
export async function reorderTextGroup(src: string, parent: string, beforePath: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/text-groups/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src_path: src, parent_path: parent, before_path: beforePath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Delete an empty group (refused with 409 if any text still lives at/under it).
export async function deleteTextGroup(path: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/text-groups`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Create a secondary text derived from primary text `id`. The secondary has no
// syllables of its own; its content is composed from the parent + derivation ops.
export async function deriveText(id: number, title?: string) {
  const res = await fetch(`${API_BASE}/texts/${id}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Extract a syllable range of a primary text into a new independent primary text, and
// reversibly remove that range from the source. Syllable-native: uuids on the wire.
export async function extractText(
  id: number, body: { start_syl_id: string; end_syl_id: string; title?: string }
) {
  const res = await fetch(`${API_BASE}/texts/${id}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Per-user last-viewed position in a text: the syllable that begins the last-viewed
// segment, so reopening a text scrolls back there. User-scoped on the backend.
export interface ReadingPosition {
  text_id: number;
  syl_id: string | null;
  updated_at: string;
}

export async function getReadingPosition(id: number): Promise<ReadingPosition | null> {
  const res = await fetch(`${API_BASE}/texts/${id}/reading-position`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function putReadingPosition(id: number, sylId: string | null): Promise<ReadingPosition> {
  const res = await fetch(`${API_BASE}/texts/${id}/reading-position`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syl_id: sylId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Route a correction proposed on a derived text to the text where the selected
// syllables first appear (their owner), as a PENDING suggestion reviewed there.
export async function suggestUpstream(
  textId: number,
  body: { start_syl_id: string; end_syl_id: string | null; suggested_text: string },
): Promise<{ suggestion_id: number; routed_to_text_id: number; routed_to_title: string }> {
  const res = await fetch(`${API_BASE}/texts/${textId}/suggest-upstream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Accept an incoming pending suggestion. mode 'stage' = it joins the owner's staged
// corrections; 'ripple' = bake just this one into the base now (derived texts update
// immediately). On a secondary owner it is applied as an edit op either way.
export async function acceptSuggestion(id: number, mode: 'stage' | 'ripple') {
  const res = await fetch(`${API_BASE}/suggestions/${id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Bake all staged suggestions into the primary's base layer (stable syllable uuids
// survive), so the corrections ripple to every text derived from it, any depth.
export async function applyCorrections(id: number) {
  const res = await fetch(`${API_BASE}/texts/${id}/apply-corrections`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Duplicate a primary text with its edits/deletions baked in (raw_text = corrected text).
// The duplicate records `cloned_from_text_id` for the picker's original/duplicate badges.
export async function cloneText(id: number, title?: string) {
  const res = await fetch(`${API_BASE}/texts/${id}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Passages (primary-text inline syllable-link transclusion)
// --------------------------------------------------------------------------

export interface PassageSyllable { syl_id: string; idx: number; text: string; nature: string; }
export interface PassageMemberInput { src_start_syl_id: string; src_end_syl_id: string; }
export interface PassageMember extends PassageMemberInput {
  position: number;
  syllables: PassageSyllable[];
}
export interface Passage {
  id: number;
  text_id: number;
  anchor_syl_id: string | null;
  position: number;
  color: string | null;
  /** Attachment side at a segment boundary: true = render at the END of the previous
   *  segment ("stays on the same segment"); false = head the anchor's segment. */
  attach_prev: boolean;
  /** The marker-free "manual split": render as a standalone card (its own segment). */
  own_segment: boolean;
  /** True when INHERITED from a source text — read-only here (edit on the owner). */
  inherited?: boolean;
  /** Passage-local translation overrides ({lang: {unitKey: body}}); empty = retrieved source. */
  translations?: Record<string, Record<string, string>>;
  members: PassageMember[];
}

export async function getPassages(textId: number): Promise<Passage[]> {
  const res = await fetch(`${API_BASE}/texts/${textId}/passages`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createPassage(
  textId: number,
  body: { anchor_syl_id: string | null; members: PassageMemberInput[]; color?: string | null; position?: number; attach_prev?: boolean },
): Promise<Passage> {
  const res = await fetch(`${API_BASE}/texts/${textId}/passages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updatePassage(
  passageId: number,
  patch: Partial<{ anchor_syl_id: string | null; position: number; color: string | null; own_segment: boolean; attach_prev: boolean; members: PassageMemberInput[]; translations: Record<string, Record<string, string>> }>,
): Promise<Passage> {
  const res = await fetch(`${API_BASE}/passages/${passageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deletePassage(passageId: number) {
  const res = await fetch(`${API_BASE}/passages/${passageId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Divide a passage in two after a syllable strictly inside its run — "split inside a
 *  passage". Returns both halves; per-occurrence notes in the second half move with it. */
export async function splitPassage(
  passageId: number,
  body: {
    after_syl_id: string;
    second_own_segment?: boolean;
    first_attach_prev?: boolean;
    second_attach_prev?: boolean;
  },
): Promise<{ first: Passage; second: Passage }> {
  const res = await fetch(`${API_BASE}/passages/${passageId}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Secondary-text derivation (links + overrides, syllable-native)
// --------------------------------------------------------------------------

export interface ComposedResult {
  tokens: EditorToken[];   // composed tokens, each carrying a `source`
  raw_text: string;        // concatenation of composed token texts (frontend aid)
}

// The composed syllable sequence for a secondary text (parent links + overrides +
// added/transcluded), each token tagged with its `source` provenance.
export async function getComposed(textId: number): Promise<ComposedResult> {
  const res = await fetch(`${API_BASE}/texts/${textId}/composed`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Edit a run of a secondary text as free text; the backend tokenizes + aligns the
// new text against the parent run (by syllable uuid) and persists derivation ops.
export async function editRange(
  textId: number,
  body: { start_syl_id: string; end_syl_id: string; new_text: string },
): Promise<ComposedResult> {
  const res = await fetch(`${API_BASE}/texts/${textId}/edit-range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Splice a range from another text into a secondary text (links, not copies).
// Omit the src range to transclude the source's WHOLE text.
export async function transclude(
  textId: number,
  body: { anchor_syl_id: string | null; src_text_id: number; src_start_syl_id?: string; src_end_syl_id?: string; anchor_op_id?: number },
): Promise<ComposedResult> {
  const res = await fetch(`${API_BASE}/texts/${textId}/transclude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteDerivationOp(opId: number) {
  const res = await fetch(`${API_BASE}/derivation-ops/${opId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// A secondary's edit ops (the sidebar's analogue of a primary's suggestions list —
// delete an op to undo it). Each carries a human-readable `summary` + jump anchor.
export interface DerivationOp {
  id: number;
  text_id: number;
  op_kind: 'override' | 'insert' | 'delete' | 'transclude';
  anchor_syl_id: string | null;
  summary: string;
}

export async function listDerivationOps(textId: number): Promise<DerivationOp[]> {
  const res = await fetch(`${API_BASE}/texts/${textId}/derivation-ops`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Sessions / SRT transcripts / alignment (publishing layer)
// --------------------------------------------------------------------------

export interface SessionInfo {
  id: number;
  name: string;
  open_position: number | null;
  close_position: number | null;
  audio_original_url: string | null;
  audio_restored_url: string | null;
  srt_filename: string | null;
  segment_count: number;
  portion_count: number;
  coverage_gap: boolean;
}

export interface SrtSegment {
  id: number;
  seg_id: number;
  start_tc: string;
  end_tc: string;
  text: string;
}

export interface Portion {
  id: number;
  text_id: number;
  session_tag_id: number;
  start_offset: number;
  end_offset: number;
  position: number;
  color: string | null;
  segment_ids: number[];
}

export async function listSessions(textId: number): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/texts/${textId}/sessions`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateSessionMetadata(
  tagId: number,
  meta: { audio_original_url?: string; audio_restored_url?: string; srt_filename?: string },
) {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importSrt(tagId: number, file: File, force = false) {
  const formData = new FormData();
  formData.append('file', file);
  const url = `${API_BASE}/sessions/${tagId}/srt${force ? '?force=true' : ''}`;
  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) {
    // 409 carries a structured detail { message, forceable }; fall back to raw text.
    const body = await res.text();
    let message = body, forceable: boolean | undefined;
    try {
      const d = JSON.parse(body).detail;
      if (d && typeof d === 'object') { message = d.message ?? body; forceable = d.forceable; }
    } catch { /* not JSON */ }
    const err = new Error(message) as Error & { status?: number; forceable?: boolean };
    err.status = res.status;
    err.forceable = forceable;
    throw err;
  }
  return res.json();
}

export async function alignMainText(tagId: number, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/sessions/${tagId}/align-main-text`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ session_tag_id: number; cues: number; matched: number; linked_segments: number; unmatched_seg_ids: number[] }>;
}

export async function setMainTextSrtDir(textId: number, dir: string) {
  const res = await fetch(`${API_BASE}/texts/${textId}/main-text-srt-dir`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ main_text_srt_dir: dir }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ id: number; main_text_srt_dir: string | null }>;
}

export async function alignMainTextFromFolder(tagId: number) {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/align-main-text-from-folder`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ session_tag_id: number; cues: number; matched: number; linked_segments: number; unmatched_seg_ids: number[]; srt_path: string }>;
}

// Recompute the recited-root-text ("main-text", shown as red syllables) spans
// inside this session's transcript from its current portions + corrected text.
export async function tagMainText(tagId: number) {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/tag-main-text`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ session_tag_id: number; portions: number; spans: number }>;
}

export async function alignAllMainTextFromFolder(textId: number) {
  const res = await fetch(`${API_BASE}/texts/${textId}/align-main-text-from-folder`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    text_id: number;
    aligned: { session: string; matched: number; cues: number; unmatched_seg_ids: number[] }[];
    skipped: { session: string; reason: string }[];
  }>;
}

export async function listSrtSegments(tagId: number): Promise<SrtSegment[]> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/srt-segments`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listPortions(tagId: number): Promise<Portion[]> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/portions`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createPortion(
  tagId: number,
  body: { start_offset: number; end_offset: number; segment_ids: number[]; color?: string },
): Promise<Portion> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/portions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updatePortion(
  portionId: number,
  body: Partial<{ start_offset: number; end_offset: number; segment_ids: number[]; position: number; color: string }>,
): Promise<Portion> {
  const res = await fetch(`${API_BASE}/portions/${portionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deletePortion(portionId: number) {
  const res = await fetch(`${API_BASE}/portions/${portionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function reassignSegmentPortion(segmentId: number, portionId: number) {
  const res = await fetch(`${API_BASE}/srt-segments/${segmentId}/portion`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portion_id: portionId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Transcription annotation layer: per-syllable tags + suggestions on SRT segments
// --------------------------------------------------------------------------

export interface TranscriptSyllable {
  idx: number;
  id: string;
  start_offset: number;
  end_offset: number;
  text: string;
  nature: string;
  inserted?: boolean;   // corrected view: net-new syllable (zero-width raw, no tag anchor)
}

export interface TranscriptSpan {
  id: number;
  text_id: number;
  srt_segment_id: number;
  tag_id: number;
  start_offset: number;
  end_offset: number;
  tag: { id: number; text_id: number; name: string; color: string; tag_kind: string };
}

export interface TranscriptSuggestion {
  id: number;
  text_id: number;
  srt_segment_id: number;
  start_offset: number;
  end_offset: number;
  suggested_text: string;
  created_at: string;
}

export async function listTranscriptSyllables(tagId: number, corrected = false): Promise<Record<number, TranscriptSyllable[]>> {
  // corrected=true: text reflects accepted suggestions (offsets stay raw) — Alignment tab.
  const qs = corrected ? '?corrected=true' : '';
  const res = await fetch(`${API_BASE}/sessions/${tagId}/transcript-syllables${qs}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listTranscriptSpans(tagId: number): Promise<TranscriptSpan[]> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/transcript-spans`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createTranscriptSpan(
  segmentId: number, tagId: number, start: number, end: number,
): Promise<TranscriptSpan> {
  const res = await fetch(`${API_BASE}/srt-segments/${segmentId}/transcript-spans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId, start_offset: start, end_offset: end }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteTranscriptSpan(spanId: number) {
  const res = await fetch(`${API_BASE}/transcript-spans/${spanId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listTranscriptSuggestions(tagId: number): Promise<TranscriptSuggestion[]> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/transcript-suggestions`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createTranscriptSuggestion(
  segmentId: number, start: number, end: number, suggested_text: string,
): Promise<TranscriptSuggestion> {
  const res = await fetch(`${API_BASE}/srt-segments/${segmentId}/transcript-suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_offset: start, end_offset: end, suggested_text }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteTranscriptSuggestion(suggestionId: number) {
  const res = await fetch(`${API_BASE}/transcript-suggestions/${suggestionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface TranscriptNote {
  id: number;
  text_id: number;
  srt_segment_id: number;
  category_id: number | null;
  category_name: string | null;
  start_offset: number;
  end_offset: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export async function listTranscriptNotes(tagId: number): Promise<TranscriptNote[]> {
  const res = await fetch(`${API_BASE}/sessions/${tagId}/transcript-notes`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createTranscriptNote(
  segmentId: number, start: number, end: number, body: string, category_id: number | null,
): Promise<TranscriptNote> {
  const res = await fetch(`${API_BASE}/srt-segments/${segmentId}/transcript-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_offset: start, end_offset: end, body, category_id }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateTranscriptNote(
  noteId: number, patch: { body?: string; category_id?: number | null },
): Promise<TranscriptNote> {
  const res = await fetch(`${API_BASE}/transcript-notes/${noteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteTranscriptNote(noteId: number) {
  const res = await fetch(`${API_BASE}/transcript-notes/${noteId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Cross-transcription syllable search
// --------------------------------------------------------------------------

export interface SearchSyllable {
  text: string;
  nature: string;
  start: number;          // offset into corrected_text
  end: number;
  raw_start: number | null;  // offset into the raw segment text (null = from a correction)
  raw_end: number | null;
}

export interface SearchResult {
  text_id: number;
  text_title: string;
  instance_id: string | null;
  session_tag_id: number;
  session_name: string;
  srt_segment_id: number;
  seg_id: number;
  corrected_text: string;
  syllables: SearchSyllable[];
  matches: { start: number; end: number }[];
  suggestions: TranscriptSuggestion[];
}

export async function searchTranscripts(q: string): Promise<SearchResult[]> {
  const res = await fetch(`${API_BASE}/transcript-search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function buildManifest(textId: number, instanceId?: string) {
  const formData = new FormData();
  if (instanceId) formData.append('instance_id', instanceId);
  const res = await fetch(`${API_BASE}/texts/${textId}/build-manifest`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --------------------------------------------------------------------------
// Catalog + pipeline status
// --------------------------------------------------------------------------

export interface PipelineStages {
  imported: boolean;
  manifest: boolean;
  outline: boolean;
  tagged: boolean;
  sessions_total: number;
  srt_imported: number;
  aligned_portions: number;
  published: { manifest: boolean; sapche: boolean; compiled_sessions: boolean };
}

export interface PipelineRow {
  teaching_id: string;
  title_bo: string;
  title_en: string;
  access_level: number | null;
  instance_id: string;
  instance_type: string;
  text_docx: string;
  catalog_sessions: number;
  text_id: number | null;
  counts: Record<string, number>;
  stages: PipelineStages;
}

export async function getCatalog() {
  const res = await fetch(`${API_BASE}/catalog`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function regenerateCatalog() {
  const res = await fetch(`${API_BASE}/catalog/regenerate`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getPipeline(): Promise<{ source: string; rows: PipelineRow[] }> {
  const res = await fetch(`${API_BASE}/pipeline`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function syncSessions(instanceId: string) {
  const res = await fetch(`${API_BASE}/pipeline/${instanceId}/sync-sessions`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

