import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Scissors } from 'lucide-react';
import {
  getDocument, getDocumentLayout, putLayoutRow, deleteLayoutRow,
  type DocumentDetail, type LayoutConfig, type DocumentLayoutRow,
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

const Verso: React.FC<{ l: DocLine }> = ({ l }) => (
  <div className={`bk-line bk-role-${l.role}`}>
    <div className="bk-tibetan">{l.tokens.map((t, i) => <span key={i}>{t.render}</span>)}</div>
    {l.emptyAfter && <div className="bk-gap" />}
  </div>
);

const Recto: React.FC<{ l: DocLine }> = ({ l }) => (
  <div className={`bk-line bk-role-${l.role}`}>
    {l.phonetics && <div className="bk-phonetics">{l.phonetics}</div>}
    {l.translation != null && (
      <div className="bk-translation"
           dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(l.translation) }} />
    )}
    {l.emptyAfter && <div className="bk-gap" />}
  </div>
);

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
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [d, lay] = await Promise.all([getDocument(documentId), getDocumentLayout(documentId)]);
      if (!alive) return;
      setDoc(d);
      setConfig(lay.config);
      setRows(lay.rows);
      const edition = d.languages.includes(lang) ? lang : (d.languages[0] ?? 'en');
      setLang(edition);
      setLines(await compileDocument(d.items, edition));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [documentId]);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    (async () => {
      const compiled = await compileDocument(doc.items, lang);
      if (alive) setLines(compiled);
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

  /** Measure the DOM and return suggested break line-indices (fill each page). */
  const measureBreaks = (): number[] => {
    if (!measureRef.current || !config) return [];
    const hV = Array.from(measureRef.current.querySelectorAll<HTMLElement>('[data-verso]'), (e) => e.offsetHeight);
    const hR = Array.from(measureRef.current.querySelectorAll<HTMLElement>('[data-recto]'), (e) => e.offsetHeight);
    const out: number[] = [];
    let start = 0, accV = 0, accR = 0;
    for (let i = 0; i < lines.length; i++) {
      const nv = accV + (hV[i] || 0), nr = accR + (hR[i] || 0);
      if (i > start && (nv > contentHpx || nr > contentHpx)) {
        out.push(i); start = i; accV = hV[i] || 0; accR = hR[i] || 0;
      } else { accV = nv; accR = nr; }
    }
    return out;
  };

  const seedBreaks = async (replace = false) => {
    if (!lines.length || seeding) return;
    setSeeding(true);
    try {
      if (replace) {
        await Promise.all(rows.filter((r) => r.kind === 'page_break').map((r) =>
          deleteLayoutRow(documentId, { item_id: r.item_id, anchor_syl_id: r.anchor_syl_id, kind: 'page_break' })));
      }
      const idxs = measureBreaks();
      await Promise.all(idxs.map((i) => putLayoutRow(documentId, {
        item_id: lines[i].itemId, anchor_syl_id: lines[i].startSylId, kind: 'page_break',
      })));
      const lay = await getDocumentLayout(documentId);
      setRows(lay.rows);
    } finally {
      setSeeding(false);
    }
  };

  // Seed an initial pagination the first time a document is opened with no breaks yet.
  useLayoutEffect(() => {
    if (!config || !lines.length || hasStoredBreaks || seeding) return;
    void seedBreaks(false);
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

  const vars = useMemo(() => (config ? rootVars(config) : {}), [config]);

  if (!doc || !config) {
    return <div className="flex-1 flex items-center justify-center text-ink-soft">Loading booklet…</div>;
  }

  const renderPageLines = (s: { start: number; end: number }, Comp: React.FC<{ l: DocLine }>) =>
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
          <Comp l={l} />
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
        <button type="button" onClick={() => void seedBreaks(true)} disabled={seeding}
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

      <div className="flex-1 overflow-auto py-6" style={{ background: 'var(--cream)' }}>
        <div className="flex flex-col items-center gap-6">
          {spreads.map((s, si) => (
            <div className="booklet-spread" key={si}>
              <div className="booklet-page verso">
                <div className="booklet-content">{renderPageLines(s, Verso)}</div>
              </div>
              <div className="booklet-page recto">
                <div className="booklet-content">{renderPageLines(s, Recto)}</div>
                <div className="booklet-folio">{si + 1}</div>
              </div>
            </div>
          ))}
          {!loading && !seeding && lines.length === 0 && (
            <div className="text-ink-soft text-sm py-10">
              No text pages with content — add text pages and translations first.
            </div>
          )}
        </div>
      </div>

      <div ref={measureRef} className="booklet-measure" style={{ width: `${contentWmm}mm` }} aria-hidden>
        <div>{lines.map((l, i) => <div data-verso key={i}><Verso l={l} /></div>)}</div>
        <div>{lines.map((l, i) => <div data-recto key={i}><Recto l={l} /></div>)}</div>
      </div>
    </div>
  );
};
