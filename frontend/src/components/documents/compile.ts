import {
  API_BASE, getEditorTokens, getTextTranslations, getPhonetics,
  type DocumentItem,
} from '../../api/client';
import { deriveChunks } from '../translate/chunks';

/**
 * Document content assembly (Phase D2). For each text page, reuse the translate
 * bench's `deriveChunks` twice — once at LINE granularity (the recitation lines that
 * carry Tibetan + phonetics and drive page breaking) and once at CHUNK granularity
 * (the empty-line-delimited translation units) — then attach the selected language's
 * phonetics (per line) and translation (per chunk). Concatenated across the document's
 * text pages this yields the SHARED line stream: every line carries its syllable ids,
 * so page breaks / balancing anchor to it and lay out identically in every edition.
 */
export interface DocLine {
  itemId: number;
  textId: number;
  key: string;                 // unique across the whole document
  role: string;                // verse | prose | mantra | title | small | plain
  startSylId: string;
  endSylId: string;
  tokens: { id: string; render: string }[];   // Tibetan render (with its line breaks)
  phonetics: string;           // matched phonetics for this line (selected language)
  /** This line's OWN translation (the chunk's i-th `<p>`), so the recto renders each
   *  phonetics line immediately followed by its translation (interlinear pairs). */
  translation: string | null;
  /** True on the last line of a chunk: a blank line follows (a balancing gap). */
  emptyAfter: boolean;
  /** Sapche outline nesting depth (0 = top-level) when this line heads a tree node,
   *  so section headings size by depth; null otherwise. */
  level: number | null;
  /** Set on the head/tail of a mid-line split — the original line's anchor syllable, so
   *  the split can be cleared from either half. */
  splitAnchor?: string;
  /** Title lines only: the title chunk's translation split into its `<p>` pieces, so
   *  the cover / internal title page can show the first as the main title and the rest
   *  as the subtitle. Set on every title line (they share their chunk's paragraphs). */
  paragraphs?: string[];
}

const rk = (a: string, b: string) => `${a}-${b}`;

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function compileTextItem(item: DocumentItem, lang: string): Promise<DocLine[]> {
  const textId = item.text_id!;
  const [tokens, spans, breaks, markers, translations, phonetics, treeNodes] = await Promise.all([
    getEditorTokens(textId),
    fetchJson(`${API_BASE}/texts/${textId}/spans`),
    fetchJson(`${API_BASE}/texts/${textId}/display-breaks`),
    fetchJson(`${API_BASE}/texts/${textId}/markers`),
    getTextTranslations(textId),
    getPhonetics(textId, lang),
    fetchJson(`${API_BASE}/texts/${textId}/tree-nodes`),
  ]);

  // Sapche outline depth per anchor syllable: a tree node's `segment_start` offset →
  // the syllable starting there → its nesting depth (root = 0). Section headings use
  // this to step their size by outline level.
  const depthOfNode = (n: any): number => {
    let d = 0, cur = n, guard = 0;
    const byId = new Map<number, any>(treeNodes.map((x: any) => [x.id, x]));
    while (cur.parent_id != null && guard++ < 64) { cur = byId.get(cur.parent_id); if (!cur) break; d++; }
    return d;
  };
  const sylAtOffset = new Map<number, string>();
  for (const t of tokens) if (t.text.trim() !== '') sylAtOffset.set(t.start_offset, t.id);
  const depthBySyl = new Map<string, number>();
  for (const n of treeNodes) {
    if (n.segment_start == null) continue;
    const syl = sylAtOffset.get(n.segment_start);
    if (!syl) continue;
    const d = depthOfNode(n);
    const prev = depthBySyl.get(syl);
    if (prev == null || d < prev) depthBySyl.set(syl, d);
  }

  const breakOverrides = new Map<string, number>(breaks.map((b: any) => [b.syl_id, b.count]));
  const markerOffsets = new Set<number>(markers.map((m: any) => m.position));
  const groups = { verse: true, sapche: true, mantra: true };

  const lines = deriveChunks(tokens, markerOffsets, spans, breakOverrides, groups, undefined, true);
  const chunks = deriveChunks(tokens, markerOffsets, spans, breakOverrides, groups);

  // Phonetics matched to a line: exact range, else the row ANCHORED in this line (its
  // start syllable falls here). Anchor-only — matching the end syllable too would make a
  // row spanning several lines render on both its first AND last line (duplication).
  const phonByRange = new Map<string, string>();
  for (const p of phonetics) phonByRange.set(rk(p.start_syl_id, p.end_syl_id), p.body);
  const phonFor = (l: { startSylId: string; endSylId: string; sylIds: string[] }): string => {
    const exact = phonByRange.get(rk(l.startSylId, l.endSylId));
    if (exact != null) return exact;
    const ids = new Set(l.sylIds);
    for (const p of phonetics) if (ids.has(p.start_syl_id)) return p.body;
    return '';
  };

  // Translation matched to a chunk: exact range, else the row ANCHORED in this chunk
  // (its start syllable falls here). Anchor-only — matching the end syllable too would
  // make a translation spanning several derived chunks render on both its first AND last
  // chunk with an empty gap between (the colophon-duplication bug).
  const transByRange = new Map<string, string>();
  for (const c of translations) {
    const t = c.translations.find((x) => x.lang === lang);
    if (t) transByRange.set(rk(c.start_syl_id, c.end_syl_id), t.body);
  }
  const transFor = (ch: { startSylId: string; endSylId: string; sylIds: string[] }): string => {
    const exact = transByRange.get(rk(ch.startSylId, ch.endSylId));
    if (exact != null) return exact;
    const ids = new Set(ch.sylIds);
    for (const c of translations) {
      if (ids.has(c.start_syl_id)) {
        const t = c.translations.find((x) => x.lang === lang);
        if (t) return t.body;
      }
    }
    return '';
  };

  // Which chunk each line belongs to (by first-syllable membership), so the chunk's
  // translation attaches to the chunk's first line and blank-line gaps land on the last.
  const chunkKeyOfSyl = new Map<string, string>();
  const chunkByKey = new Map<string, typeof chunks[number]>();
  for (const ch of chunks) {
    chunkByKey.set(ch.key, ch);
    for (const id of ch.sylIds) chunkKeyOfSyl.set(id, ch.key);
  }

  // INTERLINEAR pairs: a chunk's translation body is one <p> per line, 1:1 with the
  // chunk's phonetics lines. Split it and give each line its OWN translation line
  // (extra <p>s append to the last line; missing → none), so the recto renders each
  // phonetics line immediately followed by its translation.
  const lineChunkKeys = lines.map((l) => chunkKeyOfSyl.get(l.startSylId) ?? null);
  const linesByChunk = new Map<string, number[]>();
  lineChunkKeys.forEach((ck, i) => {
    if (ck == null) return;
    const arr = linesByChunk.get(ck) ?? [];
    arr.push(i);
    linesByChunk.set(ck, arr);
  });
  const translationByLine = new Map<number, string>();
  for (const [ck, idxs] of linesByChunk) {
    const parts = splitParagraphs(transFor(chunkByKey.get(ck)!));
    idxs.forEach((lineIdx, k) => {
      const piece = k === idxs.length - 1 && parts.length > idxs.length
        ? parts.slice(k).join(' ')
        : (parts[k] ?? '');
      if (piece) translationByLine.set(lineIdx, piece);
    });
  }

  const out: DocLine[] = [];
  lines.forEach((l, i) => {
    const ck = lineChunkKeys[i];
    const lastOfChunk = ck != null && ck !== (lineChunkKeys[i + 1] ?? null);
    // For a title line, preserve the whole title chunk's `<p>` structure (main title
    // vs subtitle) — the per-line translation join above flattens it.
    const paragraphs = l.tagType === 'title' && ck != null
      ? splitParagraphs(transFor(chunkByKey.get(ck)!)) : undefined;
    out.push({
      itemId: item.id,
      textId,
      key: `${item.id}:${l.key}`,
      role: l.tagType,
      startSylId: l.startSylId,
      endSylId: l.endSylId,
      tokens: l.tokens,
      phonetics: phonFor(l),
      translation: translationByLine.get(i) ?? null,
      emptyAfter: lastOfChunk,
      level: depthBySyl.get(l.startSylId) ?? null,
      ...(paragraphs && paragraphs.length ? { paragraphs } : {}),
    });
  });
  return out;
}

/** Split a translation body into its per-line `<p>` pieces. Parses via the DOM (not a
 *  regex) so HTML entities in the text decode (`&#x27;` → `'`); a paragraph with inline
 *  markup keeps it (innerHTML), a plain one is returned as decoded text — either way the
 *  downstream `sanitizeTranslationHtml` renders it once, without re-encoding the `&`. */
function splitParagraphs(html: string): string[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ps = Array.from(doc.body.querySelectorAll('p'));
  if (!ps.length) return html.trim() ? [html.trim()] : [];
  return ps
    .map((p) => {
      const hasEl = Array.from(p.childNodes).some((n) => n.nodeType === Node.ELEMENT_NODE);
      return (hasEl ? p.innerHTML : p.textContent ?? '').trim();
    })
    .filter(Boolean);
}

export interface CompiledDoc {
  /** The document's body line stream (title lifted out), text pages in order. */
  lines: DocLine[];
  /** Per text item: its lifted leading title line(s) (Tibetan + translated title),
   *  for the title/cover page. */
  titleByItem: Map<number, DocLine[]>;
}

/** Compile the whole document's text pages for one language, lifting each text's
 *  leading title (role `title`) out of the body so it can head a title page. */
export async function compileDocument(items: DocumentItem[], lang: string): Promise<CompiledDoc> {
  const lines: DocLine[] = [];
  const titleByItem = new Map<number, DocLine[]>();
  for (const it of items) {
    if (it.kind !== 'text' || it.text_id == null) continue;
    const compiled = await compileTextItem(it, lang);
    let i = 0;
    const titleLines: DocLine[] = [];
    while (i < compiled.length && compiled[i].role === 'title') { titleLines.push(compiled[i]); i++; }
    titleByItem.set(it.id, titleLines);
    lines.push(...compiled.slice(i));
  }
  return { lines, titleByItem };
}
