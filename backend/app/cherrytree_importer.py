"""Import a CherryTree (.ctd) XML file into the Sapche data model.

Mapping:
    Per CherryTree <node>: one tree_node. Text-bearing nodes get their
    `segment_start` set to the offset where that node's rich_text starts in
    the concatenated raw_text. Markers are inserted between consecutive
    text-bearing nodes so each node's content becomes its own segment.

    Per <rich_text> element:
        scale="h1"                              -> 'title'
        underline="single"                      -> 'sapche-text'
        style="italic"                          -> 'quote-meta'
        style="italic" weight="heavy"           -> 'quote'
        strikethrough="true"                    -> 'verse'

A single rich_text element may produce multiple annotation spans
(e.g. strikethrough+italic = verse + quote-meta, two overlapping highlights).

Tree structure: every CherryTree <node> becomes a tree_node whose title is the
node's `name` attribute. Text-bearing nodes additionally carry a `segment_start`
so the workspace's link overlay and click-to-scroll work for them.

NFC normalization is applied per-chunk to avoid offset shifts.
"""

import os
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
import json
from typing import Optional

from .db import get_db
from .tokenizer import tokenize_tibetan, normalize_spaces, fold_punct_newlines


# Tag definitions keyed by a stable internal identifier
TAG_DEFS: dict[str, dict] = {
    'title':       {'name': 'title',       'color': '#6366f1'},
    'sapche-text': {'name': 'sapche-text', 'color': '#22c55e'},
    'quote-meta':  {'name': 'quote-meta',  'color': '#06b6d4'},
    'quote':       {'name': 'quote',       'color': '#3b82f6'},
    'verse':       {'name': 'verse',       'color': '#f59e0b'},
}


def _detect_tag_keys(attrs: dict[str, str]) -> list[str]:
    """Return the internal tag keys this <rich_text> element matches.

    italic and italic+bold are mutually exclusive: bold takes precedence.
    """
    keys: list[str] = []
    if attrs.get('scale') == 'h1':
        keys.append('title')
    if attrs.get('underline') == 'single':
        keys.append('sapche-text')
    is_italic = attrs.get('style') == 'italic'
    is_bold = attrs.get('weight') == 'heavy'
    if is_italic and is_bold:
        keys.append('quote')
    elif is_italic:
        keys.append('quote-meta')
    if attrs.get('strikethrough') == 'true':
        keys.append('verse')
    return keys


def import_cherrytree(xml_bytes: bytes, filename: str, title_override: Optional[str] = None) -> int:
    """Parse a .ctd file and create a new text with tags, spans and tree_nodes.

    Returns the new text_id.
    """
    # ─── Parse XML ────────────────────────────────────────────────────────────
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise ValueError(f"Invalid XML: {e}")

    title = title_override or os.path.splitext(os.path.basename(filename))[0] or 'Imported text'

    # ─── Walk the tree, collect text + spans + markers + tree-node descriptors ─
    text_chunks: list[str] = []
    cursor_offset = 0
    pending_spans: list[tuple[int, int, str]] = []  # (start, end, tag_key) — inline annotations
    pending_markers: list[int] = []                  # offsets between consecutive nodes' content
    tree_node_specs: list[dict] = []
    sibling_counters: dict[Optional[str], int] = {}
    # ct_id -> [start_of_first_rich_text, end_of_last_rich_text]
    # Only text-bearing nodes appear here; the start becomes the node's segment_start.
    node_text_ranges: dict[str, list[int]] = {}

    # Tracks which CherryTree node contributed the most recently appended text.
    last_text_ct_id: Optional[str] = None

    def append_text(text: str) -> tuple[int, int]:
        nonlocal cursor_offset
        if not text:
            return cursor_offset, cursor_offset
        norm = unicodedata.normalize('NFC', text)
        start = cursor_offset
        text_chunks.append(norm)
        cursor_offset += len(norm)
        return start, cursor_offset

    def walk(node_elem: ET.Element, parent_ct_id: Optional[str]) -> None:
        nonlocal last_text_ct_id

        ct_id = node_elem.get('unique_id', '') or str(id(node_elem))
        name = node_elem.get('name', '') or '(untitled)'
        pos = sibling_counters.setdefault(parent_ct_id, 0)
        sibling_counters[parent_ct_id] = pos + 1
        tree_node_specs.append({
            'ct_id': ct_id,
            'parent_ct_id': parent_ct_id,
            'title': name,
            'position': pos,
        })

        for child in node_elem:
            if child.tag == 'rich_text':
                content = child.text or ''
                if not content:
                    continue
                # Transition between nodes: insert separator + marker so each node's
                # content becomes its own segment card in the tagger UI.
                if last_text_ct_id is not None and last_text_ct_id != ct_id:
                    append_text('\n')
                    pending_markers.append(cursor_offset)  # right after the '\n'
                start, end = append_text(content)
                if end <= start:
                    continue
                # Record per-node text extent (extend on every append).
                if ct_id not in node_text_ranges:
                    node_text_ranges[ct_id] = [start, end]
                else:
                    node_text_ranges[ct_id][1] = end
                # Annotation spans from rich_text attributes.
                tag_keys = _detect_tag_keys(child.attrib)
                for k in tag_keys:
                    pending_spans.append((start, end, k))
                last_text_ct_id = ct_id
            elif child.tag == 'node':
                walk(child, ct_id)

    for top in root.findall('node'):
        walk(top, None)

    raw_text = ''.join(text_chunks)
    if not raw_text:
        raise ValueError("CherryTree file contains no text content")
    # Fold Unicode spaces (U+00A0 etc.) to U+0020 so botok joins punctuation
    # clusters. Length-preserving (1:1), so the span offsets collected above into
    # the concatenated text stay valid. (NFC is intentionally not applied here —
    # it can change length and would shift those offsets.)
    raw_text = fold_punct_newlines(normalize_spaces(raw_text))

    units = tokenize_tibetan(raw_text)

    # ─── Write to DB ──────────────────────────────────────────────────────────
    conn = get_db()
    cursor = conn.cursor()
    try:
        # Text
        cursor.execute(
            "INSERT INTO texts (filename, title, source_text, raw_text, units_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                filename,
                title,
                raw_text,                                 # source_text = raw_text on import
                raw_text,
                json.dumps([[s, e, raw_text[s:e]] for s, e in [(u[0], u[1]) for u in units]], ensure_ascii=False),
            ),
        )
        text_id = cursor.lastrowid

        # Tags: created only if used by some rich_text attribute combination.
        used_tag_keys: set[str] = {k for _, _, k in pending_spans}
        tag_id_by_key: dict[str, int] = {}
        for key in used_tag_keys:
            t = TAG_DEFS[key]
            cursor.execute(
                "INSERT INTO tags (text_id, name, color) VALUES (?, ?, ?)",
                (text_id, t['name'], t['color']),
            )
            tag_id_by_key[key] = cursor.lastrowid

        # Inline annotation spans (per rich_text attributes)
        for start, end, key in pending_spans:
            cursor.execute(
                "INSERT INTO spans (text_id, tag_id, start_offset, end_offset) VALUES (?, ?, ?, ?)",
                (text_id, tag_id_by_key[key], start, end),
            )

        # Markers — one between every consecutive pair of nodes' text content,
        # so each node's text becomes its own segment card in the tagger UI.
        # De-duplicate defensively (UNIQUE constraint).
        for pos in sorted(set(pending_markers)):
            if 0 < pos < len(raw_text):
                cursor.execute(
                    "INSERT OR IGNORE INTO markers (text_id, position) VALUES (?, ?)",
                    (text_id, pos),
                )

        # Tree nodes: parent resolution + segment_start wiring for text-bearing nodes
        ct_to_node_id: dict[str, int] = {}
        for spec in tree_node_specs:
            parent_id = ct_to_node_id.get(spec['parent_ct_id']) if spec['parent_ct_id'] else None
            text_range = node_text_ranges.get(spec['ct_id'])  # None for empty nodes
            segment_start = text_range[0] if text_range else None
            cursor.execute(
                "INSERT INTO tree_nodes (text_id, parent_id, position, title, segment_start, transparent) "
                "VALUES (?, ?, ?, ?, ?, 0)",
                (text_id, parent_id, spec['position'], spec['title'], segment_start),
            )
            ct_to_node_id[spec['ct_id']] = cursor.lastrowid

        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        conn.close()
        raise
    conn.close()
    return text_id
