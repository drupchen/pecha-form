/**
 * Booklet pagination — the measuring and the deciding.
 *
 * The bench mounts the whole line stream off-screen inside real page boxes; this module
 * reads it and decides where the pages break. The decision is kept pure and out of the
 * component for two reasons: it can be tested against synthetic metrics without a DOM, and
 * it cannot quietly drift away from `deriveBooklet`, which renders the answer back.
 */

/** FNV-1a, hex. Not a cryptographic hash — it only has to notice that a line changed. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** What one line contributes to a stream signature: its content hashed, and the number of
 *  syllables it is worth. Anything that changes the line's HEIGHT has to be in the hash, or
 *  the pagination would go stale without the count noticing. */
export interface SigLine {
  itemId: number; startSylId: string; role: string; level?: number | null;
  tokenCount: number; phonetics: string; translation: string | null; emptyAfter: boolean;
  /**
   * Which of the line's syllables are SMALL runs — '1'/'0' by position, or '' when it has
   * none.
   *
   * A small run prints at its own size inside an otherwise body-sized line, so re-tagging
   * one re-wraps the line — while its role, its token count and its text all stay exactly
   * as they were. Every other field here would swear nothing had happened.
   *
   * A bitmap and not a count, because position is the whole point: [small, body, small] and
   * [small, small, body] share a count and wrap differently. It costs nothing to be right —
   * the signature's size budget is on its OUTPUT, and `hash` returns 8 chars for any input.
   */
  smallMask: string;
}

/**
 * A signature of the whole compiled stream: one `hash:syllables` per line.
 *
 * Compact on purpose — ~11 bytes a line, so a 1600-line booklet costs ~18KB — because it is
 * stored per document and read on every open. It is a per-line list rather than one digest
 * so that a diff can say HOW MUCH changed, not merely that something did: the bench spends
 * that as a syllable budget before re-flowing.
 */
export function streamSignature(lines: SigLine[]): string {
  // NUL between the fields: it cannot occur in any of them, so no combination of a
  // translation and a role can impersonate another line's. Written as an escape — a literal
  // control byte in the source would be invisible to the next reader.
  const SEP = '\u0000';
  return lines.map((l) => {
    // `smallMask` is appended only when the line HAS a small run. Joining an empty field
    // unconditionally would be the cleaner encoding and would re-hash every line of every
    // booklet — telling each one its whole stream had changed, which is a lie, and one that
    // would bury the real edits sitting in the drift count. A renderer change announces
    // itself through the style fingerprint instead; this field is about small runs.
    const body = [l.itemId, l.startSylId, l.role, l.level ?? '',
                  l.phonetics, l.translation ?? '', l.emptyAfter ? 1 : 0,
                  ...(l.smallMask ? [l.smallMask] : [])].join(SEP);
    return `${hash(body)}:${l.tokenCount}`;
  }).join(' ');
}

/** Project the compiled stream onto the fields a signature cares about. Structural on
 *  purpose: this module stays free of the render types, so it can be tested without a DOM. */
export function toSigLines(lines: readonly {
  itemId: number; startSylId: string; role: string; level?: number | null;
  tokens: readonly { small?: boolean }[]; phonetics: string; translation: string | null;
  emptyAfter: boolean;
}[]): SigLine[] {
  return lines.map((l) => ({
    itemId: l.itemId, startSylId: l.startSylId, role: l.role, level: l.level ?? null,
    tokenCount: l.tokens.length, phonetics: l.phonetics, translation: l.translation,
    emptyAfter: l.emptyAfter,
    smallMask: l.tokens.some((t) => t.small)
      ? l.tokens.map((t) => (t.small ? '1' : '0')).join('') : '',
  }));
}

/**
 * How many SYLLABLES have changed between the stream a pagination was flowed against and
 * the one now.
 *
 * Compared by position: the streams are the same document, so a run of edits shows up as a
 * run of differing lines. A line that changed is counted at its CURRENT weight, one that
 * vanished at its old — either way the number answers "how much of this booklet has moved
 * since it was paginated", which is the only thing it is used for.
 */
export function dirtySyllables(oldSig: string | null, now: SigLine[]): number {
  if (!oldSig) return 0;                 // never recorded: assume nothing, disturb nothing
  const before = oldSig.split(' ').filter(Boolean);
  const cur = streamSignature(now).split(' ').filter(Boolean);
  let dirty = 0;
  for (let i = 0; i < Math.max(before.length, cur.length); i++) {
    const b = before[i], c = cur[i];
    if (b === c) continue;
    // Weight by whichever side exists — an added or edited line by what it is now, a
    // deleted one by what it was.
    const w = c ? Number(c.split(':')[1]) : Number((b ?? ':0').split(':')[1]);
    dirty += Number.isFinite(w) ? w : 0;
  }
  return dirty;
}

/** The first family of a `font-family` list — `'Chogyal', 'Jomolhari', serif` → `'Chogyal'`.
 *  Checking the whole list is useless: it ends in a generic that is always "loaded". */
const firstFamily = (list: string) => (list.split(',')[0] ?? '').trim();

/**
 * Wait until the booklet's faces are usable, then let layout settle. Returns false if the
 * Tibetan face still is not — the caller must then NOT measure.
 *
 * `document.fonts.ready` ALONE is not enough, and the trap is quiet: it resolves once the
 * fonts *currently pending* have settled. A stream that has only just mounted may not have
 * triggered its `@font-face` requests yet, so `ready` can resolve instantly against a
 * document still laying Tibetan out in `serif` — which is the bug this guards. Asking for
 * each family BY NAME first is what actually starts the loads; only then is waiting
 * meaningful.
 *
 * @param root  an element inside `.booklet-root`, so the `--font-*` vars resolve.
 * @param probePt  a size to probe at; any size loads the face.
 */
export async function awaitBookletFonts(root: HTMLElement, probePt: number): Promise<boolean> {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return true;                       // no Font Loading API — measure as-is
  const cs = getComputedStyle(root);
  const famOf = (v: string) => cs.getPropertyValue(v).trim();
  const lists = ['--font-tibetan', '--font-translation', '--font-phonetics',
                 '--font-small', '--font-title'].map(famOf).filter(Boolean);
  await Promise.all(lists.map((f) => fonts.load(`${probePt}pt ${f}`).catch(() => {})));
  await fonts.ready;
  // A timeout, not rAF: rAF is throttled in background tabs, and a seed must not stall
  // there. Mirrors the PDF path's readiness signal in PrintBooklet.
  await new Promise((r) => setTimeout(r, 80));
  const tib = firstFamily(famOf('--font-tibetan'));
  if (!tib) return true;
  try { return fonts.check(`${probePt}pt ${tib}`); } catch { return true; }
}

/** One line's vertical extent, px, relative to the measured container. */
export interface LineMetrics {
  /** Border-box top. The line's own top margin has already collapsed with its
   *  predecessor's bottom margin and sits ABOVE this — outside the measurement, which is
   *  exactly right: `.bk-atpagetop` suppresses it when the line starts a page. */
  top: number;
  /** Border-box bottom — excludes the line's collapsed-out bottom margin. A trailing
   *  margin at a page foot is discarded whitespace; counting it would under-fill every
   *  page by `.bk-translation`'s 2.85pt. */
  bottom: number;
}

/**
 * Read a mounted stream: one rect per line, in stream order.
 *
 * `getBoundingClientRect`, not `offsetTop`/`offsetHeight` — the offset pair rounds to whole
 * pixels, and across the ~40 lines of a page that drift reaches a whole line on a 187.6mm
 * text block. The measure container is absolutely positioned with no transform in its
 * ancestry, so these rects are plain layout pixels.
 */
export function readStream(container: HTMLElement, selector: string): LineMetrics[] {
  const top0 = container.getBoundingClientRect().top;
  return Array.from(container.querySelectorAll<HTMLElement>(selector), (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top - top0, bottom: r.bottom - top0 };
  });
}

/**
 * The vertical advance one continuation rule costs, px — measured, never computed.
 *
 * `.bk-hairline`'s 1.2mm margins collapse with its neighbours', so `1.2 + 0.4pt + 1.2` is
 * not the answer; the answer depends on what it sits between. Two probes differing only by
 * the rule, subtracted, give it exactly. Bare `.bk-line`s carry no margins of their own, so
 * nothing collapses the rule's margins away and this returns its LARGEST advance — the
 * conservative reading, which is what a budget wants.
 *
 * Returns 0 if the probes are absent (the caller then simply reserves nothing).
 */
export function readHairlineAdvance(container: HTMLElement): number {
  const withRule = container.querySelector<HTMLElement>('[data-hairprobe="1"]');
  const without = container.querySelector<HTMLElement>('[data-hairprobe="0"]');
  if (!withRule || !without) return 0;
  const d = withRule.getBoundingClientRect().height - without.getBoundingClientRect().height;
  return d > 0 ? d : 0;
}

/**
 * Walk the words (`\S+` runs) of the TEXT nodes under `root`, in document order — the ONE
 * tokenization every consumer shares: the split that cuts a translation, the measurer that
 * reads word rects, and the count a proportional default divides. Counting the same text
 * two ways would let a measured index cut at a different word than the one it measured.
 * Return `false` from `cb` to stop the walk.
 */
export function forEachWord(
  root: Node,
  cb: (node: Text, start: number, end: number, word: number) => boolean | void,
): void {
  const doc = (root.ownerDocument ?? root) as Document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let w = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.nodeValue || ''))) {
      if (cb(node as Text, m.index, m.index + m[0].length, w) === false) return;
      w++;
    }
  }
}

/** One rendered row INSIDE a line: the index of the content unit (token or word) that opens
 *  it, and its extent — in the same coordinate space as the line's `LineMetrics`. */
export interface SubRow { start: number; topPx: number; bottomPx: number }

/**
 * What one column knows about cutting inside one line.
 *  - `units`: content that stacks as one block — the verso's tokens, or a single-text
 *    recto's words (a mantra's phonetics, a homage's translation). `units` counts them.
 *  - `pair`: a phonetics+translation pair — each element's word rows, plus the collapsed
 *    gap between the two blocks. A pair's halves must BOTH stay pairs (see `ColCut`).
 */
export type ColBoundaries =
  | { kind: 'units'; units: number; rows: SubRow[] }
  | { kind: 'pair';
      phonWords: number; phon: SubRow[];
      transWords: number; trans: SubRow[];
      gapPx: number };

/**
 * A column's chosen cut for a split line.
 *  - `unit`: the tail starts at token/word `at` (the verso's shared Tibetan cut, or a
 *    single-text recto's word cut).
 *  - `pair`: the head keeps `a` words of the phonetics AND `b` of the translation — the two
 *    are one decision, because phonetics and translation are unbreakable pairs: `(0,0)` puts
 *    the whole pair on the tail, `(phonWords,transWords)` keeps it whole on the head, and an
 *    interior cut leaves BOTH halves with both elements. A mixed cut that strands one
 *    element without the other is never emitted.
 */
export type ColCut = { kind: 'unit'; at: number } | { kind: 'pair'; a: number; b: number };

/** One mid-line split the flow decided on: the line, and one cut per SIDE (indexed like the
 *  `sides` input; null = that side keeps its derive-time default). `cuts[0]` is always the
 *  verso's shared token cut. */
export interface FlowSplit { index: number; cuts: (ColCut | null)[] }

/** ≈4mm: below this a split saves nothing worth a hairline. In px so the flow stays unit-
 *  agnostic; the caller may override via `minSplitGainPx`. */
const MIN_SPLIT_GAIN_PX = 15;

/** Group content rects into rendered rows: a new row starts when a rect's top leaves the
 *  current row's band. Returns rows in order; `start` = the first unit of each row. */
function rowsOf(rects: { index: number; top: number; bottom: number }[]): SubRow[] {
  const rows: SubRow[] = [];
  for (const r of rects) {
    const cur = rows[rows.length - 1];
    // Tolerance: baseline jitter within a row is < a couple px; a real row advance is a
    // whole line-height. 3px separates the two safely at any booklet size.
    if (!cur || r.top > cur.topPx + 3) {
      rows.push({ start: r.index, topPx: r.top, bottomPx: r.bottom });
    } else {
      if (r.bottom > cur.bottomPx) cur.bottomPx = r.bottom;
      if (r.top < cur.topPx) cur.topPx = r.top;
    }
  }
  return rows;
}

/** The verso's sub-line boundaries: one rect per token span under `.bk-tibetan`, grouped
 *  into rows. `container` fixes the coordinate origin — the same one `readStream` used. */
export function readTokenBoundaries(lineEl: HTMLElement, container: HTMLElement): ColBoundaries | null {
  const spans = Array.from(lineEl.querySelectorAll<HTMLElement>('.bk-tibetan > span'));
  if (spans.length < 2) return null;
  const top0 = container.getBoundingClientRect().top;
  const rects = spans.map((s, index) => {
    const r = s.getBoundingClientRect();
    return { index, top: r.top - top0, bottom: r.bottom - top0 };
  });
  return { kind: 'units', units: spans.length, rows: rowsOf(rects) };
}

/** One recto block's word rows, read through DOM Ranges over `forEachWord` — the same walk
 *  that will cut the text, so the indices cannot disagree. */
function readWordRows(block: HTMLElement, top0: number): { words: number; rows: SubRow[] } {
  const rects: { index: number; top: number; bottom: number }[] = [];
  let words = 0;
  forEachWord(block, (node, start, end, word) => {
    const range = (block.ownerDocument as Document).createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const r = range.getBoundingClientRect();
    rects.push({ index: word, top: r.top - top0, bottom: r.bottom - top0 });
    words = word + 1;
  });
  if (!words) return { words: 0, rows: [] };
  return { words, rows: rowsOf(rects) };
}

/** A recto line's sub-line boundaries: a phonetics+translation pair, or the single text of
 *  a mantra / homage / section line. Null when there is nothing to cut. */
export function readRectoBoundaries(lineEl: HTMLElement, container: HTMLElement): ColBoundaries | null {
  const top0 = container.getBoundingClientRect().top;
  const phonEl = lineEl.querySelector<HTMLElement>('.bk-phonetics');
  const transEl = lineEl.querySelector<HTMLElement>('.bk-translation, .bk-section');
  if (phonEl && transEl) {
    const phon = readWordRows(phonEl, top0);
    const trans = readWordRows(transEl, top0);
    if (!phon.words || !trans.words) return null;
    const gapPx = transEl.getBoundingClientRect().top - phonEl.getBoundingClientRect().bottom;
    return { kind: 'pair', phonWords: phon.words, phon: phon.rows,
             transWords: trans.words, trans: trans.rows, gapPx: Math.max(0, gapPx) };
  }
  const single = transEl ?? phonEl;
  if (!single) return null;
  const r = readWordRows(single, top0);
  return r.words >= 2 ? { kind: 'units', units: r.words, rows: r.rows } : null;
}

export interface FlowInput {
  /** Lines in the stream — every side shares it. */
  n: number;
  /** Indices that MUST start a page: text-item boundaries, split tails, and the user's own
   *  breaks. The flow fills the runs between them and never overrides one. */
  forced: Set<number>;
  /** Indices whose page opens with a continuation rule (its predecessor's page closing with
   *  one). Always a subset of `forced`: seeding never invents a hairline. */
  hairlines: Set<number>;
  /** The text block's height, px. */
  contentHpx: number;
  /** One continuation rule's advance, px — from `readHairlineAdvance`. */
  hairHpx: number;
  /**
   * Indices the flow must not CHOOSE as page starts, because a break row anchored there
   * would not come back to the same line:
   *  - an ambiguous anchor — the same (item, syllable) appears earlier in the stream, so
   *    the row resolves to that earlier line instead (transcluded text repeats syllable
   *    ids by design);
   *  - a split head — its anchor already carries the split row, and a second row on the
   *    same unique key would overwrite it.
   * Forced starts are exempt: they are not chosen, they simply are.
   */
  unbreakable?: Set<number>;
  /** Lines that must never be a page's LAST line — the section headings (sapche/title
   *  runs). A heading stranded at a page's foot announces content the reader has to turn
   *  the page to find; the flow walks the break back so the heading opens the next page
   *  with what it heads. The dual of `unbreakable`: that one says "no page may START at
   *  line i", this one says "no page may END at line i". */
  noTail?: Set<number>;
  /**
   * Sub-line boundaries for line `line` in `sides[side]`, or null when that line cannot be
   * cut there. Lazy — the flow asks only at the ~one boundary line per page, so the caller
   * can afford real DOM reads (Ranges over the measure DOM) behind it. Absent = the flow
   * never splits, exactly as before it could.
   */
  subBoundaries?: (side: number, line: number) => ColBoundaries | null;
  /** Lines the flow may not SPLIT (on top of `unbreakable`, which also blocks it): the
   *  halves of an existing manual split — a second split row on the same anchor would
   *  overwrite the first. */
  unsplittable?: Set<number>;
  /** Overrides MIN_SPLIT_GAIN_PX: the least head-side gain (in any column) that makes a
   *  split worth its hairline. */
  minSplitGainPx?: number;
}

export interface FlowResult {
  /** Page start indices, ascending, always opening with 0. */
  starts: number[];
  /** Starts whose page overflows even holding its single first line. Diagnostic only —
   *  never control flow; such a line has nowhere else to go. */
  overfull: number[];
  /** Mid-line splits the flow placed: each `index` also appears in `starts` (the tail opens
   *  that page). Empty unless `subBoundaries` was supplied. */
  splits: FlowSplit[];
}

/**
 * Flow the stream into pages.
 *
 * `sides` is one metrics array per column that shares this pagination: the Tibetan verso,
 * plus one recto per language edition. A spread has to fit ALL of them, so a page's used
 * height is the tallest side's. That is what makes the editions page-align *and* stay
 * inside their text blocks — the shared break rows have always implied it, and taking the
 * max is what finally delivers it.
 *
 * Height is a DIFFERENCE OF ABSOLUTE OFFSETS, never a running sum. That is the whole reason
 * to measure one continuous stream: the margins between adjacent lines have already
 * collapsed there exactly as they will on the page, so the difference is simply the truth.
 * (Summing per-line heights plus their computed margins — or measuring each line inside its
 * own `flow-root` — sums UNCOLLAPSED margins and over-counts: `.bk-section`'s 19.2pt-before
 * and 7.8pt-after collapse to 19.2pt between two headings, but sum to 27pt.)
 *
 * It is also what makes the loop total. `start` only ever advances to the current `i`, so
 * every page keeps at least one line, and a line taller than its page sits alone without
 * poisoning the next decision — no special case needed.
 */
export function flowPages(sides: LineMetrics[][], f: FlowInput): FlowResult {
  const { n, forced, hairlines, contentHpx, hairHpx } = f;
  const un = f.unbreakable ?? new Set<number>();
  const noTail = f.noTail ?? new Set<number>();
  const uns = f.unsplittable ?? new Set<number>();
  const sub = f.subBoundaries;
  const minGain = f.minSplitGainPx ?? MIN_SPLIT_GAIN_PX;
  const starts: number[] = [];
  const overfull: number[] = [];
  const splits: FlowSplit[] = [];
  if (n <= 0) return { starts, overfull, splits };

  // Only sides that actually measured the whole stream get a vote; a short one would read
  // `undefined` and poison the max. `colsIdx` remembers each vote's ORIGINAL side index,
  // because `subBoundaries` and the reported cuts speak in those.
  const colsIdx: number[] = [];
  sides.forEach((m, i) => { if (m.length >= n) colsIdx.push(i); });
  const cols = colsIdx.map((i) => sides[i]);
  if (!cols.length) return { starts: [0], overfull, splits };

  // Where each segment ends — the next hard start at or after i. Precomputed: `budget` is
  // called once per line, and scanning forward each time would make this quadratic.
  const nextForced = new Int32Array(n);
  let nf = n;
  for (let i = n - 1; i >= 0; i--) {
    nextForced[i] = nf;
    if (forced.has(i)) nf = i;
  }

  // Where the CURRENT page starts, per column. For a whole-line start every column starts
  // at that line's top; a split tail starts each column at its own cut boundary — that is
  // the entire reason this is a vector of Ys and not a line index. `startYOf`/`openHairOf`
  // remember every page's values for the final overfull pass.
  let startY = cols.map((m) => m[0].top);
  let openHair = hairlines.has(0);
  const startYOf = new Map<number, number[]>();
  const openHairOf = new Map<number, boolean>();
  const record = (s: number) => { startYOf.set(s, startY); openHairOf.set(s, openHair); };
  record(0);

  // A page's budget: the text block, less any continuation rule it must carry. The foot
  // rule is reserved on every page of a segment that ends in one, rather than resolved once
  // the last page is known — it costs ~13px on the pages before the last, and the fixup
  // would have to cascade backwards through decisions already made. The opening rule comes
  // from `openHairOf`, not `hairlines`, because a NEW split's tail opens with a rule the
  // input sets know nothing about.
  const budget = (s: number) =>
    contentHpx
    - ((openHairOf.get(s) ?? hairlines.has(s)) ? hairHpx : 0)
    - (hairlines.has(nextForced[s]) ? hairHpx : 0);
  const used = (i: number) => {
    let h = 0;
    cols.forEach((m, c) => {
      const d = m[i].bottom - startY[c];
      if (d > h) h = d;
    });
    return h;
  };
  const fits = (s: number, i: number) => used(i) <= budget(s);

  /**
   * Try to SPLIT line `b` instead of moving it whole to the next page: a shared Tibetan cut
   * that fits the verso, plus one per-column recto cut, each flexed to fill ITS page. The
   * head page closes with a continuation rule and the tail page opens with one, so both
   * carry `hairHpx` here. Null = not eligible / nothing fits / nothing worth gaining —
   * the caller then breaks whole, exactly as before splits existed.
   */
  const trySplit = (b: number): { cuts: (ColCut | null)[]; tailY: number[] } | null => {
    if (!sub || un.has(b) || uns.has(b) || noTail.has(b)) return null;
    const budgetSplit = contentHpx - (openHair ? hairHpx : 0) - hairHpx;
    // EVERY column must afford the split before it earns anyone anything: the head page
    // closes with the continuation rule in ALL of them — including a column whose cut ends
    // up (0,0) and gains nothing — so a column already too full to take the rule vetoes the
    // split outright (a plain break there is underfull; a rule-overflowed page is a defect).
    // And if no column has at least the threshold to spend, the split buys a hairline and
    // nothing else.
    const room = cols.map((m, c) => budgetSplit - (m[b - 1].bottom - startY[c]));
    if (Math.min(...room) < 0 || Math.max(...room) < minGain) return null;

    // The verso's shared cut: the LARGEST token-row boundary whose head still fits the
    // verso page. The verso must be a measured column — its cut is the split row itself.
    const versoCol = colsIdx.indexOf(0);
    if (versoCol < 0) return null;
    const vb = sub(0, b);
    if (!vb || vb.kind !== 'units' || vb.rows.length < 2) return null;
    let vAt = 0, vTailTop = 0, vHeadBottom = 0;
    for (let r = vb.rows.length - 1; r >= 1; r--) {
      if (vb.rows[r - 1].bottomPx - startY[versoCol] <= budgetSplit) {
        vAt = vb.rows[r].start; vTailTop = vb.rows[r].topPx; vHeadBottom = vb.rows[r - 1].bottomPx;
        break;
      }
    }
    if (vAt <= 0) return null;

    const cuts: (ColCut | null)[] = sides.map(() => null);
    const tailY = cols.map((m) => m[b].top);
    cuts[0] = { kind: 'unit', at: vAt };
    tailY[versoCol] = vTailTop;
    let maxGainPx = vHeadBottom - cols[versoCol][b].top;

    // The Tibetan's fraction, for breaking recto ties toward the semantically aligned cut.
    const frac = vAt / vb.units;

    for (let c = 0; c < cols.length; c++) {
      if (c === versoCol) continue;
      const side = colsIdx[c];
      const bd = sub(side, b);
      const lineTop = cols[c][b].top, lineBottom = cols[c][b].bottom;
      const fitsHead = (headH: number) => lineTop + headH - startY[c] <= budgetSplit;
      if (bd?.kind === 'pair') {
        // The valid pair cuts (see ColCut): whole-on-head, interior x interior, or (0,0).
        // Max fill wins; among (near-)equal heights the one closest to the Tibetan's
        // fraction — the same tie the proportional default settles when nothing is stored.
        let best: { a: number; b: number; headH: number } | null = null;
        const target = { a: frac * bd.phonWords, b: frac * bd.transWords };
        const consider = (a: number, bw: number, headH: number) => {
          if (!fitsHead(headH)) return;
          if (best && headH < best.headH - 0.5) return;
          if (best && Math.abs(headH - best.headH) <= 0.5) {
            const dNew = Math.abs(a - target.a) + Math.abs(bw - target.b);
            const dOld = Math.abs(best.a - target.a) + Math.abs(best.b - target.b);
            if (dNew >= dOld) return;
          }
          best = { a, b: bw, headH };
        };
        consider(bd.phonWords, bd.transWords, lineBottom - lineTop);
        const phonHeadH = (r: number) => bd.phon[r - 1].bottomPx - bd.phon[0].topPx;
        const transHeadH = (r: number) => bd.trans[r - 1].bottomPx - bd.trans[0].topPx;
        for (let rp = 1; rp < bd.phon.length; rp++) {
          for (let rt = 1; rt < bd.trans.length; rt++) {
            consider(bd.phon[rp].start, bd.trans[rt].start,
                     phonHeadH(rp) + bd.gapPx + transHeadH(rt));
          }
        }
        const chosen: { a: number; b: number; headH: number } =
          best ?? { a: 0, b: 0, headH: 0 };   // nothing fits: the whole pair opens the tail
        cuts[side] = { kind: 'pair', a: chosen.a, b: chosen.b };
        tailY[c] = chosen.headH >= lineBottom - lineTop ? lineBottom : lineTop + chosen.headH;
        if (chosen.headH > maxGainPx) maxGainPx = chosen.headH;
      } else if (bd?.kind === 'units' && bd.rows.length >= 2) {
        // A single-text recto (mantra, homage): largest fitting word-row boundary, else
        // everything to the tail.
        let done = false;
        for (let r = bd.rows.length - 1; r >= 1; r--) {
          if (bd.rows[r - 1].bottomPx - startY[c] <= budgetSplit) {
            cuts[side] = { kind: 'unit', at: bd.rows[r].start };
            tailY[c] = bd.rows[r].topPx;
            const gain = bd.rows[r - 1].bottomPx - lineTop;
            if (gain > maxGainPx) maxGainPx = gain;
            done = true;
            break;
          }
        }
        if (!done) { cuts[side] = { kind: 'unit', at: 0 }; tailY[c] = lineTop; }
      }
      // bd null: the column keeps its derive-time default (cuts[side] stays null) and the
      // conservative tail estimate (the whole line) stands.
    }
    if (maxGainPx < minGain) return null;
    return { cuts, tailY };
  };

  starts.push(0);
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (forced.has(i)) {
      starts.push(i); start = i;
      startY = cols.map((m) => m[i].top); openHair = hairlines.has(i); record(i);
      continue;
    }
    if (fits(start, i)) continue;
    // The page is full at `i`. Break there if a row can actually be anchored on it AND the
    // page it closes does not end on a heading; otherwise fall back to the last line that
    // satisfies both. Anything in (start, i) is a prefix of a run that fitted, so falling
    // back is always safe — it only ever costs fill, never overflow. `noTail.has(b - 1)`
    // reads: a break at `b` makes `b - 1` the page's last line, and a heading there is the
    // stranded-sapche page the rule forbids — stepping back once per heading walks the
    // whole run over to the next page.
    let b = i;
    while (b > start + 1 && (un.has(b) || noTail.has(b - 1))) b--;
    if (un.has(b) || noTail.has(b - 1)) b = i;
    // Before moving line `b` to the next page whole, try to leave part of it behind: the
    // shared Tibetan cut + per-edition recto cuts that fill each column's remaining room.
    const sp = trySplit(b);
    if (sp) {
      splits.push({ index: b, cuts: sp.cuts });
      starts.push(b); start = b;
      startY = sp.tailY; openHair = true; record(b);
      i = b;
      continue;
    }
    // nothing valid in the whole run: take the overflow and let `overfull` report it
    // rather than move the break silently
    starts.push(b);
    start = b;
    startY = cols.map((m) => m[b].top); openHair = hairlines.has(b); record(b);
    i = b;   // re-flow from the boundary we actually took
  }
  for (const s of starts) {
    const sy = startYOf.get(s)!;
    let h = 0;
    cols.forEach((m, c) => {
      const d = m[s].bottom - sy[c];
      if (d > h) h = d;
    });
    if (h > budget(s)) overfull.push(s);
  }
  return { starts, overfull, splits };
}
