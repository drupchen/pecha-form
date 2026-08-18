# pecha-form — architecture, invariants, and the traps

This document exists because several subsystems here look ordinary and are not. Each of the
rules below was learned by breaking something that had worked for months. Read the section that
covers what you are about to touch **before** you design a change, not after the regression.

The single most important habit: **when the user says "this worked before", it worked before.**
Find the mechanism (`git log -S'<symbol>' -- <path>`, or read the pre-change file) instead of
concluding the behaviour was never implemented. Every regression in this codebase's history was
introduced by someone who did not do that first.

---

## 1. What the application is

Three workspaces over one corpus of Tibetan texts:

| Workspace | What it does | Where |
|---|---|---|
| **Text workspace** | segmentation, tagging (roles), the sapche outline tree, notes, spans, passages | `components/workspace/` |
| **Translate bench** | chunk-by-chunk translation into many languages, phonetics, arrangement (moves/titles) | `components/translate/` |
| **Documents** | aligned text pages and printed booklets, pagination, styles, PDF, versions | `components/documents/` |

Backend: FastAPI + SQLite (`backend/`). Frontend: React + Vite + Zustand + Tailwind
(`frontend/`). No ORM, no migrations framework, no server-side rendering.

The three workspaces share **syllable uuids** and nothing else. That is the whole design.

---

## 2. Backend conventions

- **One SQLite file**, `backend/sapche.db`. All DDL lives in `app/db.py::init_db()`, is
  idempotent (`CREATE TABLE IF NOT EXISTS`), and runs on every boot.
- **Migrations are `_rebuild_*` functions.** SQLite cannot alter a constraint, so widening a
  `UNIQUE` or a `CHECK` means: create the new table, copy the rows, drop, rename. See
  `_rebuild_tree_nodes_position_unique` and `_rebuild_document_items_kinds` for the pattern.
  A new value in a `CHECK (kind IN (...))` list **requires** a rebuild; adding it to the string
  alone silently does nothing on an existing database.
- **Routers** live in `app/routers/`, are mounted under `/api`, and each declares
  `dependencies=[Depends(guard(section, resolvers))]`.
- **`guard()`'s inner dependency MUST stay `async`.** It sets a `ContextVar` that the
  (threadpool-run) sync handler reads. A sync dependency runs in a different context and the
  value is lost — the comment in `app/auth.py` says so; do not "simplify" it.
- Handlers are ordinary sync functions taking a `sqlite3.Connection` from `get_db()`; they
  `close()` in a `finally`. Rows come back as `sqlite3.Row`.
- **Bookkeeping must never be able to fail a user's write.** `_record_revision` in
  `routers/translations.py` nulls the author when the `users` row is absent, because a foreign
  key violation there would abort the translation save it was only observing.

### Auth and organisations

- Cookie sessions (argon2id passwords) plus an **`X-Org-Id` header** on every request; the
  header's custom nature is what makes it CSRF-resistant, and reads may fall back to an `?org=`
  query param for print tokens.
- Per-org roles across five sections, each `none | read | modify`. Superusers bypass. **Print
  tokens are read-only** by construction.
- `SAPCHE_AUTH_DISABLED=1` short-circuits authentication for local verification only.
- **The CORS allowlist in `app/main.py` is a literal list of dev origins.** If the frontend is
  served on a port that is not in it, login fails with an opaque network error. Both 5173 and
  5174 are listed for that reason.

---

## 3. The syllable-native data model

**Syllables are the only truth.** `syllables` holds one row per syllable of a text, each with a
uuid. Every annotation — spans, markers, notes, passages, tree nodes, translation chunks,
booklet layout rows, phonetics — stores **`*_syl_id` uuids, never character offsets**. Offsets
are derived on read; the offset columns were deliberately dropped.

Consequences you must respect:

- **Editing text must preserve ids.** `app/id_reconcile.py::assign_stable_ids` aligns the stored
  token sequence against a freshly tokenised one and carries ids across: *equal*, *move* and
  *replace* all preserve the id; only a genuine *insert* mints, only a genuine *delete* drops.
  A wholesale re-mint detaches every annotation in the corpus from its anchor.
- **An anchor that does not resolve is silently dropped, not an error.** That is what makes
  inheritance work, and it is also why a broken id shows up as "my annotation vanished" rather
  than as an exception.
- Anything that needs a *position* (ordering, ranges) derives it from the syllable stream at
  read time. Nothing stores a position that a later edit could invalidate.

---

## 4. Derivation and live inheritance

A secondary text (an extract, a transclusion, a compilation) **does not copy** its parent's
annotations. `app/inherit.py::source_texts(cursor, text_id)` returns the parent chain plus
transclusion sources, recursively and cycle-guarded; every annotation read gathers rows from
`[text_id] + source_texts(...)` and keeps those whose anchors resolve in the child's composed
stream.

- Editing happens on the **owning** text and ripples to every child by construction.
- Ripple is implemented by **re-baking with stable uuids**, never by writing snapshot copies.
- A child may add its own rows; they live beside the inherited ones.
- **Corollary the user has already hit:** a secondary extracted before a fix inherits *nothing*
  where the source has nothing. "The extract has no tags" is usually a fact about the source at
  extraction time, not a bug in inheritance.

---

## 5. The sapche tree

`tree_nodes` is the outline. Two things about it are unusual:

- **`position` is scoped per `(owner_text, parent)`,** not per parent. A composed level can
  interleave nodes owned by different texts; their relative order is composed from their
  anchors, and each owner numbers its own children independently. `UNIQUE(parent_id, position)`
  had to be widened to include `text_id` — with the old constraint, adding a node to a composed
  level collided with an inherited sibling and the insert failed.
- **The client sorts by `sort_index`, which the server computes** (`_order_level` /
  `_with_sort_index` in `routers/tree_nodes.py`). Any endpoint that returns a node must return
  it *with* its `sort_index`; a `PATCH` response that defaults it to 0 sends the node to the top
  of the outline. `useTreeNodeStore.updateNode` refetches for the same reason — a locally
  patched node has no authoritative order.
- Moving a node validates the target level with `_validate_parent(conn, …)`, which must accept
  the **gathered** (inherited + own) node set. Validating against own-rows only is what
  disabled the up/down arrows for a node the user had just created in a secondary text.

---

## 6. The translation layer

### Chunks

Chunks are **derived, not stored as ranges**: `components/translate/chunks.ts::deriveChunks`
cuts the token stream at role boundaries (`small`, `mantra`, `sapche`, `title`, `intro`,
`verse`, `prose` — see `TYPE_PRIORITY`). A translation is stored against
`rangeKey(startSylId, endSylId)`. Re-derivation after an edit therefore re-attaches every
translation whose range survives.

Around that: `translation_overrides` (per-document tweaks), `translation_suggestions`,
`translation_seen` (notification/ripple state), and `translation_revisions`.

### `translation_revisions` — attribution

Append-only log: who wrote which body for which chunk and language, when. It exists because the
team needs to trace *when which person translated something using this or that expression*, and
because a git-backed corpus cannot attribute an edit made through the web app. Formatting
decisions deliberately stay **out** of history — they are state, not narrative.

### The arrangement layer (`chunk_layouts`)

`chunk_layouts` rows are `kind IN ('move', 'title')`:

- A **move** is three syllable uuids — `src_start_syl_id`, `src_end_syl_id`, `anchor_syl_id` —
  plus `anchor_after`, `move_mode`, `lang`, `disabled`. It says *read this fragment there*.
- Resolution is per edition: a row with `lang IS NULL` is the **shared basis**, a row for a
  language **overrides** it there, and a `disabled` row for a language **cancels** it there and
  nowhere else. That is exactly what the user asked for: "use the first translation as the
  basis for all subsequent languages, but allow to undo/modify per-language."
- A **title** row is a translation-only heading (`layout_titles` holds its per-language body);
  `render_as = 'small_intro'` prints it as a small-face gloss.

**`moveDisplays(tokens, layouts, lang)` only READS the token array.** Its docstring states the
invariant: *the Tibetan stream is NOT rearranged and the booklet is untouched.* A `'segment'`
move emits a display row carrying the fragment's **real** `startSylId`/`endSylId`, so its
translation still resolves by `rangeKey`.

### The invariant the whole bench rests on

> **The Tibetan and the translation are completely independent, and share only reference
> points.** In the text workspace the translation does not exist. In the translate bench the
> Tibetan is read-only. The bench may rearrange the *reading order of the translation* freely;
> it may never reorder, reflow or renumber the Tibetan.

### Phonetics

Phonetics rows are line-level (`kind` = `bo` Tibetan or `skt` Sanskrit), anchored at the text
that owns the syllables and per booklet language, so they ripple exactly like translations.
Generation is **client-side** (`phonetics/generate.ts`); the router only stores what the
reviewer keeps.

- **`origin_text_id` is not a transclusion test.** A recitation extract's syllables belong to
  its parent, so its rows legitimately anchor there. What says "this line came from another
  text" is the token's own provenance — `EditorToken.source === 'transclusion'`, keyed by
  `(id, op_id)` because the same source may be transcluded twice. That is what "regenerate
  all" uses to leave another text's reviewed wording alone.
- **Replacement rules** (`phonetics/rules.ts`) run over every generated string, in table
  order, at `generateOne` — the single choke point all three generate buttons pass through —
  so what is STORED already carries them and the booklet prints the same text. Per org, per
  kind, per booklet language, ordered (the array's order is the data; there is no `position`
  column). A rule that cannot compile is skipped, never thrown: a half-typed regex must not
  stop the bench.
- **The French Sanskrit conventions live in that table, not in the code.** `sanskrit.ts` used
  to hard-code them (`FR_WORD`, `frenchifyToken`); they are now `DEFAULT_PHONETIC_RULES`, the
  built-in floor an org can edit — the same floor-then-override arrangement as `ORG_BASE` for
  styles. Do not re-add them to `sanskrit.ts`: parity with the old code is asserted in
  `rules.test.ts` and was checked over all 91 real Sanskrit strings in the live corpus.

---

## 7. Documents: text pages and booklets

`documents.kind` is `'textpage' | 'booklet'`.

- An **aligned text page** holds one text plus the expensive hand alignment (page breaks,
  mid-line splits, gaps, block widths). It is an *ingredient*.
- A **booklet** holds furniture (cover, TOC, blank pages, images, back cover) and `'textpage'`
  items that reference text pages by `ref_document_id`. It never contains a bare text.

### Why alignment is reusable at all

`document_layout` is keyed `UNIQUE(document_id, item_id, anchor_syl_id, kind, lang)`. **A
booklet stores its override rows against the TEXT PAGE's item id.** The existing unique key
already permitted that, so the table needed no change:

- `_gathered_layout_rows` returns inherited rows (marked `inherited: true`) with the booklet's
  own rows **shadowing** them at the same key;
- `_item_belongs` had to allow a booklet writing against an item of a text page it reuses, or an
  override could never be placed;
- `extract_text_page(item_id)` moves an item into a new text-page document and rewrites its
  layout rows' `document_id`. **The item id never changes**, so every stored row survives by
  construction. Furniture stays with the **booklet** — a text item's furniture row is its
  table-of-contents title, and the booklet is what has a TOC.

### Furniture

`document_furniture` is per `(item_id, lang, block)`. `block = ''` is the free-form body;
`lang = ''` (`TIBETAN_LANG`) is the Tibetan, which is one string shared by every edition. The
named title blocks are `TITLE_BLOCKS`, and their width keys are deliberately the ones the blocks
had *before* they were named (`#title_sub{n-1}`), so naming them did not move anybody's stored
adjustments.

**An empty slot means "follow the text", not "blank".** `TitleContent` renders
`own && own.trim() ? own : trans[meta.seed]`, and the seed comes from `mainTitleLines`. So on a
cover that follows a text, writing `''` into a slot both erases what was authored there and
prints that text's words in its place. `fillCoverFrom` writes only non-empty values for exactly
this reason; clearing a box to fall back stays the *user's* gesture. The one way to make a blank
slot blank is to leave the cover nothing to follow — below.

### Title pages: the cover and the inner covers

Two nullable columns on `document_items` carry the whole thing. Both mean "as it always was"
when NULL, so a booklet laid out before they existed renders unchanged.

- **`source_item_id`** — on a cover, the aligned text it was filled from (`fillCoverFrom`). It
  says two things: whose title this cover **carries**, and whose inner cover **follows** it.
- **`title_disposition`** — one column read by the two kinds of page that carry a title. On a
  **text**: `'page'` (it has an inner cover) or `'body'` (its title is not lifted and heads its
  first page). On a **cover**: `'own'` — *detached*, seeded from no text at all.

**Everything pivots on `coverSourceItemId`** (`deriveBooklet`): the layout id of the text whose
title the cover carries — the recorded source, else the first text, and `null` when the cover is
detached or the source has left the booklet. It decides both

- `mainTitleLines`, hence every seed `TitleContent` falls back to on the cover — so a detached
  cover has *no* lines and its unauthored slots print blank, which is the only way to get a
  blank there; and
- which texts get an inner cover by default: **every text except the one whose title the cover
  carries.** That used to read "every text but the first", which silently assumed the cover
  follows the first text. Detach the cover and *every* text derives its own title page from its
  own content.

An inner cover is the cover minus the seal: `coverFollowedBy` → `inheritedBodyOf` /
`inheritedGroundOf` resolve each slot, the Tibetan and each block's placement as *own row → the
cover's row → the text's title*, with `#image` deliberately excluded (an inner cover has no
seal) and empty-is-absent throughout, so a cleared field keeps following rather than falling
silently back to the text. Nothing is copied: re-space the cover and the inner cover moves with
it, until you touch that block here, which then diverges alone.

Two gestures that are easily confused, both in the item panel: **detach** ("Its title · its
own") lets the text go and *keeps* the words; **release** *deletes* every authored slot and the
Tibetan and then follows the text again.

### The organization template

Everything a booklet inherits from the house, edited on one page (Admin → the org group in the
sidebar). Two arrangements live here, and confusing them is the trap:

| | Mechanism | Editing it later |
|---|---|---|
| Styles, page geometry, fonts (`style_roles`, `org_layout`, `org_fonts`) | inherited | changes every booklet |
| Cover & back-cover images (`org_seal`, one row per `slot`) | inherited | changes every booklet |
| **Copyright text** (`org_copyright`, one body per language) | **copied** | changes only the NEXT booklet |

**The copyright is a template, not an inheritance.** A booklet's copyright names its own
translator, and a house that republishes an old booklet must not find it silently rewritten. So
the org's body is copied in — by `_seed_copyright` when a `backcover` item is added, and by
"fill from the org template" in that page's panel — and the booklet owns the words from there.
Seeding hangs off the **back cover**, not off document creation: a new booklet has no languages
until they are chosen, so at creation there is nothing to seed for.

**The images are the opposite,** and read as one mechanism with two slots: `'cover'` prints at
the ༀ placeholder, `'backcover'` on the back cover (which has no glyph to fall back to). A
booklet's own image wins in both. `slot` arrived after the fact (`_rebuild_org_seal_slots`), so
every endpoint and client fn defaults to `'cover'` — a caller that names no slot still addresses
the seal it always addressed. The freeze writes the slot into `document_version_asset.ref`,
which was already free text.

**Template variables** resolve in `applyDocVars`, called only from `FurnitureLines` (so: the
back cover and image captions, not titles or body text). `{{version}}` and `{{year}}` are both
**passed in, never computed on the page** — re-rendering a frozen version must reproduce it, and
a page that read the clock would print a different copyright every January. The year is the year
the declared version was declared, falling back to the current year only when there is no
version to reproduce; one rule, applied by `yearOf` on the bench and `_year_of` on the export,
which puts it on the print URL beside `&version=`. An unknown `{{token}}` is left as written.

`GET /api/org-layout` answers the **whole** layout config (defaults ← org geometry), not just
the six editable fields, so the Style Studio can lay a specimen out with no booklet in hand —
`documentId` is optional, and without one the studio locks to org scope.

### Styles and versions

Styles resolve as a three-level cascade: `ORG_BASE` (the complete floor, in `bookletStyles.ts`)
→ org settings → document overrides. `ORG_BASE` must stay complete — there is a test asserting
every role has every field, because a missing field means the browser default leaks into print.

Versions are semver bumps that freeze a per-edition PDF and, at a major tip, a data snapshot
(`document_versions`, `document_version_pdf`, `document_version_snapshot`,
`document_version_asset`), served by a read-only viewer. Rendering runs on a daemon-thread
queue; snapshot capture is synchronous.

---

## 8. The booklet rendering pipeline

```
compileDocument(items, lang)        compile.ts        → DocLine[] + titleByItem + headingsByItem
        ↓
deriveBooklet(...)                  bookletRender.tsx → spreads, bodyUnits, frontMatter,
                                                        backMatter, tocRows, mainTitleLines,
                                                        folioOfLine, navOutline
        ↓
readStream / flowPages              bookletMeasure.ts → page breaks from real measured heights
        ↓
PaginationBench (screen)  /  PrintBooklet (PDF)       → the SAME components
```

**The PDF prints exactly what the bench shows, minus the guides.** There is never a print-only
layout rule: the pagination measures the bench's own components, so a rule that applies to only
one of them makes the two disagree and the page count drift.

### THE ROW CONTRACT — read this before touching anything

A `DocLine` is a **ROW of the printed stream**, and the booklet addresses rows two ways:

- **by INDEX** — page units are index ranges; `renderPageLines` slices *every* column by the
  same `start/end` and derives `globalIdx = start + k` for that line's controls;
- **by ANCHOR** — `anchorOf(l)` = `startSylId#opId` (falling back to `l.key`); every stored
  `page_break`, `hairline`, split, `recto_cut`, `line_space` and `width_*` row is keyed by it.

Therefore:

> **The row stream may NEVER be reordered per side.** Index *i* must be the same line in the
> Tibetan column, the phonetics column and every translation column.

Building the recto as a permutation broke mid-line splits: the split row still resolved to index
*i*, but index *i* was no longer the same line in both columns, so the halves stopped facing
each other. `splitDocLine` cuts the tokens **and** the phonetics/translation of one row — that
is the link between a split on the Tibetan side and the same split on the translation side.

**Moving text is a LIFT, never a shift.** Permuting *payloads* across rows rotates every row
between origin and destination, so each wears its neighbour's text. `phonFor(l)` builds a row's
phonetics from its **own** `sylIds`: phonetics transliterate the Tibetan printed beside them, so
text may never appear against another row's Tibetan. A move spanning 208 syllables misaligned
200 rows that way.

**Only a recto-only row may travel.** `applyMovesToRecto` therefore changes exactly two rows per
move — the donor goes `translation: null`, the destination gets a `borrowed` gloss above its own
text, wrapped in the donor's role classes — and returns **every other row by identity**. It
refuses to move a row that carries Tibetan. `splitDocLine` must drop `borrowed` on the tail or a
split row prints the gloss twice. `components/translate/moves.test.ts` is the regression test:
for every index the recto row's `key`, `startSylId`, `opId` and `tokens` equal the verso row's.

**The precedent that shows this is house style:** the continuation rule in `compile.ts` merges a
small-instructions line's *Tibetan* onto its host row and leaves the instruction's own row with
`tokens: []`, `phonetics: ''` and its translation intact — one row of the stream, verso empty,
recto full, index and anchor untouched.

### THE ID-SPACE TRAP

`DocLine.itemId` does two different jobs: it keys layout rows **and** it joins a line back to its
`DocumentItem`. For a reused text page those are different numbers — the layout id is the text
page's item (`layoutIdOf(it) = it.layout_item_id ?? it.id`), the item id is the booklet's. Every
join must go through `layoutIdOf`. This trap has bitten **five** times so far:

1. `compileDocument`/`deriveBooklet` filtering `it.kind === 'text'` — a resolved textpage item
   has kind `'textpage'`, so the body compiled to **zero lines**. Filter on `text_id != null`.
2. `titleByItem` / `headingsByItem` / `itemStartLine` / `textItems.find` joining on `item.id`.
3. `DocLine.key` embedding `item.id` — `anchorOf` falls back to `key` for syllable-less title
   lines, so rows anchored on those keys stopped resolving and **two page breaks silently
   vanished** (133 → 131 pages with identical line counts).
4. `furnitureBodyOf` — rows written before extraction carry the text page's item id, so it
   resolves **both** ids or the TOC title disappears.
5. `navOutline`'s `itemStartLine.get(it.id)` and `` lineOfSyl.get(`${it.id}:${syl}`) `` — a
   reused text's outline resolved to no page at all.

When you add a sixth join, ask which id-space it is in.

### Pagination bench specifics

- `RENDER_EPOCH` (currently 11) invalidates stored measurements. **Bump it whenever a change
  alters measured geometry**, or stale numbers produce a layout nobody can reproduce.
- Page breaks can be **frozen**: every break is held and auto re-flow is suppressed. Balancing
  edits *are* drift — the user tunes top-down, and a quiet period is the cadence, not a bug.
- **Overview** is a full-screen contact sheet: it hides the rail and the contents sidebar so
  every edition's column fits. `ov-scale` width and `extentOf` scale are the two layout traps
  there. Never shrink the bench's controls to fit the overview scale.
- The rail counts **pages, not items**: only the bench can count physical pages (it needs the
  line stream, the stored breaks and the furniture), so it computes
  `frontMatter + backMatter + Σ(spread ? 2 : 1)` and PUTs it to `documents.page_count`.
  `put_page_count` deliberately does **not** bump `updated_at` — it observes, it does not edit,
  and the document list is sorted by that.
- An aligned text **is** its bench: clicking one opens the layout directly. It has no add bar,
  no `versions`, and no `back` button except in overview.

---

## 9. Development workflow

| Thing | Command / fact |
|---|---|
| Dev stack | `./dev.sh` — backend on **:8001**, vite on 5173/5174 (`:8000` is another project) |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit` — **bare `tsc --noEmit` validates nothing** (solution-style tsconfig) |
| Frontend tests | `npx vitest run` — one pre-existing failure in `bookletStyles.test.ts` (`title_tib.fontWeight`) |
| Backend tests | `cd backend && ./.venv/bin/pytest` |
| Browser checks | `orca-ide` (not `orca`) — clicks often miss React handlers, so drive via `eval` with `.click()` / `requestSubmit()` and a native value setter; wrap evals in an IIFE |
| Auth-free harness | `SAPCHE_AUTH_DISABLED=1` backend on its own port + `VITE_API_BASE` vite pair |

### Verifying against real data — never on the live database

The harness that has caught every layout regression:

1. `sqlite3.connect(live).backup(copy)` into the scratch directory;
2. serve the **copy** with a tiny script that sets `db.DB_PATH` *before* importing `app.main`,
   on its own port, with its own vite;
3. capture a signature — `.print-page` innerText, `.bk-line` / `.booklet-folio` counts, the
   joined `.bk-tibetan` and `.bk-phonetics` sequences;
4. `git stash`, capture the same signature for HEAD, `git stash pop`. **Back to back, same
   method** — captures taken minutes apart mislead.
5. Diff. Both must be byte-identical except the intended difference.

Then tear the harness down and delete the copy.

---

## 10. The mistake catalogue

Each line is a real regression and the rule it produced.

| What broke | Rule |
|---|---|
| Recto built as a permutation → mid-line splits stopped facing each other | Never reorder the row stream per side |
| Payloads rotated between origin and destination → 200 rows wore their neighbour's phonetics | Move is a lift of one recto-only gloss, never a shift |
| Two separate streams for verso and recto → the Tibetan/translation split link died | One stream, one index space |
| Compile stream reordered for the move layer → the Tibetan itself moved | The Tibetan never moves, for any reason |
| `kind === 'text'` filter → a reused text page compiled to zero lines | Filter on `text_id != null` |
| `item.id` joins → vanished page breaks, lost TOC title, empty outline | Join through `layoutIdOf` |
| Empty furniture write → erased authored text *and* printed the other text's title | An empty slot means "follow", not "blank" |
| `UNIQUE(parent_id, position)` → could not add a node to a composed level | Widen the constraint with a `_rebuild_*` migration |
| `PATCH` response without `sort_index` → node jumped to the top | Return computed order fields; refetch after patch |
| `author_id` FK → a bookkeeping insert could abort a user's save | Observers must not be able to fail the thing they observe |
| Vite port missing from the CORS allowlist → login "just failed" | Keep the allowlist in step with the dev ports |

And the meta-rule, which is the only one that would have prevented all of them:

> **Study the load-bearing code before changing it.** Read what is there, find the existing
> mechanism, and confirm what addresses the thing you are about to move — index, anchor, uuid or
> id-space. If the user tells you it worked before, it did; go and find out how.
