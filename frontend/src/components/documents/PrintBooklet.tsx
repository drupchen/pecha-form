import React, { useEffect, useState } from 'react';
import {
  getDocument, getDocumentLayout, getFurniture, getOrgSeal,
  type DocumentDetail, type DocumentItem, type LayoutConfig, type DocumentLayoutRow,
  type DocumentFurnitureRow, type OrgSeal,
} from '../../api/client';
import { compileDocument, type DocLine, type OutlineHeading } from './compile';
import {
  rootVars, Verso, Recto, TitleContent, FurnitureContent,
  deriveBooklet, furnitureBodyOf, type LineAdj, type WidthTarget,
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
export const PrintBooklet: React.FC<{ documentId: number; lang: string }> = ({ documentId, lang }) => {
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
      setDoc(d); setConfig(lay.config); setRows(lay.rows); setFurniture(furn); setStyleCss(css);
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

  // Per-block widths, read back exactly as the bench stores them (Tibetan shared at '',
  // the translated recto blocks per edition) and applied with NO handlers — the printed
  // page must carry the widths the user set without offering to change them.
  const widthByKey = new Map<string, number>();
  for (const r of rows) {
    if (r.value != null && r.kind.startsWith('width_')) {
      widthByKey.set(`${r.item_id}:${r.anchor_syl_id}:${r.kind}:${r.lang ?? ''}`, r.value);
    }
  }
  const widthOf = (l: DocLine, kind: string, rowLang: string) =>
    widthByKey.get(`${l.itemId}:${l.startSylId}:${kind}:${rowLang}`) ?? 0;
  const adjFor = (l: DocLine): LineAdj => ({
    gapDeltaMm: 0, noSpace: false,
    widths: {
      tibetan: widthOf(l, 'width_tibetan', ''),
      phonetics: widthOf(l, 'width_phonetics', lang),
      translation: widthOf(l, 'width_translation', lang),
      section: widthOf(l, 'width_section', lang),
    } as Partial<Record<WidthTarget, number>>,
  });

  // A page's lines, with the reference's thin continuation rule at a hairline boundary
  // (top if continued from the previous page, bottom if it runs on to the next).
  const renderLines = (s: { start: number; end: number }, Comp: typeof Verso) => (
    <>
      {hairlineSet.has(s.start) && <div className="bk-hairline" />}
      {flowLines.slice(s.start, s.end).map((l) => <Comp key={l.key} l={l} adj={adjFor(l)} />)}
      {hairlineSet.has(s.end) && <div className="bk-hairline" />}
    </>
  );

  // A single physical page (front/back matter furniture item).
  const FurniturePageSheet: React.FC<{ item: DocumentItem }> = ({ item }) => (
    <div className="booklet-page furniture print-page">
      <div className="booklet-content">
        <FurnitureContent
          item={item}
          titleLines={item.kind === 'cover' ? mainTitleLines : []}
          body={furnitureBodyOf(furniture, item, lang)}
          toc={item.kind === 'toc' ? tocRows : []}
          orgSeal={orgSeal} />
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
              <div className="booklet-content"><TitleContent titleLines={u.titleLines} /></div>
            </div>
          );
        }
        return (
          <React.Fragment key={`u${i}`}>
            <div className="booklet-page verso print-page">
              <div className="booklet-content">{renderLines(u.s, Verso)}</div>
            </div>
            <div className="booklet-page recto print-page">
              <div className="booklet-content">{renderLines(u.s, Recto)}</div>
              <div className="booklet-folio">{folio}</div>
            </div>
          </React.Fragment>
        );
      })}

      {backMatter.map((it) => <FurniturePageSheet key={`b${it.id}`} item={it} />)}
    </div>
  );
};
