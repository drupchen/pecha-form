# pecha-form — working rules

**Read `docs/ARCHITECTURE.md` before changing anything in the booklet pipeline, the translate
bench, the sapche tree, or the derivation layer.** It records the invariants and, for each one,
the regression that taught it.

## The rules that are most often broken

1. **Study the load-bearing code first.** Find the existing mechanism before designing a
   replacement. If the user says a behaviour worked before, it did — locate it
   (`git log -S'<symbol>' -- <path>`) rather than concluding it was never built.
2. **Syllable uuids are the only anchors.** No annotation stores character offsets; offsets are
   derived on read. Editing text must preserve ids (`app/id_reconcile.py`).
3. **The Tibetan never moves.** The translate bench may rearrange the reading order of a
   *translation*; it may never reorder, reflow or renumber the Tibetan stream.
4. **A `DocLine` is a ROW, addressed by index AND by anchor.** The row stream may never be
   reordered per side — index *i* must be the same line in every column. Moving text is a lift
   of one recto-only gloss (`applyMovesToRecto`), never a shift of payloads.
5. **Mind the id-space.** `DocLine.itemId` both keys layout rows and joins to a `DocumentItem`;
   for a reused text page those are different numbers. Join through `layoutIdOf`.
6. **The PDF prints what the bench shows.** Never add a print-only layout rule — the pagination
   measures the bench's own components.
7. **Secondaries inherit live, they never copy** (`app/inherit.py`). Edit the owner; the ripple
   is re-baking with stable uuids.
8. **Never test against `backend/sapche.db`.** Copy it, serve the copy on its own port, verify
   there, delete the copy. See the harness in `docs/ARCHITECTURE.md` §9.

## Finishing a piece of work

**Commit and push it — always, without being asked.** Once the change is verified (typecheck,
both suites, and the browser check when it touches the UI), commit it and push to `main`. Do
not leave finished work sitting uncommitted, and do not ask first.

- Split it by strand rather than dumping a session into one commit: separate commits for
  separate features or fixes, even when that means staging a shared file hunk by hunk.
- The commit message says WHY, and records what was measured — the numbers that prove it
  (page counts, corpus parity, test totals), so a later reader can tell verification from
  assertion.
- Never commit `backend/sapche.db` or a scratch copy of it (it is gitignored; keep it so).

## Commands

```bash
./dev.sh                                    # backend :8001 + vite :5173
cd frontend && npx tsc -p tsconfig.app.json --noEmit   # bare `tsc --noEmit` checks NOTHING
cd frontend && npx vitest run               # 1 known failure: bookletStyles title_tib.fontWeight
cd backend  && ./.venv/bin/pytest
```

Browser verification uses `orca-ide`; its clicks often miss React handlers, so drive the page
with `eval` + `.click()` / `requestSubmit()` and a native value setter.
