import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Scissors, Minus, FileDown } from 'lucide-react';
import {
  API_BASE, getDocument, getDocumentLayout, putLayoutRow, deleteLayoutRow, getFurniture,
  type DocumentDetail, type DocumentItem, type LayoutConfig, type DocumentLayoutRow,
  type DocumentFurnitureRow,
} from '../../api/client';
import { compileDocument, type DocLine } from './compile';
import {
  MM_PX, rootVars, Verso, Recto, FurniturePage, InternalTitlePage,
  deriveBooklet, furnitureBodyOf, type LineAdj,
} from './bookletRender';
import '../../styles/booklet.css';

/**
 * Pagination bench (Phase D2). Compiles a document's text pages into the SHARED line
 * stream and flows it into facing pages (Tibetan verso / phonetics+translation recto).
 * Page breaks are stored on the DOCUMENT (as `page_break` layout rows anchored to a
 * line's syllable) so every language edition uses the SAME breaks → the four editions
 * page-align. On first open the bench measures the DOM and seeds an auto-suggested set
 * of breaks; thereafter you tune them (click a line boundary to force/lift a break)
 * and switch editions to check the fit. Empty-line spacing, wrap-extend and mid-line
 * hairline splits build on this next.
 */
export const PaginationBench: React.FC<{ documentId: number; onClose: () => void }> = ({
  documentId, onClose,
}) => {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [rows, setRows] = useState<DocumentLayoutRow[]>([]);
  const [lang, setLang] = useState<string>('en');
  const [lines, setLines] = useState<DocLine[]>([]);
  const [titleByItem, setTitleByItem] = useState<Map<number, DocLine[]>>(new Map());
  const [furniture, setFurniture] = useState<DocumentFurnitureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [d, lay, furn] = await Promise.all([
        getDocument(documentId), getDocumentLayout(documentId), getFurniture(documentId)]);
      if (!alive) return;
      setDoc(d);
      setConfig(lay.config);
      setRows(lay.rows);
      setFurniture(furn);
      const edition = d.languages.includes(lang) ? lang : (d.languages[0] ?? 'en');
      setLang(edition);
      const compiled = await compileDocument(d.items, edition);
      setLines(compiled.lines);
      setTitleByItem(compiled.titleByItem);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [documentId]);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    (async () => {
      const compiled = await compileDocument(doc.items, lang);
      if (!alive) return;
      setLines(compiled.lines);
      setTitleByItem(compiled.titleByItem);
    })();
    return () => { alive = false; };
  }, [lang]);

  const contentWmm = config ? config.page_width_mm - config.margin_bind_mm - config.margin_outer_mm : 0;
  const contentHpx = config
    ? (config.page_height_mm - config.margin_top_mm - config.margin_bottom_mm) * MM_PX : 0;

  // Page structure (breaks, spreads, body page-units, front/back matter, TOC) —
  // computed by the SHARED `deriveBooklet` so the bench and the print/PDF page lay out
  // identically. The bench layers interactive break/balancing controls on top.
  const { breakSet, hairlineSet, spreads, bodyUnits, frontMatter, backMatter,
          tocRows, mainTitleLines } = useMemo(
    () => deriveBooklet(doc?.items ?? [], rows, lines, titleByItem, furniture, lang),
    [doc, rows, lines, titleByItem, furniture, lang],
  );

  const hasStoredBreaks = rows.some((r) => r.kind === 'page_break');

  // Auto-suggest pagination: the heavy full-stream measure container is mounted ONLY
  // while `measuring`, measured once, then unmounted (keeps the steady-state DOM light).
  const pendingReplace = useRef(false);
  const requestSeed = (replace: boolean) => {
    if (!lines.length || seeding) return;
    pendingReplace.current = replace;
    setSeeding(true);
  };

  useLayoutEffect(() => {
    if (!seeding || !measureRef.current || !config) return;
    const el = measureRef.current;
    (async () => {
      try {
        const hV = Array.from(el.querySelectorAll<HTMLElement>('[data-verso]'), (e) => e.offsetHeight);
        const hR = Array.from(el.querySelectorAll<HTMLElement>('[data-recto]'), (e) => e.offsetHeight);
        const idxs: number[] = [];
        let start = 0, accV = 0, accR = 0;
        for (let i = 0; i < lines.length; i++) {
          const nv = accV + (hV[i] || 0), nr = accR + (hR[i] || 0);
          if (i > start && (nv > contentHpx || nr > contentHpx)) {
            idxs.push(i); start = i; accV = hV[i] || 0; accR = hR[i] || 0;
          } else { accV = nv; accR = nr; }
        }
        if (pendingReplace.current) {
          await Promise.all(rows.filter((r) => r.kind === 'page_break').map((r) =>
            deleteLayoutRow(documentId, { item_id: r.item_id, anchor_syl_id: r.anchor_syl_id, kind: 'page_break' })));
        }
        await Promise.all(idxs.map((i) => putLayoutRow(documentId, {
          item_id: lines[i].itemId, anchor_syl_id: lines[i].startSylId, kind: 'page_break',
        })));
        setRows((await getDocumentLayout(documentId)).rows);
      } finally {
        setSeeding(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeding]);

  // Seed an initial pagination the first time a document is opened with no breaks yet.
  useEffect(() => {
    if (config && lines.length && !hasStoredBreaks && !seeding) requestSeed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, lines, hasStoredBreaks]);

  /** Toggle a forced page break at line `i` (start of a spread) — click a boundary. */
  const toggleBreak = async (i: number) => {
    if (i <= 0 || i >= lines.length) return;
    const l = lines[i];
    if (breakSet.has(i)) {
      await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'page_break' });
      // A lifted break drops any hairline marking too.
      if (hairlineSet.has(i))
        await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'hairline' });
    } else {
      await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'page_break' });
    }
    const lay = await getDocumentLayout(documentId);
    setRows(lay.rows);
  };

  /** Toggle a hairline (mid-content) break at line `i`: a page break drawn with a thin
   *  continuation rule. Setting it forces a break there too; clearing it leaves the
   *  break as an ordinary one. */
  const toggleHairline = async (i: number) => {
    if (i <= 0 || i >= lines.length) return;
    const l = lines[i];
    if (hairlineSet.has(i)) {
      await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'hairline' });
    } else {
      if (!breakSet.has(i))
        await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'page_break' });
      await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'hairline', value: 1 });
    }
    setRows((await getDocumentLayout(documentId)).rows);
  };

  // ── Per-line balancing (empty-line spacing, remove, wrap-extend) ──
  const layoutByKey = useMemo(() => {
    const m = new Map<string, DocumentLayoutRow>();
    for (const r of rows) m.set(`${r.item_id}:${r.anchor_syl_id}:${r.kind}`, r);
    return m;
  }, [rows]);
  const rowVal = (l: DocLine, kind: string) =>
    layoutByKey.get(`${l.itemId}:${l.startSylId}:${kind}`)?.value ?? null;
  const rowHas = (l: DocLine, kind: string) =>
    layoutByKey.has(`${l.itemId}:${l.startSylId}:${kind}`);

  const refreshLayout = async () => setRows((await getDocumentLayout(documentId)).rows);
  const putRow = async (l: DocLine, kind: 'line_space' | 'line_nospace' | 'wrap_extend', value: number) => {
    await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind, value });
    await refreshLayout();
  };
  const delRow = async (l: DocLine, kind: 'line_space' | 'line_nospace' | 'wrap_extend') => {
    await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind });
    await refreshLayout();
  };
  const adjustGap = (l: DocLine, delta: number) => {
    const next = (rowVal(l, 'line_space') ?? 0) + delta;
    next === 0 ? void delRow(l, 'line_space') : void putRow(l, 'line_space', next);
  };
  const toggleNoSpace = (l: DocLine) => {
    if (rowHas(l, 'line_nospace')) void delRow(l, 'line_nospace');
    else void putRow(l, 'line_nospace', 1);
  };
  const adjustWrap = (l: DocLine, delta: number) => {
    const cap = config ? config.margin_outer_mm - 2 : 10;
    const next = Math.max(0, Math.min(cap, (rowVal(l, 'wrap_extend') ?? 0) + delta));
    next === 0 ? void delRow(l, 'wrap_extend') : void putRow(l, 'wrap_extend', next);
  };
  const adjFor = (l: DocLine, interactive: boolean): LineAdj => ({
    gapDeltaMm: rowVal(l, 'line_space') ?? 0,
    noSpace: rowHas(l, 'line_nospace'),
    wrapMm: rowVal(l, 'wrap_extend') ?? 0,
    ...(interactive ? {
      onGap: (d: number) => adjustGap(l, d),
      onToggleNoSpace: () => toggleNoSpace(l),
      onWrap: (d: number) => adjustWrap(l, d),
    } : {}),
  });

  const vars = useMemo(() => (config ? rootVars(config) : {}), [config]);

  // Fixed-height virtualization: each page-unit is one page tall (+ a 24px gutter).
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);
  const spreadHpx = config ? config.page_height_mm * MM_PX + 24 : 800;
  const vFirst = Math.max(0, Math.floor(scrollTop / spreadHpx) - 1);
  const vLast = Math.min(bodyUnits.length, Math.ceil((scrollTop + viewH) / spreadHpx) + 1);

  const renderFurniture = (item: DocumentItem) => (
    <FurniturePage key={`f${item.id}`} item={item}
      titleLines={item.kind === 'cover' ? mainTitleLines : []}
      body={furnitureBodyOf(furniture, item, lang)} toc={item.kind === 'toc' ? tocRows : []} />
  );

  if (!doc || !config) {
    return <div className="flex-1 flex items-center justify-center text-ink-soft">Loading booklet…</div>;
  }

  const renderPageLines = (s: { start: number; end: number }, Comp: React.FC<{ l: DocLine; adj?: LineAdj }>) => {
    const isRecto = Comp === Recto;
    const els = lines.slice(s.start, s.end).map((l, k) => {
      const globalIdx = s.start + k;
      return (
        <div key={l.key} className="bk-linewrap" style={{ position: 'relative' }}>
          {/* Boundary controls between this line and the previous — plain page break
              (scissors) or a mid-content hairline split (rule). */}
          {k > 0 && (
            <span className="bk-breakctl-group">
              <button
                type="button"
                onClick={() => void toggleBreak(globalIdx)}
                className="bk-breakctl"
                title={breakSet.has(globalIdx) ? 'Lift page break' : 'Break page here'}
              >
                <Scissors size={9} />
              </button>
              <button
                type="button"
                onClick={() => void toggleHairline(globalIdx)}
                className={`bk-breakctl bk-hairctl${hairlineSet.has(globalIdx) ? ' bk-hairctl-on' : ''}`}
                title={hairlineSet.has(globalIdx) ? 'Lift hairline split' : 'Hairline split here (break mid-content)'}
              >
                <Minus size={9} />
              </button>
            </span>
          )}
          <Comp l={l} adj={adjFor(l, true)} />
        </div>
      );
    });
    // The reference's thin continuation rule: at the top if this page begins with a
    // hairline split (continued from the previous page); at the bottom if the next page
    // does (content runs on). Only on the recto text column.
    return (
      <>
        {isRecto && hairlineSet.has(s.start) && <div className="bk-hairline" />}
        {els}
        {isRecto && hairlineSet.has(s.end) && <div className="bk-hairline" />}
      </>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden booklet-root" style={vars}>
      <div className="px-5 py-2.5 shrink-0 flex items-center gap-4 bg-cream-hi text-xs"
           style={{ borderBottom: '1px solid var(--cline)' }}>
        <button type="button" onClick={onClose}
                className="px-2 py-1 rounded-md flex items-center gap-1 hover:bg-cream"
                style={{ border: '1px solid var(--cline)' }}>
          <X size={13} /> back
        </button>
        <h2 className="font-display text-lg text-lapis truncate max-w-xs">{doc.title}</h2>
        <div className="flex items-center gap-1">
          <span className="text-ink-soft mr-1">edition</span>
          {doc.languages.map((code) => (
            <button key={code} type="button" onClick={() => setLang(code)}
                    className={`px-2 py-0.5 rounded-full transition-colors ${
                      lang === code ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
                    style={{ border: '1px solid var(--cline)' }}>
              {code}
            </button>
          ))}
          {doc.languages.length === 0 && <span className="text-vermilion">set languages first</span>}
        </div>
        <button type="button" onClick={() => requestSeed(true)} disabled={seeding}
                className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream disabled:opacity-40"
                style={{ border: '1px solid var(--cline)' }}
                title="Discard breaks and auto-suggest a fresh pagination for this edition">
          <RefreshCw size={12} className={seeding ? 'animate-spin' : ''} /> re-flow
        </button>
        <a href={`${API_BASE}/documents/${documentId}/pdf?lang=${lang}`}
           className="px-2 py-1 rounded-md flex items-center gap-1 text-jade hover:bg-cream"
           style={{ border: '1px solid var(--cline)' }}
           title={`Export the ${lang.toUpperCase()} edition as a print-ready PDF`}>
          <FileDown size={12} /> PDF
        </a>
        <div className="flex-1" />
        <span className="text-ink-soft flex items-center gap-1">
          {(loading || seeding) && <RefreshCw size={12} className="animate-spin" />}
          {spreads.length} spread{spreads.length === 1 ? '' : 's'} · {lines.length} lines
        </span>
      </div>

      {/* Pages — front-matter furniture, then the virtualized body spreads, then
          back-matter furniture. Each body spread is a fixed page height. */}
      <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
           className="flex-1 overflow-auto" style={{ background: 'var(--cream)' }}>
        {frontMatter.length > 0 && (
          <div className="flex flex-col items-center gap-6 pt-6">{frontMatter.map(renderFurniture)}</div>
        )}
        <div style={{ height: bodyUnits.length * spreadHpx, position: 'relative', marginTop: 24 }}>
          {bodyUnits.slice(vFirst, vLast).map((u, k) => {
            const si = vFirst + k;
            return (
              <div key={si} style={{ position: 'absolute', top: si * spreadHpx + 24, left: 0, right: 0,
                                     display: 'flex', justifyContent: 'center' }}>
                {u.kind === 'title' ? (
                  <InternalTitlePage titleLines={u.titleLines} />
                ) : (
                  <div className="booklet-spread">
                    <div className="booklet-page verso">
                      <div className="booklet-content">{renderPageLines(u.s, Verso)}</div>
                    </div>
                    <div className="booklet-page recto">
                      <div className="booklet-content">{renderPageLines(u.s, Recto)}</div>
                      <div className="booklet-folio">{si + 1}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {backMatter.length > 0 && (
          <div className="flex flex-col items-center gap-6 pb-6">{backMatter.map(renderFurniture)}</div>
        )}
        {!loading && !seeding && lines.length === 0 && frontMatter.length === 0 && backMatter.length === 0 && (
          <div className="text-ink-soft text-sm py-10 text-center">
            No pages — add text pages (and furniture) in the Documents tab.
          </div>
        )}
      </div>

      {/* Measurement container — mounted only during a seed/re-flow pass. */}
      {seeding && (
        <div ref={measureRef} className="booklet-measure" style={{ width: `${contentWmm}mm` }} aria-hidden>
          <div>{lines.map((l, i) => <div data-verso key={i}><Verso l={l} adj={adjFor(l, false)} /></div>)}</div>
          <div>{lines.map((l, i) => <div data-recto key={i}><Recto l={l} adj={adjFor(l, false)} /></div>)}</div>
        </div>
      )}
    </div>
  );
};
