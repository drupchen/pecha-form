import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Scissors, Minus, FileDown, Type, Frame } from 'lucide-react';
import {
  API_BASE, getDocument, getDocumentLayout, putLayoutRow, deleteLayoutRow, getFurniture,
  getOrgSeal, putPaginationStamp, putLayoutConfig,
  type DocumentDetail, type DocumentItem, type LayoutConfig, type DocumentLayoutRow,
  type DocumentFurnitureRow, type OrgSeal, type DocumentLayoutKind,
} from '../../api/client';
import { compileDocument, type DocLine, type OutlineHeading } from './compile';
import {
  MM_PX, rootVars, Verso, Recto, FurniturePage, InternalTitlePage,
  deriveBooklet, furnitureBodyOf, isSplittable, pageVars, gapFillLang, GAP_FILL_KIND,
  PAGE_SHIFT_KIND, anchorOf, splitAnchorOf, TIBETAN_LANG, versoGapSuppressed,
  BREAK_AUTO, BREAK_MANUAL, isManualBreak,
  type LineAdj, type WidthTarget, type WidthRange, type BlockWidthOf, type PageSide,
} from './bookletRender';
import {
  awaitBookletFonts, readStream, readHairlineAdvance, flowPages,
  hash, streamSignature, toSigLines, dirtySyllables, type SigLine,
} from './bookletMeasure';
import { loadBookletStyleCss } from './bookletStyles';
import { StyleStudio } from './StyleStudio';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTranslationStore } from '../../store/useTranslationStore';
import '../../styles/booklet.css';

/** One edition's compiled stream, awaiting measurement. Every edition indexes the same
 *  line for line (the stream is cut by the Tibetan, not by the translation), which is what
 *  lets a single shared break set be flowed against all of them. */
interface EditionStream { lang: string; lines: DocLine[] }

/** Seconds of quiet before the pagination re-flows itself. The clock RESTARTS on every
 *  upstream change, so the pages never move while you are still working — they settle once
 *  you stop. Per document, in `layout_config`. */
const DEFAULT_REFLOW_DELAY_S = 20;

/**
 * Bump when a RENDERER change moves line geometry without moving `styleCss` or
 * `layout_config`.
 *
 * The two drift detectors watch the document: the signature watches its content, the
 * fingerprint watches its styles and geometry. Neither watches the CODE — so a change to how
 * a line is drawn leaves every booklet holding a pagination measured against type that is no
 * longer what prints, and says nothing. This is the fingerprint's way of saying "the renderer
 * moved, so every line may have": one integer, routed to the same immediate re-flow a font
 * change takes, which is exactly the right path — a renderer change moves all of them at once,
 * so counting changed syllables would say nothing useful about it.
 *
 * 2: small runs began printing at their own size inside a body line (a character style), which
 *    re-wraps every line that holds one.
 * 3: consecutive ས་བཅད topics began sharing a line on the verso, which shortens every Tibetan
 *    page that has a pair.
 * 4: a ས་བཅད topic stopped carrying a blank line into the text it heads.
 * 5: the flow stopped ending a page on a heading (`noTail`) — not a geometry change but a
 *    pagination-law change, which stored breaks equally cannot know about.
 */
const RENDER_EPOCH = 5;

/**
 * One page's "fill it out" control: every empty line on THIS page grows by the same mm.
 *
 * It exists because the breaks are SHARED — the tallest edition decides where a page ends,
 * so every other page is left with slack at the foot through no fault of its own.
 *
 * One per PAGE, not per spread: the Tibetan verso is far denser than the translation across
 * from it and wants far more air, so a single control would force one of the two to be
 * wrong. The verso's setting is shared by every edition (same Tibetan in each booklet); the
 * recto's belongs to its edition.
 *
 * `max` is the slack actually measured on that page right now, divided among its gaps, so
 * the slider cannot be dragged into an overflow. That is an affordance, not a guarantee: the
 * stored value is plain mm, and if a later re-flow puts more on the page, the mm stay and the
 * overfull badge is what says so. A ratio-of-slack would self-correct, but only by measuring
 * the page again at PRINT time too — and a PDF that silently re-measures is a worse bargain
 * than a number that means exactly what it says.
 */
const GapFillSlider: React.FC<{
  side: PageSide; value: number; max: number; onChange: (mm: number) => void;
}> = ({ side, value, max, onChange }) => {
  const cap = Math.max(0, Math.round(max * 10) / 10);
  if (cap <= 0.5 && !value) return null;   // a full page has nothing to spend
  const scope = side === 'verso'
    ? 'The Tibetan page only — every edition prints the same one, so this is set once.'
    : 'This edition’s translation page only.';
  return (
    <div className={`bk-gapfill bk-gapfill-${side}`} title={
      `Open out every empty line on this ${side === 'verso' ? 'Tibetan' : 'translation'} page `
      + `by the same amount, to use up the space the shared page break left here. Up to `
      + `${cap.toFixed(1)}mm each before this page overflows. ${scope}`}>
      <input type="range" min={0} max={Math.max(cap, value)} step={0.1} value={value}
             onChange={(e) => onChange(Number(e.target.value))} />
      <span>{value ? `+${value.toFixed(1)}mm` : (side === 'verso' ? 'fill བོད' : 'fill')}</span>
    </div>
  );
};

/** What one mounted page has left, in mm: how much more each empty line could open before
 *  the ink leaves the text BLOCK, and how far the page could move before it leaves the
 *  SHEET, either way. */
interface PageRoom { gap: number; up: number; down: number }

/** Round to the slider's step. Both ends of a SIGNED range have to sit on the step ladder or
 *  0 is unreachable: `step` counts from `min`, and `min` here is a measured quotient. The gap
 *  fill never met this — its `min` is a literal 0. */
const round1 = (mm: number) => Math.round(mm * 10) / 10;

/**
 * The page's vertical shift: move the whole block down or up.
 *
 * What is left when the gap fill has run out. Opening the empty lines spends a page's slack
 * first, but only to the limit of decent spacing — past that the block itself has to travel,
 * and it may take ink between the text block's foot and the sheet's edge. That is the point:
 * the guide is a guide, the sheet is the limit, and the page's clip enforces it.
 *
 * The stops are where the ink would leave the SHEET, measured off the page as it stands.
 * Independent of the gap fill's stop, which is shift-invariant, so the two can be traded back
 * and forth without either re-scaling under the other.
 */
const PageShiftSlider: React.FC<{
  side: PageSide; value: number; room: PageRoom; onChange: (mm: number) => void;
}> = ({ side, value, room, onChange }) => {
  const min = Math.min(round1(value - room.up), value);
  const max = Math.max(round1(value + room.down), value);
  if (min >= -0.05 && max <= 0.05) return null;         // nowhere to go
  const label = value > 0.05 ? `↓${value.toFixed(1)}mm`
              : value < -0.05 ? `↑${(-value).toFixed(1)}mm` : 'shift';
  return (
    <div className={`bk-pageshift bk-pageshift-${side}`} title={
      `Move this ${side === 'verso' ? 'Tibetan' : 'translation'} page's whole content down or `
      + `up, when opening the empty lines is not enough. It may take the type past the bottom `
      + `guide — down to the edge of the sheet, which is where it stops. Double-click to put `
      + `it back. ${side === 'verso'
          ? 'The Tibetan page only — every edition prints the same one, so this is set once.'
          : 'This edition’s translation page only.'}`}>
      <input type="range" min={min} max={max} step={0.1} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             onDoubleClick={() => onChange(0)} />
      <span>{label}</span>
    </div>
  );
};

/** How far this page has been moved off its guide — a band from the text block's top to where
 *  the content now starts. Honest only because `.bk-atpagetop` zeroes the top margin of
 *  whatever opens a page, so at rest the content sits exactly ON the guide and there is no
 *  collapsed margin to correct for. */
const ShiftMark: React.FC<{ mm: number }> = ({ mm }) => {
  if (Math.abs(mm) < 0.05) return null;
  return (
    <div className="bk-shiftmark" data-dir={mm < 0 ? 'up' : 'down'}
         style={{ top: `calc(var(--m-top) + ${Math.min(mm, 0).toFixed(2)}mm)`,
                  height: `${Math.abs(mm).toFixed(2)}mm` }}>
      <span>{mm > 0 ? `↓${mm.toFixed(1)}` : `↑${(-mm).toFixed(1)}`}mm</span>
    </div>
  );
};

/** The stored stamp is `{lang: signature}`. Anything else — a stamp from before it was kept
 *  per edition, or junk — reads as "no stamp", which simply means nothing is disturbed. */
function parseSigStamp(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      if (typeof s === 'string') out[k] = s;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

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
  // Which edition `lines` was compiled for. Switching editions flips `lang` at once but the
  // recompile is async, so for a moment the stream on hand is the PREVIOUS edition's —
  // long enough for the drift counter to compare `en`'s stream against `de`'s signature and
  // conclude the whole booklet had been rewritten.
  const [linesLang, setLinesLang] = useState<string | null>(null);
  const [titleByItem, setTitleByItem] = useState<Map<number, DocLine[]>>(new Map());
  const [headingsByItem, setHeadingsByItem] = useState<Map<number, OutlineHeading[]>>(new Map());
  // The navigation + section headings come from the TRANSLATION pane (labels, levels, title
  // chunks); the sapche tree still supplies inherited nesting depth. Watch both so curating
  // either in another tab re-compiles the booklet without a reload.
  const treeVersion = useTreeNodeStore(s => s.version);
  const trVersion = useTranslationStore(s => s.version);
  const [furniture, setFurniture] = useState<DocumentFurnitureRow[]>([]);
  const [styleCss, setStyleCss] = useState('');
  // The org's cover seal travels with the styles: it is part of the template, and the studio
  // can change it, so it is re-read whenever the styles are.
  const [orgSeal, setOrgSeal] = useState<OrgSeal | null>(null);
  const [showStyles, setShowStyles] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  // Geometry guides (text block, spine side, folio zone) — a design aid; never exported.
  const [guides, setGuides] = useState(true);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  // A seed that refused to run has to say so — silence would read as "the pagination is
  // fine", which is the failure this whole pass exists to end.
  const [msg, setMsg] = useState('');
  // The compiled editions awaiting measurement. Non-null = the measure DOM is mounted and
  // the effect below may read it.
  const [measure, setMeasure] = useState<EditionStream[] | null>(null);
  // What the stored breaks were flowed against: one stream signature per EDITION, and one
  // style/geometry fingerprint. Both empty until a flow records them.
  const [stamp, setStamp] = useState<{ sig: Record<string, string> | null; fp: string | null }>(
    { sig: null, fp: null });
  // Seconds of quiet before the pagination re-flows itself. The user's dial: short settles
  // sooner, long leaves more room to keep working.
  const [delayS, setDelayS] = useState(DEFAULT_REFLOW_DELAY_S);
  // Seconds left in the current quiet period; null = nothing has drifted, nothing pending.
  const [countdown, setCountdown] = useState<number | null>(null);
  const reloadStyles = () => {
    void loadBookletStyleCss(documentId).then(setStyleCss);
    void getOrgSeal().then(setOrgSeal).catch(() => {});
  };
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [d, lay, furn, css, seal] = await Promise.all([
        getDocument(documentId), getDocumentLayout(documentId), getFurniture(documentId),
        loadBookletStyleCss(documentId), getOrgSeal().catch(() => null)]);
      if (!alive) return;
      setDoc(d);
      setConfig(lay.config);
      setRows(lay.rows);
      setStamp({ sig: parseSigStamp(lay.pagination_sig), fp: lay.pagination_fp });
      // The delay rides in layout_config — it is per-document user config, which is exactly
      // what that JSON already is, so it needs no column of its own.
      setDelayS(lay.config.reflow_delay_s > 0
        ? Math.round(lay.config.reflow_delay_s) : DEFAULT_REFLOW_DELAY_S);
      setFurniture(furn);
      setStyleCss(css);
      setOrgSeal(seal);
      const edition = d.languages.includes(lang) ? lang : (d.languages[0] ?? 'en');
      setLang(edition);
      const compiled = await compileDocument(d.items, edition);
      setLines(compiled.lines);
      setLinesLang(edition);
      setTitleByItem(compiled.titleByItem);
      setHeadingsByItem(compiled.headingsByItem);
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
      setLinesLang(lang);
      setTitleByItem(compiled.titleByItem);
      setHeadingsByItem(compiled.headingsByItem);
    })();
    return () => { alive = false; };
  }, [lang, treeVersion, trVersion]);

  const contentWmm = config ? config.page_width_mm - config.margin_bind_mm - config.margin_outer_mm : 0;
  const contentHpx = config
    ? (config.page_height_mm - config.margin_top_mm - config.margin_bottom_mm) * MM_PX : 0;

  // Page structure (breaks, spreads, body page-units, front/back matter, TOC) —
  // computed by the SHARED `deriveBooklet` so the bench and the print/PDF page lay out
  // identically. The bench layers interactive break/balancing controls on top.
  const { lines: renderLines, breakSet, hairlineSet, forcedStarts, manualBreaks,
          spreads, bodyUnits, frontMatter, backMatter, tocRows, mainTitleLines } = useMemo(
    () => deriveBooklet(doc?.items ?? [], rows, lines, titleByItem, furniture, lang, splitMode,
                        headingsByItem),
    [doc, rows, lines, titleByItem, headingsByItem, furniture, lang, splitMode],
  );

  const hasStoredBreaks = rows.some((r) => r.kind === 'page_break');

  // ── Staleness: how far the booklet has drifted from the pagination it carries ──
  // The stream's signature and the style/geometry fingerprint are what the breaks were
  // flowed against. Editing a translation moves a few lines; changing a font moves all of
  // them. Those are different questions, so they are asked separately.
  const sigLines: SigLine[] = useMemo(() => toSigLines(renderLines), [renderLines]);
  // Only what actually LAYS THE PAGE OUT belongs in the fingerprint. `layout_config` is also
  // where per-document preferences live, and `reflow_delay_s` is one of them — leaving it in
  // meant that nudging the re-flow delay counted as a change to the booklet and started the
  // very re-flow you were trying to postpone.
  const styleFp = useMemo(() => {
    const c = (config ?? {}) as unknown as Record<string, unknown>;
    const layout = Object.keys(c).filter((k) => k !== 'reflow_delay_s').sort()
      .map((k) => `${k}=${c[k]}`).join(' ');
    return hash(`${RENDER_EPOCH} ${styleCss} ${layout}`);
  }, [styleCss, config]);
  // Per EDITION, and it has to be: the stream carries each edition's own translation, so
  // `en`'s signature and `de`'s differ completely. One shared signature would read "the whole
  // booklet changed" the moment you clicked another edition chip, and re-flow the lot for
  // nothing. Only the edition on screen is compiled, so only its drift is measurable; an
  // edition with no stored signature — one added since the flow — counts as no drift, and the
  // overfull badge is what speaks for it instead.
  // Only ask once the stream in hand is actually this edition's — see `linesLang`.
  const streamReady = linesLang === lang;
  const dirty = useMemo(
    () => (streamReady ? dirtySyllables(stamp.sig?.[lang] ?? null, sigLines) : 0),
    [streamReady, stamp.sig, lang, sigLines]);
  // A style or geometry change moves EVERY line at once, so counting syllables says nothing
  // useful about it — re-flow straight away rather than sit at "0 of 50".
  const styleStale = !!stamp.fp && stamp.fp !== styleFp;
  const drifted = styleStale || dirty > 0;

  // Auto-suggest pagination: the heavy full-stream measure container is mounted ONLY
  // while `measuring`, measured once, then unmounted (keeps the steady-state DOM light).
  const pendingReplace = useRef(false);
  /**
   * Ask for a re-flow. The breaks are SHARED by every edition — that is what makes the four
   * page-align — so they have to be measured against ALL of them, not just the one on
   * screen: a German recto runs longer than an English one, and breaks seeded from `en`
   * alone overfill `de`. Compile each edition first; the effect below then measures them
   * together and breaks where the TALLEST demands.
   */
  const requestSeed = async (replace: boolean) => {
    if (!lines.length || seeding || !doc) return;
    pendingReplace.current = replace;
    setMsg('');
    setSeeding(true);
    try {
      const data: EditionStream[] = [];
      for (const lg of doc.languages) {
        const c = await compileDocument(doc.items, lg);
        // Through deriveBooklet, so each edition's stream carries the same mid-line splits
        // and therefore indexes identically to the one on screen.
        const d = deriveBooklet(doc.items, rows, c.lines, c.titleByItem, furniture, lg,
                                false, c.headingsByItem);
        data.push({ lang: lg, lines: d.lines });
      }
      const odd = data.filter((d) => d.lines.length !== renderLines.length).map((d) => d.lang);
      if (odd.length) {
        // The editions are supposed to share the stream line for line; if one does not, its
        // heights cannot be compared index by index, so say so rather than quietly drop it.
        setMsg(`Editions out of step with ${lang}: ${odd.join(', ')} — flowed without them.`);
      }
      setMeasure(data.filter((d) => d.lines.length === renderLines.length));
    } catch (e) {
      setMsg(`Could not compile the editions: ${(e as Error).message}`.slice(0, 160));
      setSeeding(false);
    }
  };

  /**
   * Seed the pagination: measure the mounted stream, flow it, write the auto breaks.
   *
   * A plain effect, not a LAYOUT effect, because the first thing this has to do is WAIT. The
   * measure DOM has only just mounted and the booklet's faces are big and `font-display:
   * swap` (Chogyal 627KB, Jomolhari 2.2MB), so reading heights straight away reads Tibetan
   * laid out in the serif fallback: every verso line measures far too tall, the budget blows
   * on line after line, and the seeder writes a break every line or two. That is what left
   * pages 80% empty — and it bit hardest on a document's FIRST open, which is precisely when
   * the auto-seed below fires and the font cache is coldest.
   */
  useEffect(() => {
    if (!measure || !measureRef.current || !config) return;
    const el = measureRef.current;
    let alive = true;
    (async () => {
      try {
        if (!(await awaitBookletFonts(el, config.tibetan_pt))) {
          // Measuring now would write garbage into state every edition shares. A skipped
          // seed is recoverable — a corrupt one is not.
          if (alive) setMsg('Pagination not re-flowed: the Tibetan font never loaded.');
          return;
        }
        if (!alive) return;

        // The verso is the Tibetan — identical in every edition, so it is measured once.
        // Each edition's recto is measured on its own; a spread must fit all of them.
        const sides = [
          readStream(el, '[data-side="verso"] .bk-linewrap'),
          ...measure.map((m) => readStream(el, `[data-recto="${m.lang}"] .bk-linewrap`)),
        ];

        // A break is stored as (item, syllable) and read back by looking that pair up in the
        // stream. Two things make a line unable to carry one, and choosing it anyway would
        // paginate the page somewhere other than where it was measured:
        //  - an AMBIGUOUS anchor: transcluded text repeats its source's syllable ids, so the
        //    same pair occurs more than once and the lookup returns the FIRST one — a line
        //    the flow never picked;
        //  - a SPLIT HEAD: the head keeps the line's original `startSylId`, which the split's
        //    own row already owns, so writing a break there would upsert over it and null its
        //    `char_offset`, destroying the split.
        const keys = renderLines.map((l) => `${l.itemId}:${anchorOf(l)}`);
        const firstOf = new Map<string, number>();
        keys.forEach((k, i) => { if (!firstOf.has(k)) firstOf.set(k, i); });
        const unbreakable = new Set<number>();
        renderLines.forEach((l, i) => {
          // The anchor now names the occurrence, so this finds nothing on today's booklets.
          // It stays as the backstop: if a stream ever did repeat an anchor, breaking there
          // would silently paginate a different page than the one measured.
          if (firstOf.get(keys[i]) !== i) unbreakable.add(i);
          // A split head shares the split row's anchor — a break there would upsert over it.
          if (l.splitAnchor != null && anchorOf(l) === l.splitAnchor) unbreakable.add(i);
        });

        // Never end a page with only the sapche/toc run: a heading's job is to announce
        // what follows it, and stranded at a page's foot it announces a page-turn. Same
        // definition as the renderer's `isSection` — title and sapche lines.
        const noTail = new Set<number>();
        renderLines.forEach((l, i) => {
          if (l.role === 'title' || l.role === 'sapche') noTail.add(i);
        });

        const { starts, overfull } = flowPages(sides, {
          n: renderLines.length,
          // The flow fills the runs between the starts it may not touch: text boundaries and
          // split tails (which deriveBooklet forces anyway, so a seeded row there would be
          // redundant), plus the breaks the user placed by hand.
          forced: new Set<number>([...forcedStarts, ...manualBreaks]),
          hairlines: hairlineSet,
          contentHpx,
          hairHpx: readHairlineAdvance(el),
          unbreakable,
          noTail,
        });

        const autoStarts = starts.filter((i) =>
          i > 0 && !forcedStarts.has(i) && !manualBreaks.has(i) && !unbreakable.has(i));

        if (pendingReplace.current) {
          // Delete only what we own. Splits (`char_offset > 0`) and hand-placed breaks are
          // the user's; wiping them was destroying mid-line splits outright and orphaning
          // their `recto_cut` companions with no way back.
          await Promise.all(rows
            .filter((r) => r.kind === 'page_break'
                        && !(r.char_offset != null && r.char_offset > 0)
                        && !isManualBreak(r))
            .map((r) => deleteLayoutRow(documentId,
              { item_id: r.item_id, anchor_syl_id: r.anchor_syl_id, kind: 'page_break' })));
        }
        await Promise.all(autoStarts.map((i) => putLayoutRow(documentId, {
          item_id: renderLines[i].itemId, anchor_syl_id: anchorOf(renderLines[i]),
          kind: 'page_break', value: BREAK_AUTO,   // explicit: legacy rows have NULL here
        })));
        // Record what these breaks fit, so the drift from here is measurable. One signature
        // per edition — every edition was just compiled and measured, so all of them can be
        // stamped, and each is then comparable against itself alone. Written only on the path
        // that actually wrote breaks: a refused or aborted seed must leave the old stamp
        // standing, or the booklet would look freshly paginated when it is not.
        const sig: Record<string, string> = {};
        for (const m of measure) sig[m.lang] = streamSignature(toSigLines(m.lines));
        await putPaginationStamp(documentId, JSON.stringify(sig), styleFp);
        if (!alive) return;
        setStamp({ sig, fp: styleFp });
        setRows((await getDocumentLayout(documentId)).rows);
        // A page the flow could not make fit holds ONE line that is taller than the text
        // block in some edition — it has nowhere else to go, so the flow leaves it and says
        // so rather than pretending. The remedy is the user's: split the line, or narrow it.
        if (overfull.length) {
          setMsg(`${overfull.length} page${overfull.length > 1 ? 's hold' : ' holds'} a single ` +
                 `line too tall for the page in some edition — split it, or narrow it.`);
        }
      } finally {
        if (alive) { setMeasure(null); setSeeding(false); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure]);

  /**
   * Keep the automatic breaks where they belong, without making a nuisance of it.
   *
   * A document with no breaks at all seeds immediately — there is nothing to disturb. After
   * that, drift starts a QUIET PERIOD rather than an immediate re-flow, and the clock
   * restarts on every further change: the pages therefore never move while you are still
   * working, only once you have stopped. That is the whole point of measuring the delay in
   * seconds and not in edits — an edit budget spends itself mid-sentence, under the cursor.
   *
   * The drift itself is still measured by the stream signature and the style fingerprint —
   * that is what NOTICES a change, and what stops the timer running on a booklet nothing has
   * happened to. It just does not decide when.
   *
   * Deliberately NOT started by the balancing (gaps, widths, the gap fill): those are local
   * decisions about a page you are looking at, and re-flowing under them would move the page
   * while you tune it. If one pushes a page past its block, the overfull badge says so —
   * a better answer than repaginating the booklet under the user's hands.
   */
  useEffect(() => {
    // Every path that is NOT counting has to say so. Bailing out silently leaves whatever
    // number was last painted frozen on the chip — which reads as a clock that has stopped,
    // and is exactly as untrustworthy as no clock at all.
    if (!config || !lines.length || seeding || !streamReady) { setCountdown(null); return; }
    if (!hasStoredBreaks) { setCountdown(null); void requestSeed(false); return; }
    if (!stamp.sig) { setCountdown(null); return; }   // never stamped: nothing to compare to
    if (!drifted) { setCountdown(null); return; }
    // This effect re-runs whenever the drift changes — i.e. on every upstream edit — and its
    // cleanup drops the pending clock. So each change restarts the quiet period; idling lets
    // it run down, because an unchanged `dirty` leaves the deps alone.
    setCountdown(delayS);
    const started = performance.now();
    const tick = window.setInterval(() => {
      const left = Math.ceil(delayS - (performance.now() - started) / 1000);
      if (left > 0) { setCountdown(left); return; }
      window.clearInterval(tick);
      setCountdown(null);
      void requestSeed(true);
    }, 250);
    return () => window.clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, lines, streamReady, hasStoredBreaks, drifted, styleStale, dirty, delayS, stamp.sig]);

  /** Toggle a forced page break at line `i` (start of a spread) — click a boundary. */
  const toggleBreak = async (i: number) => {
    if (i <= 0 || i >= renderLines.length) return;
    const l = renderLines[i];
    if (breakSet.has(i)) {
      await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'page_break' });
      // A lifted break drops any hairline marking too.
      if (hairlineSet.has(i))
        await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'hairline' });
    } else {
      // Flagged as the user's: a re-flow keeps it and flows around it, instead of treating
      // it as one of its own suggestions and sweeping it away.
      await putLayoutRow(documentId, {
        item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'page_break', value: BREAK_MANUAL });
    }
    const lay = await getDocumentLayout(documentId);
    setRows(lay.rows);
  };

  /** Toggle a hairline (mid-content) break at line `i`: a page break drawn with a thin
   *  continuation rule. Setting it forces a break there too; clearing it leaves the
   *  break as an ordinary one. */
  const toggleHairline = async (i: number) => {
    if (i <= 0 || i >= renderLines.length) return;
    const l = renderLines[i];
    if (hairlineSet.has(i)) {
      await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'hairline' });
    } else {
      // Also the user's break — and easy to miss, because a hairline writes its page break
      // through this path, not `toggleBreak`. Unflagged, a re-flow would delete the break and
      // strand the hairline row on a boundary that no longer exists, drawing nothing.
      if (!breakSet.has(i))
        await putLayoutRow(documentId, {
          item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'page_break', value: BREAK_MANUAL });
      await putLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'hairline', value: 1 });
    }
    setRows((await getDocumentLayout(documentId)).rows);
  };

  /** Mid-line split: click a verso syllable (token index `k`) to split the line there
   *  (Tibetan cuts on the syllable boundary); `k === -1` clears an existing split. */
  const setSplit = async (l: DocLine, k: number) => {
    const anchor = splitAnchorOf(l);
    if (k === -1) {
      await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchor, kind: 'page_break' });
      // Clearing a split drops its per-language recto cuts too.
      for (const lg of [...(doc?.languages ?? []), ''])
        await deleteLayoutRow(documentId, { item_id: l.itemId, anchor_syl_id: anchor, kind: 'recto_cut', lang: lg });
    } else if (k >= 1) {
      await putLayoutRow(documentId, {
        item_id: l.itemId, anchor_syl_id: anchorOf(l), kind: 'page_break', char_offset: k });
    } else return;
    setRows((await getDocumentLayout(documentId)).rows);
  };

  /** Set this edition's recto cut for a split line (the tail starts at word `w`). */
  const setRectoCut = async (l: DocLine, w: number) => {
    const anchor = splitAnchorOf(l);
    await putLayoutRow(documentId, {
      item_id: l.itemId, anchor_syl_id: anchor, kind: 'recto_cut', char_offset: w, lang });
    setRows((await getDocumentLayout(documentId)).rows);
  };

  // ── Per-line balancing (empty-line spacing, remove) + per-block width ──
  // Rows are keyed by lang too: a block's width is per-EDITION for the translated/romanised
  // recto text (the same syllable's English line is not the German one), but shared for the
  // Tibetan, which every edition renders identically. Gap/no-space stay shared ('').
  const layoutByKey = useMemo(() => {
    const m = new Map<string, DocumentLayoutRow>();
    for (const r of rows) m.set(`${r.item_id}:${r.anchor_syl_id}:${r.kind}:${r.lang ?? ''}`, r);
    return m;
  }, [rows]);
  // Read by the line's anchor, falling back to the bare syllable for rows written before the
  // op was part of it (see `anchorOf`).
  const rowOf = (l: DocLine, kind: string, rowLang: string) =>
    layoutByKey.get(`${l.itemId}:${anchorOf(l)}:${kind}:${rowLang}`)
    ?? layoutByKey.get(`${l.itemId}:${l.startSylId}:${kind}:${rowLang}`);
  const rowVal = (l: DocLine, kind: string, rowLang = '') => rowOf(l, kind, rowLang)?.value ?? null;
  const rowHas = (l: DocLine, kind: string, rowLang = '') => rowOf(l, kind, rowLang) != null;

  const refreshLayout = async () => setRows((await getDocumentLayout(documentId)).rows);
  const putRow = async (l: DocLine, kind: DocumentLayoutKind, value: number, rowLang = '') => {
    await putLayoutRow(documentId,
      { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind, value, lang: rowLang });
    await refreshLayout();
  };
  const delRow = async (l: DocLine, kind: DocumentLayoutKind, rowLang = '') => {
    // Delete BOTH vintages: a value the user is clearing may have been stored under the
    // bare syllable before the anchor named the occurrence.
    await deleteLayoutRow(documentId,
      { item_id: l.itemId, anchor_syl_id: anchorOf(l), kind, lang: rowLang });
    if (anchorOf(l) !== l.startSylId) {
      await deleteLayoutRow(documentId,
        { item_id: l.itemId, anchor_syl_id: l.startSylId, kind, lang: rowLang }).catch(() => {});
    }
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

  // ── Each page's gap fill: spend the slack a shared break left it ──
  // Anchored on the page's first line, and kept per SIDE: the Tibetan verso is far denser
  // than the translation facing it and wants far more air, so one control for the spread
  // would force one of the two to be wrong. The verso's fill is shared across editions (it
  // is the same Tibetan in every booklet); the recto's is the edition's own.
  const gapFillOf = (start: number, side: PageSide) => {
    const l = renderLines[start];
    return l ? (rowVal(l, GAP_FILL_KIND[side], gapFillLang(side, lang)) ?? 0) : 0;
  };
  const setGapFill = (start: number, side: PageSide, mm: number) => {
    const l = renderLines[start];
    if (!l) return;
    const kind = GAP_FILL_KIND[side];
    const rowLang = gapFillLang(side, lang);
    mm <= 0 ? void delRow(l, kind, rowLang) : void putRow(l, kind, mm, rowLang);
  };
  // What room each mounted page has left, for the two sliders' stops — measured off the page
  // on screen, so it answers for what is actually there. Keyed `${unit}:${side}`: the two
  // sides are measured apart, which is the whole point of splitting them.
  const [roomByPage, setRoomByPage] = useState<Map<string, PageRoom>>(new Map());
  const roomOf = (si: number, side: PageSide): PageRoom =>
    roomByPage.get(`${si}:${side}`) ?? { gap: 0, up: 0, down: 0 };

  // ── The page's vertical shift: move the whole block, once air has run out ──
  // Signed, so 0 — not "<= 0" — is what clears it: an upward shift is a real value, and the
  // gap fill's `mm <= 0 -> delete` idiom would silently swallow every one of them.
  const pageShiftOf = (start: number, side: PageSide) => {
    const l = renderLines[start];
    return l ? (rowVal(l, PAGE_SHIFT_KIND[side], gapFillLang(side, lang)) ?? 0) : 0;
  };
  const setPageShift = (start: number, side: PageSide, mm: number) => {
    const l = renderLines[start];
    if (!l) return;
    const kind = PAGE_SHIFT_KIND[side];
    const rowLang = gapFillLang(side, lang);
    Math.abs(mm) < 0.05 ? void delRow(l, kind, rowLang) : void putRow(l, kind, mm, rowLang);
  };

  const WIDTH_KIND: Record<WidthTarget, DocumentLayoutKind> = {
    tibetan: 'width_tibetan', phonetics: 'width_phonetics',
    translation: 'width_translation', section: 'width_section',
  };
  // The Tibetan is language-independent; the recto's translated text is per-edition. `forLang`
  // lets the seed read another edition's widths while measuring it — the widths are part of
  // that edition's height, so a flow that ignored them would mis-measure it.
  const widthLang = (t: WidthTarget, forLang = lang) => (t === 'tibetan' ? '' : forLang);
  const widthOf = (l: DocLine, t: WidthTarget, forLang = lang) =>
    rowVal(l, WIDTH_KIND[t], widthLang(t, forLang)) ?? 0;
  const setWidth = (l: DocLine, t: WidthTarget, mm: number | null) => {
    mm == null ? void delRow(l, WIDTH_KIND[t], widthLang(t))
               : void putRow(l, WIDTH_KIND[t], mm, widthLang(t));
  };
  // A block may be dragged out until it eats its page's right padding (reaching the
  // physical border, where the page clips it), and back until only a sliver is left.
  const widthRange: WidthRange = useMemo(() => ({
    min: config ? -(contentWmm - 20) : -60,
    maxVerso: config ? config.margin_bind_mm : 10,
    maxRecto: config ? config.margin_outer_mm : 10,
  }), [config, contentWmm]);

  const adjFor = (l: DocLine, interactive: boolean, forLang = lang): LineAdj => ({
    gapDeltaMm: rowVal(l, 'line_space') ?? 0,
    noSpace: rowHas(l, 'line_nospace'),
    widths: {
      tibetan: widthOf(l, 'tibetan', forLang), phonetics: widthOf(l, 'phonetics', forLang),
      translation: widthOf(l, 'translation', forLang), section: widthOf(l, 'section', forLang),
    },
    widthRange,
    ...(interactive ? {
      onGap: (d: number) => adjustGap(l, d),
      onToggleNoSpace: () => toggleNoSpace(l),
      onWidth: (t: WidthTarget, mm: number | null) => setWidth(l, t, mm),
    } : {}),
  });

  const vars = useMemo(() => (config ? rootVars(config) : {}), [config]);

  // Fixed-height virtualization: each page-unit is one page tall (+ a 24px gutter).
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  // Distance from the scroll content's top to the virtualized body div. The body sits
  // below the front-matter furniture, so its coordinate origin (where the absolutely
  // positioned spreads are anchored) is offset from the container's raw scrollTop. Measure
  // it so the visible window is computed in body-local coordinates — otherwise the slice is
  // shifted ~frontMatterHeight/spreadHpx spreads and the spread in view gets unmounted.
  const [bodyOffsetTop, setBodyOffsetTop] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setViewH(el.clientHeight);
      if (bodyRef.current) setBodyOffsetTop(bodyRef.current.offsetTop);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, frontMatter.length, backMatter.length, config, styleCss]);
  const spreadHpx = config ? config.page_height_mm * MM_PX + 24 : 800;
  const local = Math.max(0, scrollTop - bodyOffsetTop);
  const vFirst = Math.max(0, Math.floor(local / spreadHpx) - 1);
  const vLast = Math.min(bodyUnits.length, Math.ceil((local + viewH) / spreadHpx) + 1);

  /**
   * Flag any mounted page whose ink runs past the text block.
   *
   * The flow guarantees the pages IT chose fit, so a seeded page can never light up here —
   * that is the point: the badge makes the guarantee visible instead of asking anyone to
   * trust it. What it does catch is everything the flow does not own: a break you placed by
   * hand, a gap or width you tuned afterwards, a line too tall for any page, and the other
   * editions (the breaks are shared, and only the tallest edition drove them).
   *
   * `.booklet-page` has `overflow: hidden`, so today this spills silently at the PHYSICAL
   * page edge, where nothing marks it and the guides are the only hint. Same criterion as
   * `flowPages` — the last ink's bottom against the block's foot. `scrollHeight` would not
   * do: it counts the last line's trailing margin, which a page foot discards.
   */
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let stop = false;
    /**
     * A page's ink against the TWO rooms it has to fit, and the room left in each.
     *
     * They are different questions, and a shift spends one against the other:
     *  - the text BLOCK — does the type fit it AS SET? A shift moves the wrapper's top and
     *    its ink together, so it cancels out of this and cannot answer it. That is why the
     *    shift's mm never has to reach here: measuring from the wrapper's own top IS
     *    measuring the unshifted set.
     *  - the SHEET — is any ink actually being lost? The shift is exactly what decides that,
     *    at either edge.
     *
     * `?? c` is what keeps the furniture pages working through the same function: they have
     * no wrapper (a block between `.booklet-content` and their `height: 100%` children would
     * make that percentage indefinite and un-centre every one of them), and with `w === c`
     * the arithmetic below is identical to what it was before there was a shift at all.
     */
    const extentOf = (c: HTMLElement) => {
      const w = c.querySelector<HTMLElement>(':scope > .bk-shift') ?? c;
      const page = c.parentElement as HTMLElement;
      let ink = -Infinity;
      for (const ch of Array.from(w.children)) ink = Math.max(ink, ch.getBoundingClientRect().bottom);
      const wr = w.getBoundingClientRect(), pr = page.getBoundingClientRect();
      return {
        n: w.children.length,
        setSlack: c.clientHeight - (ink - wr.top),          // the block; shift-invariant
        footSlack: pr.bottom - ink,                         // the sheet, below
        headSlack: wr.top - pr.top,                         // the sheet, above
      };
    };
    const mark = () => {
      if (stop || !scrollRef.current) return;
      for (const c of scrollRef.current.querySelectorAll<HTMLElement>('.booklet-page > .booklet-content')) {
        const page = c.parentElement;
        if (!page) continue;
        const e = extentOf(c);
        // A shift alone can never light this — that is the point of it. What still can: type
        // too tall for the block however it is placed, or ink pushed off the sheet.
        const over = e.n > 0 && (e.setSlack < -0.5 || e.footSlack < -0.5 || e.headSlack < -0.5);
        page.classList.toggle('bk-overfull', over);
        if (over) {
          // Say which room it is out of — the badge is worth having only if it says what to do.
          page.title = e.setSlack < -0.5
            ? `This page is ${Math.round(-e.setSlack)}px taller than the text block however it `
              + 'is placed. Break earlier, close a gap, or split the line.'
            : e.footSlack < -0.5
            ? `This page runs ${Math.round(-e.footSlack)}px off the foot of the sheet and will `
              + 'be trimmed. Shift it up, or give it less to hold.'
            : `This page runs ${Math.round(-e.headSlack)}px off the head of the sheet and will `
              + 'be trimmed. Shift it down.';
        } else if (page.title) {
          page.removeAttribute('title');
        }
      }
      // Each page's remaining room, for the two sliders' stops. Per side: the pages balance
      // independently, so a shared stop would hold the roomier one back to the tighter one's.
      //   gap  — how much MORE each empty line could open before the ink leaves the BLOCK.
      //   down — how far the page could move before its ink leaves the SHEET's foot.
      //   up   — ...before its head leaves the sheet.
      // `gap` is shift-invariant, so shifting does not move the gap slider's stop; the two
      // controls are independent, and you can trade one back for the other. The reverse
      // coupling is real and stays: opening the gaps pushes ink down, so `down` shrinks.
      const next = new Map<string, PageRoom>();
      for (const sp of scrollRef.current.querySelectorAll<HTMLElement>('.booklet-spread[data-unit]')) {
        for (const side of ['verso', 'recto'] as PageSide[]) {
          const c = sp.querySelector<HTMLElement>(`.booklet-page.${side} > .booklet-content`);
          if (!c) continue;
          const e = extentOf(c);
          const gaps = c.querySelectorAll('.bk-gap').length;
          next.set(`${sp.dataset.unit}:${side}`, {
            gap: gaps ? Math.max(0, e.setSlack / gaps / MM_PX) : 0,
            down: Math.max(0, e.footSlack / MM_PX),
            up: Math.max(0, e.headSlack / MM_PX),
          });
        }
      }
      // This effect runs on every render, so only disturb state when the answer moved —
      // otherwise setting it would schedule the render that runs it again. EVERY field has to
      // be compared: miss one and this is an infinite render loop, not a stale number.
      setRoomByPage((prev) => {
        const same = prev.size === next.size && Array.from(next).every(([k, v]) => {
          const p = prev.get(k);
          return !!p && Math.abs(p.gap - v.gap) < 0.05
                     && Math.abs(p.down - v.down) < 0.05
                     && Math.abs(p.up - v.up) < 0.05;
        });
        return same ? prev : next;
      });
    };
    mark();
    // Re-mark once the faces land: measured against fallback metrics every page looks
    // overfull, and a badge that cries wolf on load is worse than none.
    const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) void fonts.ready.then(() => setTimeout(mark, 80));
    return () => { stop = true; };
  });

  /**
   * Width control for one special page's blocks.
   *
   * The key's SHAPE says which of the two anchoring schemes applies, and the schemes are not
   * a choice — they follow where the text actually comes from:
   *  - a syllable id: the Tibetan title, a real line lifted out of the text. It anchors like
   *    any body line and is shared by every edition (`width_tibetan`, lang '').
   *  - `#block`: the translated furniture, which lives in `document_furniture` keyed by
   *    (item, lang) and has no syllable anywhere near it. Anchored on the item plus the block
   *    name, per edition (`width_furniture`). No syllable uuid starts with '#'.
   *
   * A furniture page is symmetric (`--m-outer` both sides), so a block may be pulled out to
   * either physical border.
   */
  const furnitureWidthOf = (item: DocumentItem): BlockWidthOf => (key: string) => {
    const furn = key.startsWith('#');
    const kind: DocumentLayoutKind = furn ? 'width_furniture' : 'width_tibetan';
    // A '#title_tib' block is the booklet's own TIBETAN, so it is shared like the text's own
    // — the same string prints in every edition. Every other '#block' is that edition's text.
    const rowLang = furn && !key.startsWith('#title_tib') ? lang : '';
    const k = `${item.id}:${key}:${kind}:${rowLang}`;
    return {
      valueMm: layoutByKey.get(k)?.value ?? 0,
      min: widthRange.min,
      max: config ? config.margin_outer_mm : 10,
      onCommit: (mm: number | null) => {
        void (async () => {
          const body = { item_id: item.id, anchor_syl_id: key, kind, lang: rowLang };
          mm == null ? await deleteLayoutRow(documentId, body)
                     : await putLayoutRow(documentId, { ...body, value: mm });
          await refreshLayout();
        })();
      },
    };
  };

  const renderFurniture = (item: DocumentItem) => (
    <FurniturePage key={`f${item.id}`} item={item}
      titleLines={item.kind === 'cover' ? mainTitleLines : []}
      body={furnitureBodyOf(furniture, item, lang)} toc={item.kind === 'toc' ? tocRows : []}
      orgSeal={orgSeal} widthOf={furnitureWidthOf(item)}
      tibetan={furnitureBodyOf(furniture, item, TIBETAN_LANG)} />
  );

  if (!doc || !config) {
    return <div className="flex-1 flex items-center justify-center text-ink-soft">Loading booklet…</div>;
  }

  // The Style Studio takes over the whole workspace; closing it reloads the styles so the
  // pages reflect any changes.
  if (showStyles) {
    return <StyleStudio documentId={documentId}
                        onClose={() => { setShowStyles(false); reloadStyles(); }} />;
  }

  const renderPageLines = (s: { start: number; end: number },
                          Comp: React.FC<{
                            l: DocLine; adj?: LineAdj; atPageTop?: boolean; noGap?: boolean;
                          }>) => {
    // Space-above is suppressed on whatever opens the page — the continuation rule if there
    // is one, else the first line. This is also what makes the page reproduce the measured
    // height exactly (see `.bk-atpagetop`).
    const opensWithRule = hairlineSet.has(s.start);
    const els = renderLines.slice(s.start, s.end).map((l, k) => {
      const globalIdx = s.start + k;
      return (
        <div key={l.key} className="bk-linewrap" style={{ position: 'relative' }}>
          {/* The boundary this page OPENS on. A break always is a page start, so it can only
              ever be reached from here — which is why lifting one used to be impossible: the
              controls below only exist between lines, where by construction no break can be.
              A break you placed is marked permanently (not on hover), so a page that ends
              early reads as your decision rather than as the pagination misbehaving. Forced
              starts — a new text, a split's tail — are structural and carry no control. */}
          {k === 0 && globalIdx > 0 && !forcedStarts.has(globalIdx) && breakSet.has(globalIdx) && (
            <span className={`bk-breakctl-group bk-pagestart${
              manualBreaks.has(globalIdx) ? ' bk-breakctl-manual' : ''}`}>
              <button
                type="button"
                onClick={() => void toggleBreak(globalIdx)}
                className="bk-breakctl"
                title={manualBreaks.has(globalIdx)
                  ? 'You broke the page here. A re-flow keeps it and flows around it. Click to lift it.'
                  : 'Broken here automatically — a re-flow may move it. Click to lift it.'}
              >
                <Scissors size={9} />
              </button>
            </span>
          )}
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
          {splitMode && isSplittable(l) && Comp === Verso
            ? <Verso l={l} onSplit={(k) => void setSplit(l, k)} />
            : splitMode && isSplittable(l) && Comp === Recto
            ? <Recto l={l} onWordSplit={(w) => void setRectoCut(l, w)} />
            : <Comp l={l} adj={adjFor(l, true)} atPageTop={k === 0 && !opensWithRule}
                    noGap={Comp === Verso && versoGapSuppressed(renderLines, globalIdx)} />}
        </div>
      );
    });
    // The reference's thin continuation rule: at the top if this page begins with a
    // hairline split (continued from the previous page); at the bottom if the next page
    // does (content runs on). Only on the recto text column.
    return (
      <>
        {opensWithRule && <div className="bk-hairline bk-atpagetop" />}
        {els}
        {hairlineSet.has(s.end) && <div className="bk-hairline" />}
      </>
    );
  };

  return (
    <div className={`flex-1 flex flex-col overflow-hidden booklet-root${guides ? ' bk-guides' : ''}`}
         style={vars}>
      {/* Data-driven typography (org styles ← per-doc overrides); default = booklet.css. */}
      {styleCss && <style dangerouslySetInnerHTML={{ __html: styleCss }} />}
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
        <button type="button" onClick={() => void requestSeed(true)} disabled={seeding}
                className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream disabled:opacity-40"
                style={{ border: '1px solid var(--cline)' }}
                title="Re-measure and re-flow the automatic breaks. Your own breaks and mid-line splits are kept and flowed around; breaks from before this booklet tracked who placed them count as automatic.">
          <RefreshCw size={12} className={seeding ? 'animate-spin' : ''} /> re-flow
        </button>
        {/* The quiet period before the automatic breaks re-flow themselves. Counted in
            SECONDS and restarted by every upstream change, so the pages hold still while you
            work and settle once you stop. Only shown once there is a stamp to measure drift
            against. */}
        {stamp.sig && !seeding && (
          <span className={`px-2 py-1 rounded-md flex items-center gap-1 ${
                  countdown != null ? 'text-lapis' : 'text-ink-soft'}`}
                style={{ border: '1px solid var(--cline)' }}
                title={'After an upstream change, the automatic breaks re-flow once this many '
                     + 'seconds have passed with nothing else changing — the clock restarts on '
                     + 'every edit, so nothing moves while you are still working. Your own '
                     + 'breaks and splits are kept. Balancing a page never starts it.'}>
            re-flow after
            <input
              type="number" min={1} step={5} value={delayS}
              onChange={(e) => setDelayS(Math.max(1, Number(e.target.value) || 1))}
              onBlur={(e) => void putLayoutConfig(documentId,
                { reflow_delay_s: Math.max(1, Number(e.target.value) || 1) } as Partial<LayoutConfig>)}
              className="w-11 px-1 py-0 rounded bg-white text-xs text-center"
              style={{ border: '1px solid var(--cline)' }} />
            <span>
              {countdown != null
                ? `s quiet · ${countdown}s${dirty ? ` (${dirty} syllables changed)` : ''}`
                : 's quiet · settled'}
            </span>
          </span>
        )}
        {msg && (
          <span className="text-vermilion truncate max-w-md" title={msg}>{msg}</span>
        )}
        <a href={`${API_BASE}/documents/${documentId}/pdf?lang=${lang}`}
           className="px-2 py-1 rounded-md flex items-center gap-1 text-jade hover:bg-cream"
           style={{ border: '1px solid var(--cline)' }}
           title={`Export the ${lang.toUpperCase()} edition as a print-ready PDF`}>
          <FileDown size={12} /> PDF
        </a>
        <button type="button" onClick={() => setShowStyles(v => !v)}
                className={`px-2 py-1 rounded-md flex items-center gap-1 hover:bg-cream ${showStyles ? 'text-lapis' : 'text-ink-soft'}`}
                style={{ border: '1px solid var(--cline)' }}
                title="Edit booklet typography (org styles / per-document overrides)">
          <Type size={12} /> styles
        </button>
        <button type="button" onClick={() => setGuides(v => !v)}
                className={`px-2 py-1 rounded-md flex items-center gap-1 hover:bg-cream ${guides ? 'text-lapis' : 'text-ink-soft'}`}
                style={{ border: '1px solid var(--cline)' }}
                title="Show the page geometry — text block, binding side, folio zone (a design aid; the PDF never carries it)">
          <Frame size={12} /> guides
        </button>
        <button type="button" onClick={() => setSplitMode(v => !v)}
                className={`px-2 py-1 rounded-md flex items-center gap-1 hover:bg-cream ${splitMode ? 'text-vermilion' : 'text-ink-soft'}`}
                style={{ border: '1px solid var(--cline)' }}
                title="Mid-line split: click a Tibetan syllable to split a line across a page (hairline); click a split to clear it">
          <Scissors size={12} /> split
        </button>
        <div className="flex-1" />
        <span className="text-ink-soft flex items-center gap-1">
          {(loading || seeding) && <RefreshCw size={12} className="animate-spin" />}
          {spreads.length} spread{spreads.length === 1 ? '' : 's'} · {lines.length} lines
        </span>
      </div>

      {/* Pages (+ optional style designer drawer). Front-matter furniture, then the
          virtualized body spreads, then back-matter furniture. */}
      <div className="flex-1 flex overflow-hidden">
      <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
           className="flex-1 overflow-auto" style={{ background: 'var(--cream)', position: 'relative' }}>
        {frontMatter.length > 0 && (
          <div className="flex flex-col items-center gap-6 pt-6">{frontMatter.map(renderFurniture)}</div>
        )}
        <div ref={bodyRef} style={{ height: bodyUnits.length * spreadHpx, position: 'relative', marginTop: 24 }}>
          {bodyUnits.slice(vFirst, vLast).map((u, k) => {
            const si = vFirst + k;
            return (
              <div key={si} style={{ position: 'absolute', top: si * spreadHpx + 24, left: 0, right: 0,
                                     display: 'flex', justifyContent: 'center' }}>
                {u.kind === 'title' ? (
                  <InternalTitlePage titleLines={u.titleLines}
                                     widthOf={furnitureWidthOf(u.item)}
                                     tibetan={furnitureBodyOf(furniture, u.item, TIBETAN_LANG)} />
                ) : (
                  // Each page carries its OWN vars and its own pair of controls — the
                  // Tibetan is much denser than the translation and needs far more air, so the
                  // two are balanced apart. `.bk-shift` is the block the page's shift moves;
                  // it goes on BODY pages only (see `.bk-shift` in booklet.css, and note the
                  // furniture pages' `height: 100%` children, which a block in between would
                  // un-centre). The gap fill's stop is the room LEFT, so its reach is what is
                  // already spent plus what remains.
                  <div className="booklet-spread" data-unit={si}>
                    {(['verso', 'recto'] as PageSide[]).map((side) => (
                      <div key={side} className={`booklet-page ${side}`}
                           style={pageVars(rows, renderLines[u.s.start], lang, side)}>
                        <div className="booklet-content">
                          <div className="bk-shift">
                            {renderPageLines(u.s, side === 'verso' ? Verso : Recto)}
                          </div>
                        </div>
                        {side === 'recto' && <div className="booklet-folio">{si + 1}</div>}
                        <ShiftMark mm={pageShiftOf(u.s.start, side)} />
                        <GapFillSlider
                          side={side}
                          value={gapFillOf(u.s.start, side)}
                          max={gapFillOf(u.s.start, side) + roomOf(si, side).gap}
                          onChange={(mm) => setGapFill(u.s.start, side, mm)} />
                        <PageShiftSlider
                          side={side}
                          value={pageShiftOf(u.s.start, side)}
                          room={roomOf(si, side)}
                          onChange={(mm) => setPageShift(u.s.start, side, mm)} />
                      </div>
                    ))}
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
      </div>

      {/* Measurement container — mounted only during a seed/re-flow pass.
          It renders `renderLines`, NOT `lines`: everything downstream (spreads, the rows we
          write) indexes the post-split stream, so measuring the pre-split one silently
          paginates a different document than the one on screen.
          Each side sits in a real `.booklet-page > .booklet-content`, which is what makes
          the measured content width equal the printed one and any `.booklet-root`-scoped
          role rule match here exactly as it does on the page — the height cap is lifted in
          CSS so the stream runs to its natural length.
          The `.bk-linewrap` mirrors the bench's own per-line wrapper, so the boxes being
          measured are the boxes being rendered. */}
      {measure && (
        <div ref={measureRef} className="booklet-measure" aria-hidden>
          <div className="booklet-page verso" data-side="verso">
            <div className="booklet-content">
              {/* `.bk-shift` with no var — layout-neutral at rest, and the measure DOM exists
                  precisely so that a selector keyed on these classes matches here exactly as
                  it does on the page. */}
              <div className="bk-shift">
                {renderLines.map((l) => (
                  <div className="bk-linewrap" key={l.key}><Verso l={l} adj={adjFor(l, false)} /></div>
                ))}
              </div>
            </div>
          </div>
          {/* One recto per edition, each with ITS OWN text and widths. The breaks are shared,
              so they have to be measured against all four at once — a `de` recto runs longer
              than an `en` one, and the page has to hold whichever is tallest. */}
          {measure.map((m) => (
            <div className="booklet-page recto" data-recto={m.lang} key={m.lang}>
              <div className="booklet-content">
                <div className="bk-shift">
                  {m.lines.map((l) => (
                    <div className="bk-linewrap" key={l.key}>
                      <Recto l={l} adj={adjFor(l, false, m.lang)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {/* Two stacks differing only by a continuation rule: subtracted, they give the
              rule's true advance including how its margins collapse — which arithmetic on
              `1.2mm + 0.4pt + 1.2mm` cannot. */}
          <div className="bk-hairprobe" data-hairprobe="1">
            <div className="bk-line">&nbsp;</div>
            <div className="bk-hairline" />
            <div className="bk-line">&nbsp;</div>
          </div>
          <div className="bk-hairprobe" data-hairprobe="0">
            <div className="bk-line">&nbsp;</div>
            <div className="bk-line">&nbsp;</div>
          </div>
        </div>
      )}
    </div>
  );
};
