import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Scissors } from 'lucide-react';
import {
  getDocument, getDocumentLayout, putLayoutRow, deleteLayoutRow, getFurniture,
  type DocumentDetail, type DocumentItem, type LayoutConfig, type DocumentLayoutRow,
  type DocumentFurnitureRow,
} from '../../api/client';
import { compileDocument, type DocLine } from './compile';
import { sanitizeTranslationHtml } from '../translate/sanitize';
import '../../styles/booklet.css';

const MM_PX = 96 / 25.4;

function rootVars(c: LayoutConfig): React.CSSProperties {
  return {
    ['--page-w' as any]: `${c.page_width_mm}mm`,
    ['--page-h' as any]: `${c.page_height_mm}mm`,
    ['--m-top' as any]: `${c.margin_top_mm}mm`,
    ['--m-bottom' as any]: `${c.margin_bottom_mm}mm`,
    ['--m-bind' as any]: `${c.margin_bind_mm}mm`,
    ['--m-outer' as any]: `${c.margin_outer_mm}mm`,
    ['--tibetan-pt' as any]: `${c.tibetan_pt}pt`,
    ['--phonetics-pt' as any]: `${c.phonetics_pt}pt`,
    ['--translation-pt' as any]: `${c.translation_pt}pt`,
    ['--leading' as any]: `${c.leading}`,
  };
}

/** Balancing state applied to one line, plus (interactive only) the handlers. */
interface LineAdj {
  gapDeltaMm: number;   // empty-line spacing delta
  noSpace: boolean;     // blank line removed
  wrapMm: number;       // rightward wrap-limit push for the translation
  onGap?: (delta: number) => void;
  onToggleNoSpace?: () => void;
  onWrap?: (delta: number) => void;
}
const NO_ADJ: LineAdj = { gapDeltaMm: 0, noSpace: false, wrapMm: 0 };

/** The empty-line gap between chunks — the primary balancing lever. */
const Gap: React.FC<{ adj: LineAdj }> = ({ adj }) => {
  if (adj.noSpace) {
    return adj.onToggleNoSpace ? (
      <div className="bk-gap-removed">
        <button type="button" className="bk-gapctl" title="Restore blank line"
                onClick={adj.onToggleNoSpace}>+ line</button>
      </div>
    ) : null;
  }
  return (
    <div className="bk-gap" style={{ height: `calc(var(--translation-pt) * var(--leading) + ${adj.gapDeltaMm}mm)` }}>
      {adj.onGap && (
        <span className="bk-gapctl-group">
          <button type="button" className="bk-gapctl" title="Less space" onClick={() => adj.onGap!(-1)}>−</button>
          <button type="button" className="bk-gapctl" title="More space" onClick={() => adj.onGap!(1)}>+</button>
          <button type="button" className="bk-gapctl" title="Remove blank line" onClick={adj.onToggleNoSpace}>×</button>
        </span>
      )}
    </div>
  );
};

const Verso: React.FC<{ l: DocLine; adj?: LineAdj }> = ({ l, adj = NO_ADJ }) => (
  <div className={`bk-line bk-role-${l.role}`}>
    <div className="bk-tibetan">{l.tokens.map((t, i) => <span key={i}>{t.render}</span>)}</div>
    {l.emptyAfter && <Gap adj={adj} />}
  </div>
);

/* The recto unit, by role:
 *  - section (title/sapche): the translated heading only (Libertinus, large);
 *  - mantra: the romanised mantra only (the phonetics), standalone bold-italic;
 *  - verse/prose/small: an INTERLINEAR PAIR — phonetics then its indented translation,
 *    kept together (the whole `.bk-line` has break-inside: avoid). */
const Recto: React.FC<{ l: DocLine; adj?: LineAdj }> = ({ l, adj = NO_ADJ }) => {
  const isSection = l.role === 'title' || l.role === 'sapche';
  const isMantra = l.role === 'mantra';
  return (
    <div className={`bk-line bk-pair bk-role-${l.role}`}>
      {isSection ? (
        l.translation != null && (
          <div className="bk-section" dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
        )
      ) : (
        <>
          {l.phonetics && <div className="bk-phonetics">{l.phonetics}</div>}
          {!isMantra && l.translation != null && (
            <div className="bk-translation" style={adj.wrapMm ? { marginRight: `-${adj.wrapMm}mm` } : undefined}>
              <span dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
              {adj.onWrap && (
                <span className="bk-wrapctl">
                  <button type="button" title="Narrower" onClick={() => adj.onWrap!(-1)}>−</button>
                  <button type="button" title="Wider (into the outer margin)" onClick={() => adj.onWrap!(1)}>+</button>
                </span>
              )}
            </div>
          )}
        </>
      )}
      {l.emptyAfter && <Gap adj={adj} />}
    </div>
  );
};

interface TocRow { title: string; page: number }

/** A single furniture page (cover/title, copyright, toc, blank/backcover, image). */
const FurniturePage: React.FC<{
  item: DocumentItem; titleLines: DocLine[]; body: string | null; toc: TocRow[];
}> = ({ item, titleLines, body, toc }) => {
  let content: React.ReactNode = null;
  if (item.kind === 'cover') {
    // The translated title's parts: the first is the main title, the rest the subtitle.
    const trans = titleLines.map((t) => t.translation).filter((x): x is string => !!x);
    content = (
      <div className="bk-titlepage">
        <div className="bk-seal">ༀ</div>
        {titleLines.map((t, i) => (
          <div key={i} className="bk-tibetan bk-title-tib">
            {t.tokens.map((tk, k) => <span key={k}>{tk.render}</span>)}
          </div>
        ))}
        {trans[0] && (
          <div className="bk-title-main"
               dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(trans[0]) }} />
        )}
        {trans.slice(1).map((p, i) => (
          <div key={`sub${i}`} className="bk-title-sub"
               dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(p) }} />
        ))}
      </div>
    );
  } else if (item.kind === 'copyright') {
    content = body
      ? <div className="bk-copyright" dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(body) }} />
      : <div className="bk-copyright bk-placeholder">Copyright text — add it in the Documents tab.</div>;
  } else if (item.kind === 'toc') {
    content = (
      <div className="bk-toc">
        {toc.length === 0 && <div className="bk-placeholder">No sections yet.</div>}
        {toc.map((e, i) => (
          <div key={i} className="bk-toc-entry">
            <span className="bk-toc-title">{e.title}</span>
            <span className="bk-toc-dots" />
            <span className="bk-toc-page">{e.page}</span>
          </div>
        ))}
      </div>
    );
  } else if (item.kind === 'image_page') {
    content = <div className="bk-placeholder">Image page</div>;
  }
  return (
    <div className="booklet-spread">
      <div className="booklet-page furniture">
        <div className="booklet-content">{content}</div>
      </div>
    </div>
  );
};

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

  // Stored break line-indices (shared across editions) → spread spans.
  const breakSet = useMemo(() => {
    const idx = new Set<number>();
    for (const r of rows) {
      if (r.kind !== 'page_break') continue;
      const i = lines.findIndex((l) => l.itemId === r.item_id && l.startSylId === r.anchor_syl_id);
      if (i > 0) idx.add(i);
    }
    return idx;
  }, [rows, lines]);

  const spreads = useMemo(() => {
    if (!lines.length) return [] as { start: number; end: number }[];
    const starts = [0, ...Array.from(breakSet).sort((a, b) => a - b)];
    return starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : lines.length }));
  }, [breakSet, lines.length]);

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
    } else {
      await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: l.startSylId, kind: 'page_break' });
    }
    const lay = await getDocumentLayout(documentId);
    setRows(lay.rows);
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

  // Fixed-height virtualization: each spread is one page tall (+ a 24px gutter).
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
  const vLast = Math.min(spreads.length, Math.ceil((scrollTop + viewH) / spreadHpx) + 1);

  // ── Furniture pages (front/back matter) + auto-TOC with page numbers ──
  const textItems = (doc?.items ?? []).filter((it) => it.kind === 'text' && it.text_id != null);
  const firstTextPos = textItems.length ? Math.min(...textItems.map((i) => i.position)) : Infinity;
  const lastTextPos = textItems.length ? Math.max(...textItems.map((i) => i.position)) : -Infinity;
  const frontMatter = (doc?.items ?? [])
    .filter((it) => it.kind !== 'text' && it.position < firstTextPos)
    .sort((a, b) => a.position - b.position);
  const backMatter = (doc?.items ?? [])
    .filter((it) => it.kind !== 'text' && it.position > lastTextPos)
    .sort((a, b) => a.position - b.position);

  const itemStartLine = useMemo(() => {
    const m = new Map<number, number>();
    lines.forEach((l, i) => { if (!m.has(l.itemId)) m.set(l.itemId, i); });
    return m;
  }, [lines]);
  const folioOfLine = (idx: number) => {
    for (let s = 0; s < spreads.length; s++) if (spreads[s].start <= idx && idx < spreads[s].end) return s + 1;
    return 1;
  };
  const stripHtml = (h: string) => h.replace(/<[^>]+>/g, '').trim();
  const tocRows: TocRow[] = textItems.map((it) => {
    const tl = titleByItem.get(it.id) ?? [];
    const title = tl[0]?.translation ? stripHtml(sanitizeTranslationHtml(tl[0].translation)) : (it.text_title || '');
    const startLine = itemStartLine.get(it.id);
    return { title, page: startLine != null ? folioOfLine(startLine) : 1 };
  });
  const mainTitleLines = firstTextPos !== Infinity
    ? (titleByItem.get(textItems.find((i) => i.position === firstTextPos)!.id) ?? []) : [];
  const furnitureBody = (item: DocumentItem) =>
    furniture.find((f) => f.item_id === item.id && f.lang === lang)?.body ?? null;

  const renderFurniture = (item: DocumentItem) => (
    <FurniturePage key={`f${item.id}`} item={item}
      titleLines={item.kind === 'cover' ? mainTitleLines : []}
      body={furnitureBody(item)} toc={item.kind === 'toc' ? tocRows : []} />
  );

  if (!doc || !config) {
    return <div className="flex-1 flex items-center justify-center text-ink-soft">Loading booklet…</div>;
  }

  const renderPageLines = (s: { start: number; end: number }, Comp: React.FC<{ l: DocLine; adj?: LineAdj }>) =>
    lines.slice(s.start, s.end).map((l, k) => {
      const globalIdx = s.start + k;
      return (
        <div key={l.key} className="bk-linewrap" style={{ position: 'relative' }}>
          {/* A boundary control between this line and the previous — click to break. */}
          {k > 0 && (
            <button
              type="button"
              onClick={() => void toggleBreak(globalIdx)}
              className="bk-breakctl"
              title={breakSet.has(globalIdx) ? 'Lift page break' : 'Break page here'}
            >
              <Scissors size={9} />
            </button>
          )}
          <Comp l={l} adj={adjFor(l, true)} />
        </div>
      );
    });

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
        <div style={{ height: spreads.length * spreadHpx, position: 'relative', marginTop: 24 }}>
          {spreads.slice(vFirst, vLast).map((s, k) => {
            const si = vFirst + k;
            return (
              <div key={si} style={{ position: 'absolute', top: si * spreadHpx + 24, left: 0, right: 0,
                                     display: 'flex', justifyContent: 'center' }}>
                <div className="booklet-spread">
                  <div className="booklet-page verso">
                    <div className="booklet-content">{renderPageLines(s, Verso)}</div>
                  </div>
                  <div className="booklet-page recto">
                    <div className="booklet-content">{renderPageLines(s, Recto)}</div>
                    <div className="booklet-folio">{si + 1}</div>
                  </div>
                </div>
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
