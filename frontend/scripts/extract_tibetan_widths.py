#!/usr/bin/env python3
"""Extract per-codepoint advance widths for the Tibetan Unicode block
from a TrueType / OpenType font file, normalize to "ba-units" (where
1.0 = advance width of བ U+0F56), and emit a human-readable JSON table.

Used to generate `src/lib/tibetan-widths.<font>.json`. Re-run whenever you
want to support a new Tibetan font: feed in the font file and a new
output filename, then point the lib at the new JSON.

Requires: fontTools (`pip install fonttools`).

Usage:
    python3 scripts/extract_tibetan_widths.py \
        --font /path/to/Jomolhari-Regular.ttf \
        --name Jomolhari \
        --out src/lib/tibetan-widths.jomolhari.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

TIBETAN_START = 0x0F00
TIBETAN_END = 0x0FFF
BA = 0x0F56  # calibration anchor (Tibetan)
LATIN_A = 0x0061  # secondary calibration: how wide is the font's Latin 'a'?


def collapse_ranges(codepoints: list[int]) -> list[list[str]]:
    """Collapse a sorted list of codepoints into [start_hex, end_hex] ranges."""
    if not codepoints:
        return []
    ranges: list[list[int]] = []
    start = end = codepoints[0]
    for cp in codepoints[1:]:
        if cp == end + 1:
            end = cp
        else:
            ranges.append([start, end])
            start = end = cp
    ranges.append([start, end])
    return [[f"{a:04X}", f"{b:04X}"] for a, b in ranges]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--font", required=True, help="Path to .ttf / .otf file")
    ap.add_argument("--name", required=True, help="Logical font name (e.g. 'Jomolhari')")
    ap.add_argument("--out", required=True, help="Output JSON path")
    args = ap.parse_args()

    font = TTFont(args.font)
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    units_per_em = font["head"].unitsPerEm

    ba_glyph = cmap.get(BA)
    if ba_glyph is None:
        sys.exit(f"Font lacks U+{BA:04X} (བ); cannot calibrate.")
    ba_advance, _ = hmtx[ba_glyph]
    if ba_advance <= 0:
        sys.exit(f"Anchor glyph has non-positive advance ({ba_advance}); cannot calibrate.")

    widths: dict[str, float] = {}
    combining: list[int] = []

    for cp in range(TIBETAN_START, TIBETAN_END + 1):
        glyph = cmap.get(cp)
        if glyph is None:
            continue
        adv, _ = hmtx[glyph]
        if adv == 0:
            combining.append(cp)
        else:
            widths[f"{cp:04X}"] = round(adv / ba_advance, 4)

    # Latin 'a' advance, expressed in ba-units. Lets the lib convert a
    # caller-measured contextual 'a' width (in px) into Tibetan ba-units →
    # then into pixels — without assuming width(a) ≈ width(བ).
    latin_a_glyph = cmap.get(LATIN_A)
    latin_a_in_ba_units: float | None = None
    if latin_a_glyph is not None:
        a_adv, _ = hmtx[latin_a_glyph]
        if a_adv > 0:
            latin_a_in_ba_units = round(a_adv / ba_advance, 4)

    data = {
        "font": args.name,
        "version": 1,
        "source": Path(args.font).name,
        "unitsPerEm": units_per_em,
        "calibration": {
            "anchorCodepoint": f"{BA:04X}",
            "anchorChar": chr(BA),
            "anchorAdvance": ba_advance,
            "unit": "ba-units (1.0 = advance width of བ)",
            "latinAInBaUnits": latin_a_in_ba_units,
            "latinAInBaUnitsNote": (
                "Width of the font's Latin 'a' expressed in ba-units. "
                "Multiply a contextually-measured 'a' pixel width by 1/latinAInBaUnits "
                "to get px-per-ba-unit. Null if the font lacks a Latin 'a' glyph."
            ),
        },
        "combiningRanges": collapse_ranges(sorted(combining)),
        "widths": dict(sorted(widths.items())),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Wrote {out_path}: {len(widths)} spacing widths, "
        f"{sum(b - a + 1 for a, b in [[int(x,16) for x in r] for r in data['combiningRanges']])} "
        f"combining codepoints, anchor advance={ba_advance} / {units_per_em} em."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
