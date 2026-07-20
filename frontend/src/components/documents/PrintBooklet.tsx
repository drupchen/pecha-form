import React, { useEffect, useState } from 'react';
import {
  getDocument, getDocumentLayout, getFurniture, getOrgSeal,
  type DocumentDetail, type DocumentItem, type LayoutConfig, type DocumentLayoutRow,
  type DocumentFurnitureRow, type OrgSeal,
} from '../../api/client';
import { compileDocument, type DocLine, type OutlineHeading } from './compile';
import {
  rootVars, Verso, Recto, TitleContent, FurnitureContent,
  deriveBooklet, furnitureBodyOf, pageVars, anchorOf, TIBETAN_LANG, versoGapSuppressed,
  gapFillLang, furnitureGroundOf, furnitureSpaceOf, furnitureSlotsOf,
  type LineAdj, type WidthTarget, type BlockWidthOf, type PageSide,
} from './bookletRender';
import { loadBookletStyleCss } from './bookletStyles';
import '../../styles/booklet.css';

/**
 * Print/PDF page (Phase D3). Renders the WHOLE booklet as a sequential run of physical
 * pages (front matter → each spread's Tibetan verso then phonetics/translation recto →
 * back matter), NOT virtualized and NOT interactive — the exact layout the pagination
 * bench shows, laid out for paper. Headless Chromium navigates here and prints to PDF,
 * so it is the same rendering engine as the bench → WYSIWYG. A `data-booklet-ready`
 * flag + `window.__BOOKLET_READY__` signal the PDF driver that fonts and layout settled.
 */
export const PrintBooklet: React.FC<{ documentId: number; lang: string; version?: string }> = ({ documentId, lang, version }) => {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [rows, setRows] = useState<DocumentLayoutRow[]>([]);
  const [furniture, setFurniture] = useState<DocumentFurnitureRow[]>([]);
  const [lines, setLines] = useState<DocLine[]>([]);
  const [titleByItem, setTitleByItem] = useState<Map<number, DocLine[]>>(new Map());
  const [headingsByItem, setHeadingsByItem] = useState<Map<number, OutlineHeading[]>>(new Map());
  const [ready, setReady] = useState(false);
  const [styleCss, setStyleCss] = useState('');
  const [orgSeal, setOrgSeal] = useState<OrgSeal | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [d, lay, furn, css, seal] = await Promise.all([
        getDocument(documentId), getDocumentLayout(documentId), getFurniture(documentId),
        loadBookletStyleCss(documentId), getOrgSeal().catch(() => null)]);
      if (!alive) return;
      const edition = d.languages.includes(lang) ? lang : (d.languages[0] ?? 'en');
      const compiled = await compileDocument(d.items, edition);
      if (!alive) return;
      setDoc(d); setConfig(lay.config); setRows(lay.rows); setFurniture(furn);
      setStyleCss(css);
      setOrgSeal(seal);
      setLines(compiled.lines); setTitleByItem(compiled.titleByItem);
      setHeadingsByItem(compiled.headingsByItem);
    })();
    return () => { alive = false; };
  }, [documentId, lang]);

  // Signal readiness once the DOM is painted and web fonts have loaded. Uses a timeout
  // (not requestAnimationFrame — rAF is throttled in background tabs, which would stall
  // the signal) so the PDF driver can reliably wait on `window.__BOOKLET_READY__`.
  useEffect(() => {
    if (!doc || !config) return;
    let alive = true;
    let timer = 0;
    const done = () => {
      if (!alive) return;
      (window as any).__BOOKLET_READY__ = true;
      setReady(true);
    };
    const fonts = (document as any).fonts;
    const after = () => { timer = window.setTimeout(done, 80); };
    if (fonts?.ready) fonts.ready.then(after); else after();
    return () => { alive = false; clearTimeout(timer); };
  }, [doc, config, lines]);

  if (!doc || !config) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading booklet…</div>;
  }

  const { lines: flowLines, bodyUnits, frontMatter, backMatter, tocRows, mainTitleLines,
          navOutline, hairlineSet } =
    deriveBooklet(doc.items, rows, lines, titleByItem, furniture, lang, false, headingsByItem);
  const vars = rootVars(config);
  const outlineJson = JSON.stringify(navOutline);

  // Every balancing row the bench stores, read back and applied with NO handlers — the
  // printed page must CARRY what the user set without offering to change it. Keyed exactly
  // as the bench writes them: the Tibetan (verso gaps, width_tibetan) is shared (lang ''),
  // everything on the recto — widths AND its empty-line gaps — is per edition.
  const rowByKey = new Map<string, DocumentLayoutRow>();
  for (const r of rows) rowByKey.set(`${r.item_id}:${r.anchor_syl_id}:${r.kind}:${r.lang ?? ''}`, r);
  // By the line's anchor, falling back to the bare syllable for rows written before the op
  // was part of it — the same two vintages the bench reads, through the same rule.
  const rowOf = (l: DocLine, kind: string, rowLang: string) =>
    rowByKey.get(`${l.itemId}:${anchorOf(l)}:${kind}:${rowLang}`)
    ?? rowByKey.get(`${l.itemId}:${l.startSylId}:${kind}:${rowLang}`);
  const val = (l: DocLine, kind: string, rowLang = '') => rowOf(l, kind, rowLang)?.value ?? null;
  const has = (l: DocLine, kind: string, rowLang = '') => rowOf(l, kind, rowLang) != null;
  const adjFor = (l: DocLine, side: PageSide): LineAdj => ({
    // These two were hardcoded to 0/false, so the PDF quietly ignored the empty-line
    // balancing and printed every gap at full height — pages the bench had measured as
    // fitting then ran past the text block. The pagination is flowed against these values;
    // the print has to render against them too or it is paginating a different document.
    // Keyed per side and per edition, exactly as the bench now writes them: the verso's
    // gaps under '' (one Tibetan, set once), this edition's recto gaps under its lang.
    gapDeltaMm: val(l, 'line_space', gapFillLang(side, lang)) ?? 0,
    noSpace: has(l, 'line_nospace', gapFillLang(side, lang)),
    widths: {
      tibetan: val(l, 'width_tibetan', '') ?? 0,
      phonetics: val(l, 'width_phonetics', lang) ?? 0,
      translation: val(l, 'width_translation', lang) ?? 0,
      section: val(l, 'width_section', lang) ?? 0,
    } as Partial<Record<WidthTarget, number>>,
  });

  // A page's lines, with the reference's thin continuation rule at a hairline boundary
  // (top if continued from the previous page, bottom if it runs on to the next).
  // `atPageTop` suppresses space-above on whatever opens the page, exactly as the bench does
  // — the PDF and the bench must agree line for line, and this is the rule the pagination
  // was measured against.
  const renderLines = (s: { start: number; end: number }, Comp: typeof Verso) => {
    const opensWithRule = hairlineSet.has(s.start);
    return (
      <>
        {opensWithRule && <div className="bk-hairline bk-atpagetop" />}
        {flowLines.slice(s.start, s.end).map((l, k) => (
          <Comp key={l.key} l={l} adj={adjFor(l, Comp === Verso ? 'verso' : 'recto')}
                atPageTop={k === 0 && !opensWithRule}
                noGap={Comp === Verso && versoGapSuppressed(flowLines, s.start + k)} />
        ))}
        {hairlineSet.has(s.end) && <div className="bk-hairline" />}
      </>
    );
  };

  /** A special page's stored block widths, keyed exactly as the bench writes them — the
   *  Tibetan title on its own syllable and shared, the translated furniture on its block name
   *  and per edition. Read back with NO handlers: the print page carries what was set. */
  const furnitureWidthOf = (item: DocumentItem): BlockWidthOf => (key: string) => {
    const furn = key.startsWith('#');
    const kind = furn ? 'width_furniture' : 'width_tibetan';
    // Keyed exactly as the bench writes them — including that the booklet's own Tibetan
    // ('#title_tib') is shared across editions, like the text's own.
    const rowLang = furn && !key.startsWith('#title_tib') ? lang : '';
    const r = rowByKey.get(`${item.id}:${key}:${kind}:${rowLang}`);
    return { valueMm: r?.value ?? 0, min: 0, max: 0 };
  };

  // A single physical page (front/back matter furniture item).
  // The special pages' block placements, read through the same helper the bench writes
  // them with, so the two cannot drift. Ink, not chrome — `groundOf` here returns values
  // with NO `onCommit`, so the offsets print and the handles do not exist.
  const FurniturePageSheet: React.FC<{ item: DocumentItem }> = ({ item }) => (
    <div className="booklet-page furniture print-page">
      <div className="booklet-content">
        <FurnitureContent
          item={item}
          titleLines={item.kind === 'cover' ? mainTitleLines : []}
          body={furnitureBodyOf(furniture, item, lang)}
          toc={item.kind === 'toc' ? tocRows : []}
          orgSeal={orgSeal}
          version={version}
          widthOf={furnitureWidthOf(item)}
          tibetan={furnitureBodyOf(furniture, item, TIBETAN_LANG)}
          slots={furnitureSlotsOf(furniture, item, lang)}
          groundOf={furnitureGroundOf(rows, item.id, lang)}
          spaceOf={furnitureSpaceOf(rows, item.id)}
          pageHeightMm={config.page_height_mm} />
      </div>
    </div>
  );

  let folio = 0;  // recto page number (each body-unit is one folio; verso is unnumbered)
  return (
    <div className="booklet-root booklet-print" style={vars}
         data-booklet-ready={ready ? 'true' : 'false'}>
      {/* Concrete @page size (CSS variables aren't allowed in @page). */}
      <style>{`@page { size: ${config.page_width_mm}mm ${config.page_height_mm}mm; margin: 0; }`}</style>
      {/* Data-driven typography (org styles ← per-doc overrides); default = booklet.css. */}
      {styleCss && <style dangerouslySetInnerHTML={{ __html: styleCss }} />}
      {/* The PDF navigation outline (bookmarks): the export endpoint reads this blob
          from the rendered DOM and injects it into the PDF. */}
      <script id="booklet-outline" type="application/json"
              dangerouslySetInnerHTML={{ __html: outlineJson }} />

      {frontMatter.map((it) => <FurniturePageSheet key={`f${it.id}`} item={it} />)}

      {bodyUnits.map((u, i) => {
        folio = i + 1;
        if (u.kind === 'title') {
          return (
            <div key={`u${i}`} className="booklet-page furniture print-page">
              <div className="booklet-content">
                <TitleContent titleLines={u.titleLines} widthOf={furnitureWidthOf(u.item)}
                              tibetan={furnitureBodyOf(furniture, u.item, TIBETAN_LANG)}
                              slots={furnitureSlotsOf(furniture, u.item, lang)}
                              groundOf={furnitureGroundOf(rows, u.item.id, lang)}
                              spaceOf={furnitureSpaceOf(rows, u.item.id)}
                              pageHeightMm={config.page_height_mm} />
              </div>
            </div>
          );
        }
        // Each page's balancing rides as CSS vars, exactly as on the bench — the two read the
        // same rows through the same helper, so they cannot drift apart. The sides balance
        // independently: the Tibetan is denser and carries its own, shared by every edition.
        // `.bk-shift` is the block the page's shift moves; body pages only, as on the bench.
        const start = flowLines[u.s.start];
        return (
          <React.Fragment key={`u${i}`}>
            <div className="booklet-page verso print-page"
                 style={pageVars(rows, start, lang, 'verso')}>
              <div className="booklet-content">
                <div className="bk-shift">{renderLines(u.s, Verso)}</div>
              </div>
            </div>
            <div className="booklet-page recto print-page"
                 style={pageVars(rows, start, lang, 'recto')}>
              <div className="booklet-content">
                <div className="bk-shift">{renderLines(u.s, Recto)}</div>
              </div>
              <div className="booklet-folio">{folio}</div>
            </div>
          </React.Fragment>
        );
      })}

      {backMatter.map((it) => <FurniturePageSheet key={`b${it.id}`} item={it} />)}
    </div>
  );
};
