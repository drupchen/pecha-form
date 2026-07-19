import {
  API_BASE, getEditorTokens, getTextTranslations, getPhonetics, getLayouts,
  type DocumentItem,
} from '../../api/client';
import { deriveChunks, insertTitleChunks } from '../translate/chunks';
import { kindOf } from '../phonetics/lines';
import { apiFetch } from '../../api/http';

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
  /**
   * The Tibetan render (carrying its own line breaks).
   *
   * `small` marks a syllable inside a MINOR run — small letters (ཡིག་ཆུང) or an inline
   * sapche topic. It is a property of the RUN, not of the line: a line commonly holds body
   * Tibetan and a small run together, and keeps a single `role` (it is one translation unit)
   * while its type sizes differ mid-line. That is a character style, and this flag is the
   * only thing that survives to say so — `deriveChunks` computes it per token and the line's
   * own `tagType` deliberately forgets it.
   */
  tokens: { id: string; render: string; small?: boolean }[];
  /** The derivation op that emitted this line's ANCHOR syllable, or null for the text's own.
   *  A syllable id is position-unique within a text, but a text that transcludes the same
   *  source twice repeats its uuids — so `(startSylId, opId)` is what actually names the
   *  line, and the booklet anchors on that (see `anchorOf`). */
  opId?: number | null;
  phonetics: string;           // matched phonetics for this line (selected language)
  /** This line's OWN translation (the chunk's i-th `<p>`), so the recto renders each
   *  phonetics line immediately followed by its translation (interlinear pairs). */
  translation: string | null;
  /** True on the last line of a chunk: a blank line follows (a balancing gap). */
  emptyAfter: boolean;
  /** Sapche outline nesting depth (0 = top-level) when this line heads a tree node,
   *  so section headings size by depth; null otherwise. */
  level: number | null;
  /** `small` lines only: which member of the small tag family tagged this line —
   *  'instructions' | 'verses' | 'colophon' | 'intro'. The continuation rule keys on it:
   *  an INSTRUCTIONS line after verse/prose has its TIBETAN merged onto that line (see the
   *  merge pass in `compileTextItem`); the other kinds stand alone. The instruction keeps
   *  its own line for its TRANSLATION — the merge is Tibetan-side only. */
  smallKind?: string;
  /** Set on the head/tail of a mid-line split — the original line's anchor syllable, so
   *  the split can be cleared from either half. */
  splitAnchor?: string;
  /** Title lines only: the title chunk's translation split into its `<p>` pieces, so
   *  the cover / internal title page can show the first as the main title and the rest
   *  as the subtitle. Set on every title line (they share their chunk's paragraphs). */
  paragraphs?: string[];
  /** A translation-only title with NO translation in this edition: the heading slot renders a
   *  muted placeholder (not blank, not another language's text) so the missing title is visible
   *  on the page. */
  missingTitle?: boolean;
}

/** A fresh identity per EVALUATION of this module. In dev, a hot update replaces the
 *  module and importers re-render against a new object — the bench compares identities to
 *  notice that its compile CACHE was produced by code that no longer exists, and flushes
 *  it (a stale cache once kept rendering old rules for a whole session). In production the
 *  module evaluates once and this never changes. */
export const COMPILE_BUILD: object = {};

const rk = (a: string, b: string) => `${a}-${b}`;

async function fetchJson(url: string): Promise<any> {
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function compileTextItem(
  item: DocumentItem, lang: string,
): Promise<{ lines: DocLine[]; headings: OutlineHeading[] }> {
  const textId = item.text_id!;
  const [tokens, spans, breaks, markers, translations, phonetics, treeNodes, layouts] = await Promise.all([
    getEditorTokens(textId),
    fetchJson(`${API_BASE}/texts/${textId}/spans`),
    fetchJson(`${API_BASE}/texts/${textId}/display-breaks`),
    fetchJson(`${API_BASE}/texts/${textId}/markers`),
    getTextTranslations(textId),
    getPhonetics(textId, lang),
    fetchJson(`${API_BASE}/texts/${textId}/tree-nodes`),
    getLayouts(textId),
  ]);

  // Sapche outline depth per anchor syllable: a tree node's `segment_start` offset →
  // the syllable starting there → its nesting depth (root = 0). Section headings use
  // this to step their size by outline level.
  const nodeById = new Map<number, any>(treeNodes.map((x: any) => [x.id, x]));
  const depthOfNode = (n: any): number => {
    let d = 0, cur = n, guard = 0;
    while (cur.parent_id != null && guard++ < 64) { cur = nodeById.get(cur.parent_id); if (!cur) break; d++; }
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
  // A manually-set heading level per chunk-start syllable (H1-based). The Translate bench
  // lets a heading NOT anchored in the sapche outline carry an explicit level; the booklet
  // navigation nests by it where the tree does not supply a depth.
  const levelBySyl = new Map<string, number>();
  for (const c of translations) if (c.level != null) levelBySyl.set(c.start_syl_id, c.level);
  // A per-heading render override: 'small_intro' turns a sapche/title heading into a
  // small-face gloss (a commentary, not a Western title) — set in the Translate bench.
  const renderAsBySyl = new Map<string, string>();
  for (const c of translations) if (c.render_as) renderAsBySyl.set(c.start_syl_id, c.render_as);

  const breakOverrides = new Map<string, number>(breaks.map((b: any) => [b.syl_id, b.count]));
  const markerOffsets = new Set<number>(markers.map((m: any) => m.position));
  const groups = { verse: true, sapche: true, mantra: true };

  // The body line stream, WITH the translation-only title layouts (the scramble layer) spliced
  // in — the same insert the translate bench does. Without it the titles reached the navigation
  // outline (below) but never the printed pages. `layouts` is shared across editions, so every
  // edition gets the same entries at the same indices and the shared pagination stays aligned.
  // `splitInstructions` (last arg): keep small-INSTRUCTIONS runs as their own units so their
  // translation never rides inline into a neighbour — the continuation rule below appends only
  // their Tibetan. Passed to BOTH derives so the line stream and the chunk stream agree.
  const lines = insertTitleChunks(
    deriveChunks(tokens, markerOffsets, spans, breakOverrides, groups, undefined, true, true), layouts);
  const chunks = deriveChunks(tokens, markerOffsets, spans, breakOverrides, groups, undefined, false, true);

  // Where each syllable sits in the stream — so rows matched to a line come back in the
  // order they are read, whatever order the API listed them in.
  const posById = new Map<string, number>();
  tokens.forEach((t, i) => posById.set(t.id, i));

  // Phonetics matched to a line: EVERY row anchored in it (its start syllable falls here),
  // in stream order, one per output line.
  //
  // All of them, not the first. The Tibetan and its phonetics do not divide the same way and
  // are not meant to: one Tibetan display line commonly carries several phonetics rows — a
  // mantra's phrases, most obviously — and returning the first silently dropped the rest, so
  // the PDF printed the opening of a mantra and threw the body of it away.
  //
  // But only the line's OWN recitation kind: a mantra recites its Sanskrit (`skt`), a
  // verse/prose its Tibetan phonetics (`bo`). When both a `skt` and a `bo` row are anchored
  // on the same mantra syllables (some editions carry a stale `bo` reading the others don't),
  // taking all of them printed the mantra TWICE — once romanised, once in Tibetan phonetics.
  // Prefer the kind the line's role calls for; fall back to whatever exists so a line whose
  // only rows are the other kind still shows.
  //
  // Anchor-only — matching the end syllable too would make a row spanning several lines
  // render on both its first AND its last (duplication).
  const phonByStart = new Map<string, typeof phonetics>();
  for (const p of phonetics) {
    const rows = phonByStart.get(p.start_syl_id);
    if (rows) rows.push(p); else phonByStart.set(p.start_syl_id, [p]);
  }
  const phonFor = (l: { startSylId: string; endSylId: string; sylIds: string[]; tagType: string }): string => {
    let matched = l.sylIds.flatMap((id) => phonByStart.get(id) ?? []);
    const want = kindOf(l.tagType);
    if (want) {
      const preferred = matched.filter((p) => p.kind === want);
      if (preferred.length) matched = preferred;
    }
    return matched
      .sort((a, b) => (posById.get(a.start_syl_id) ?? 0) - (posById.get(b.start_syl_id) ?? 0))
      .map((p) => p.body)
      .join('\n');
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
  const transByStart = new Map<string, typeof translations>();
  for (const c of translations) {
    const rows = transByStart.get(c.start_syl_id);
    if (rows) rows.push(c); else transByStart.set(c.start_syl_id, [c]);
  }
  const transFor = (ch: { startSylId: string; endSylId: string; sylIds: string[] }): string => {
    const exact = transByRange.get(rk(ch.startSylId, ch.endSylId));
    if (exact != null) return exact;
    // EVERY translation anchored in this chunk, in stream order — a derived chunk can span
    // several of the origin's, and taking the first threw the others away. Concatenated as
    // HTML, so `splitParagraphs` below sees all of their paragraphs.
    const hits = ch.sylIds
      .flatMap((id) => transByStart.get(id) ?? [])
      .sort((a, b) => (posById.get(a.start_syl_id) ?? 0) - (posById.get(b.start_syl_id) ?? 0))
      .map((c) => c.translations.find((x) => x.lang === lang)?.body)
      .filter((b): b is string => !!b);
    return hits.join('');
  };

  // Which chunk each line belongs to — by STREAM OFFSET, not syllable id. A composed
  // stream repeats syllable uuids (the same source transcluded N times, told apart only
  // by the emitting op), so an id-keyed map collapsed every occurrence onto the LAST
  // occurrence's chunk: the paragraph split below then dealt the translation to the first
  // occurrence's lines and starved the rest — a section transcluded four times printed
  // its heading and translation once and bare Tibetan the other three. Offsets are
  // cumulative over the composed stream, unique per occurrence; both `lines` and `chunks`
  // walk the same tokens in order, so a line belongs to the last chunk at or before it.
  const chunkByKey = new Map<string, typeof chunks[number]>();
  for (const ch of chunks) chunkByKey.set(ch.key, ch);
  const chunkStarts = chunks.map((ch) => ch.startOffset);
  const chunkAt = (off: number): string | null => {
    let lo = 0, hi = chunkStarts.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunkStarts[mid] <= off) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at >= 0 ? chunks[at].key : null;
  };

  // INTERLINEAR pairs: a chunk's translation body is one <p> per line, 1:1 with the
  // chunk's phonetics lines. Split it and give each line its OWN translation line
  // (extra <p>s append to the last line; missing → none), so the recto renders each
  // phonetics line immediately followed by its translation.
  // Spliced title layouts (`startSylId: ''`, offset -1) belong to no chunk, as before.
  const lineChunkKeys = lines.map((l) => l.startSylId ? chunkAt(l.startOffset) : null);
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
      // The last line takes whatever paragraphs are left over — as separate lines. Joining
      // them with a space ran them together into one, which is the same loss in a quieter
      // form: the text was there, but not the lines the translator wrote.
      const piece = k === idxs.length - 1 && parts.length > idxs.length
        ? parts.slice(k).join('<br>')
        : (parts[k] ?? '');
      if (piece) translationByLine.set(lineIdx, piece);
    });
  }

  const out: DocLine[] = [];
  lines.forEach((l, i) => {
    // A translation-only title (scramble-layer layout): it has no syllables, so its heading
    // text comes from the layout's `titles` FOR THIS EDITION only — never another language's, so
    // a title translated in one edition shows blank in the others and its missing content is
    // visible. Emit it UNCONDITIONALLY all the same — a title present in some editions but not
    // others must still occupy a line in every edition, or the shared line streams fall out of
    // alignment. `startSylId` is '' — the discriminator the navigation loop uses to avoid
    // double-listing it.
    if (l.titleLayout) {
      const ly = l.titleLayout;
      const body = (ly.titles[lang] ?? '').trim();
      const paras = splitParagraphs(body);
      // 'small_intro' renders this title as a small-face gloss, not a section heading:
      // no level (no TOC entry), and the small/intro role + kind carry the small face.
      const gloss = ly.render_as === 'small_intro';
      out.push({
        itemId: item.id, textId, key: `${item.id}:${l.key}`, role: gloss ? 'small' : 'title',
        startSylId: '', endSylId: '', opId: null, tokens: [],
        phonetics: '', translation: body || null, emptyAfter: false,
        level: gloss ? null : Math.max(0, (ly.level ?? 1) - 1),
        ...(gloss ? { smallKind: 'intro' } : {}),
        ...(paras.length ? { paragraphs: paras } : {}),
        ...(body ? {} : { missingTitle: true }),
      });
      return;
    }
    const ck = lineChunkKeys[i];
    const lastOfChunk = ck != null && ck !== (lineChunkKeys[i + 1] ?? null);
    // For a title line, preserve the whole title chunk's `<p>` structure (main title
    // vs subtitle) — the per-line translation join above flattens it.
    const paragraphs = l.tagType === 'title' && ck != null
      ? splitParagraphs(transFor(chunkByKey.get(ck)!)) : undefined;
    // A heading (sapche/title) the editor set to render as a small-face gloss: it becomes a
    // small/intro line — small on BOTH sides, no heading level, no TOC entry — instead of a
    // section title. (A sapche that reads as commentary, not a Western-style heading.)
    const gloss = (l.tagType === 'sapche' || l.tagType === 'title')
      && renderAsBySyl.get(l.startSylId) === 'small_intro';
    out.push({
      itemId: item.id,
      textId,
      key: `${item.id}:${l.key}`,
      role: gloss ? 'small' : l.tagType,
      startSylId: l.startSylId,
      endSylId: l.endSylId,
      // The op of the token the line ANCHORS on — its first substantial one — not of
      // whatever whitespace happens to lead the render.
      opId: l.tokens.find((t) => t.id === l.startSylId)?.opId ?? null,
      tokens: l.tokens,
      phonetics: phonFor(l),
      translation: translationByLine.get(i) ?? null,
      emptyAfter: lastOfChunk,
      level: gloss ? null : (depthBySyl.get(l.startSylId) ?? null),
      ...(gloss ? { smallKind: 'intro' } : (l.smallKind ? { smallKind: l.smallKind } : {})),
      ...(paragraphs && paragraphs.length ? { paragraphs } : {}),
    });
  });
  // ── The continuation rule (TIBETAN side only) ──
  // A small-INSTRUCTIONS line's TIBETAN never stands on its own line: it is concatenated
  // onto WHATEVER real-token line precedes it — verse, prose, mantra, a section heading,
  // another instruction's host — "the rule overrides everything that precedes it" (the
  // user's words), including the empty lines the translate pane needs for its chunking.
  // But the merge is TIBETAN-ONLY: the instruction keeps its OWN line for its TRANSLATION,
  // which renders as an ordinary standalone small recto line — never appended to the host's
  // translation. To keep the shared verso/recto line stream aligned, the instruction stays
  // a DocLine but with its tokens MOVED to the host (so its verso is empty) and its
  // phonetics cleared (instructions are not recited). `host` tracks the last real-token
  // line, so a chain of instructions all append onto the same verse/prose/mantra rather
  // than onto a prior (now token-empty) instruction. Only a text's very first line has
  // nothing to continue; a text-first instruction keeps its tokens and becomes a host.
  //
  // HERE, in the booklet compile, and nowhere upstream: the translate bench, workspace
  // and phonetics keep their own line pictures, and the print page inherits the rule
  // through this shared compile. The decision reads only roles/smallKind, which derive
  // from the SHARED spans — every edition merges the same lines, so the streams stay
  // index-aligned and the shared break set keeps working.
  const mergedOut: DocLine[] = [];
  let host: DocLine | null = null;   // last line carrying real tokens — the merge target
  for (const l of out) {
    if (l.role === 'small' && l.smallKind === 'instructions' && host) {
      // Every line-level chunk's last token carries a trailing `\n` (the display break
      // deriveChunks appends at `count>=1`), and `.bk-tibetan` is `white-space: pre-wrap` —
      // so appended as-is that `\n` would force the small run onto a NEW visual line. Strip
      // ONLY that artificial newline (not other whitespace), so the run flows straight on
      // after the source's own separator — Tibetan joins on the tsheg (་) / shad, never a
      // space. The tokens are appended UNMODIFIED, reproducing the editor's text exactly.
      // The clone never mutates the shared token; chains strip each prior run's `\n` at
      // their own join.
      const last = host.tokens[host.tokens.length - 1];
      host.tokens = [
        ...host.tokens.slice(0, -1),
        ...(last ? [{ ...last, render: last.render.replace(/\n+$/u, '') }] : []),
        ...l.tokens.map((t) => ({ ...t, small: true })),
      ];
      host.endSylId = l.endSylId;
      // Keep the instruction as its OWN line for the recto: tokens moved to the host (empty
      // verso), phonetics dropped. Its own `emptyAfter` (the gap after it) and the host's
      // own `emptyAfter` (the gap before it) both stay untouched — reproducing the original
      // spacing on the recto. `host` is NOT advanced: a token-empty line is never a target.
      mergedOut.push({ ...l, tokens: [], phonetics: '' });
      continue;
    }
    mergedOut.push(l);
    host = l;
  }
  out.length = 0;
  out.push(...mergedOut);

  // ── Navigation outline: the TRANSLATION pane's headings, per language ──
  // The booklet reads in one language, so its navigation is the sequence of headings the
  // translator sees, labelled with the SELECTED language's string (never the Tibetan tree
  // title) and INCLUDING the translation-only title chunks (scramble layer) that exist in
  // no other layer. Two sources, merged in stream order and nested by heading level:
  //   1. heading LINES — a line tagged sapche/title — labelled by its own translation;
  //      skipped when it has none (an untranslated heading has no place in a translated
  //      booklet's navigation — the string is the point).
  //   2. TITLE layout chunks — a per-language title anchored before a chunk; the nodes
  //      "added in the translation pane that don't exist anywhere else".
  // Level is 0-based: the sapche depth where the tree supplies one, else the chunk's /
  // layout's manual H-level minus one (H1 → 0), so both scales nest together.
  const headings: OutlineHeading[] = [];
  // The leading title block is lifted out to head the text's title page (see
  // compileDocument) and becomes the text's own top-level nav entry — don't repeat it.
  let lead = 0;
  while (lead < out.length && out[lead].role === 'title') lead++;
  out.forEach((l, li) => {
    if (li < lead) return;
    if (l.role !== 'sapche' && l.role !== 'title') return;
    // Translation-only title lines (empty `startSylId`) are the scramble-layer titles now
    // rendered in the body — the `layouts` loop below already lists them in the outline with
    // their real anchor/level/order, so skip them here to avoid a duplicate bookmark.
    if (l.role === 'title' && !l.startSylId) return;
    const label = (l.translation ?? '').trim();
    if (!label) return;
    const depth = depthBySyl.get(l.startSylId);
    const level = depth != null ? depth
      : (levelBySyl.has(l.startSylId) ? levelBySyl.get(l.startSylId)! - 1 : 0);
    headings.push({ key: `line:${l.key}`, level, anchorSylId: l.startSylId,
                    label, order: posById.get(l.startSylId) ?? Infinity });
  });
  for (const ly of layouts) {
    if (ly.kind !== 'title' || ly.disabled) continue;
    // A title rendered as a gloss is body commentary, not a heading — no bookmark.
    if (ly.render_as === 'small_intro') continue;
    // This edition's title text only — a title untranslated here has no bookmark here either.
    const body = (ly.titles[lang] ?? '').trim();
    if (!body) continue;
    // A title chunk sits BEFORE the chunk starting at its anchor; the `-0.5` orders it
    // ahead of a heading line sharing that syllable. A null anchor rides at the end.
    const at = ly.anchor_syl_id != null ? posById.get(ly.anchor_syl_id) : undefined;
    headings.push({ key: `title:${ly.id}`, level: Math.max(0, (ly.level ?? 1) - 1),
                    anchorSylId: ly.anchor_syl_id ?? null, label: body,
                    order: at != null ? at - 0.5 : Infinity });
  }
  headings.sort((a, b) => a.order - b.order);
  return { lines: out, headings };
}

/** Split a translation body into its per-line `<p>` pieces. Parses via the DOM (not a
 *  regex) so HTML entities in the text decode (`&#x27;` → `'`); a paragraph with inline
 *  markup keeps it (innerHTML), a plain one is returned as decoded text — either way the
 *  downstream `sanitizeTranslationHtml` renders it once, without re-encoding the `&`. */
export function splitParagraphs(html: string): string[] {
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

/** A navigation heading, resolved for ONE language: an ordered, flat entry the booklet
 *  nests into its outline. It comes from the translation pane — a translated heading line
 *  or a translation-only title chunk — so `label` is already the right string. */
export interface OutlineHeading {
  key: string;
  /** 0-based nesting depth (sapche depth, or manual H-level − 1). */
  level: number;
  /** A compiled-stream token id whose line gives the heading its page; null = end. */
  anchorSylId: string | null;
  /** The heading's text in the compiled language (may be inline HTML). */
  label: string;
  /** Position in the token stream, for ordering (title chunks sit just before their anchor). */
  order: number;
}

export interface CompiledDoc {
  /** The document's body line stream (title lifted out), text pages in order. */
  lines: DocLine[];
  /** Per text item: its lifted leading title line(s) (Tibetan + translated title),
   *  for the title/cover page. */
  titleByItem: Map<number, DocLine[]>;
  /** Per text item: its translation-pane headings — the source of the navigation. */
  headingsByItem: Map<number, OutlineHeading[]>;
}

/** Compile the whole document's text pages for one language, lifting each text's
 *  leading title (role `title`) out of the body so it can head a title page. */
export async function compileDocument(items: DocumentItem[], lang: string): Promise<CompiledDoc> {
  const lines: DocLine[] = [];
  const titleByItem = new Map<number, DocLine[]>();
  const headingsByItem = new Map<number, OutlineHeading[]>();
  const textItems = items.filter((it) => it.kind === 'text' && it.text_id != null);
  // Compile every text concurrently — serially, a multi-text booklet paid the sum of each
  // text's network round-trips before first paint. Assembly below keeps document order.
  const compiledItems = await Promise.all(textItems.map((it) => compileTextItem(it, lang)));
  for (let k = 0; k < textItems.length; k++) {
    const it = textItems[k];
    const { lines: compiled, headings } = compiledItems[k];
    let i = 0;
    const titleLines: DocLine[] = [];
    // Only a Tibetan title (real tokens) heads the title page; a translation-only title layout
    // (no tokens) stays in the body so it prints as a section heading on the pages.
    while (i < compiled.length && compiled[i].role === 'title' && compiled[i].tokens.length > 0) {
      titleLines.push(compiled[i]); i++;
    }
    titleByItem.set(it.id, titleLines);
    headingsByItem.set(it.id, headings);
    lines.push(...compiled.slice(i));
  }
  return { lines, titleByItem, headingsByItem };
}
