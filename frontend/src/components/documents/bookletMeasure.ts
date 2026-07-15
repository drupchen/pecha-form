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
}

export interface FlowResult {
  /** Page start indices, ascending, always opening with 0. */
  starts: number[];
  /** Starts whose page overflows even holding its single first line. Diagnostic only —
   *  never control flow; such a line has nowhere else to go. */
  overfull: number[];
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
  const starts: number[] = [];
  const overfull: number[] = [];
  if (n <= 0) return { starts, overfull };

  // Only sides that actually measured the whole stream get a vote; a short one would read
  // `undefined` and poison the max.
  const cols = sides.filter((m) => m.length >= n);
  if (!cols.length) return { starts: [0], overfull };

  // Where each segment ends — the next hard start at or after i. Precomputed: `budget` is
  // called once per line, and scanning forward each time would make this quadratic.
  const nextForced = new Int32Array(n);
  let nf = n;
  for (let i = n - 1; i >= 0; i--) {
    nextForced[i] = nf;
    if (forced.has(i)) nf = i;
  }

  // A page's budget: the text block, less any continuation rule it must carry. The foot
  // rule is reserved on every page of a segment that ends in one, rather than resolved once
  // the last page is known — it costs ~13px on the pages before the last, and the fixup
  // would have to cascade backwards through decisions already made.
  const budget = (s: number) =>
    contentHpx
    - (hairlines.has(s) ? hairHpx : 0)
    - (hairlines.has(nextForced[s]) ? hairHpx : 0);
  const used = (s: number, i: number) => {
    let h = 0;
    for (const m of cols) {
      const d = m[i].bottom - m[s].top;
      if (d > h) h = d;
    }
    return h;
  };
  const fits = (s: number, i: number) => used(s, i) <= budget(s);

  starts.push(0);
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (forced.has(i)) { starts.push(i); start = i; continue; }
    if (fits(start, i)) continue;
    // The page is full at `i`. Break there if a row can actually be anchored on it;
    // otherwise fall back to the last line that can carry one. Anything in (start, i) is a
    // prefix of a run that fitted, so falling back is always safe — it only ever costs
    // fill, never overflow.
    let b = i;
    while (b > start + 1 && un.has(b)) b--;
    if (un.has(b)) b = i;   // nothing anchorable in the whole run: take the overflow and
                            // let `overfull` report it rather than move the break silently
    starts.push(b);
    start = b;
    i = b;   // re-flow from the boundary we actually took
  }
  for (const s of starts) if (!fits(s, s)) overfull.push(s);
  return { starts, overfull };
}
