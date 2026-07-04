"""Stable token-id reconciliation.

The token uuid is the skeleton everything else hangs off (segments, spans,
audio links, future corrections). It must survive editing a token's *text*:
editing keeps the id, inserting mints a new one, deleting drops it — never a
wholesale re-mint that would break saved references.

``assign_stable_ids`` aligns the previously-stored token sequence with a freshly
tokenised one (via the move-aware ``token_align.align_tokens``) and carries the old
ids across:

- equal     → same text, same place → preserve id
- move      → same text, relocated  → preserve id (so inverting / displacing
              syllables keeps their identity, not just position-preserving edits)
- replace   → text changed in place → preserve id (identity kept through the edit)
- insert    → genuinely new → mint
- delete    → stored token with no counterpart → drop

On first ingest (no stored tokens) the caller's freshly-minted ids are kept as
the initial persistent ids ("freeze"), so existing published ids never churn.
"""

import uuid

from .token_align import align_tokens


def new_id() -> str:
    """A fresh, identity-only token id (decoupled from index and text)."""
    return str(uuid.uuid4())


def assign_stable_ids(existing: list[dict], fresh: list[dict], mint=new_id) -> list[dict]:
    """Carry ids from ``existing`` onto ``fresh`` by aligning their text sequences.

    existing: [{'id', 'text'}] in order (the stored tokens)
    fresh:    [dict] in order, each already carrying a freshly-minted 'id' that is
              OVERWRITTEN here when a stored id can be preserved.
    Returns ``fresh`` (mutated in place).
    """
    if not existing:
        return fresh  # first ingest: keep the caller's freshly-minted ids

    old_texts = [e["text"] for e in existing]
    new_texts = [f["text"] for f in fresh]

    for op in align_tokens(old_texts, new_texts, detect_moves=True):
        if op.kind in ("equal", "move", "replace"):
            fresh[op.new]["id"] = existing[op.old]["id"]
        elif op.kind == "insert":
            fresh[op.new]["id"] = mint()
        # 'delete': stored token with no counterpart simply disappears
    return fresh
