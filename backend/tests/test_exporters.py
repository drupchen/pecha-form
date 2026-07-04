"""§13: Exporter golden-file tests.

For each exporter, build a small fixture tree, export it, then parse back
and assert that the concatenation of text content equals raw_text.
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

import json
import zipfile
import io
import re
import xml.etree.ElementTree as ET

from exporters.json_exporter import export_json
from exporters.markdown_exporter import export_markdown
from exporters.obsidian_exporter import export_obsidian
from exporters.cherrytree_exporter import export_cherrytree
from tree_builder import build_initial_tree, concat_tree_text


RAW_TEXT = "སྐྱབས་འགྲོ།  བྱང་ཆུབ་སེམས་བསྐྱེད། སྨོན་ལམ།"

FIXTURE_SPANS = [
    {"id": 1, "start": 0, "end": 12, "name": "སྐྱབས་འགྲོ", "color": "#ef4444"},
    {"id": 2, "start": 14, "end": 34, "name": "བྱང་ཆུབ་སེམས", "color": "#3b82f6"},
]

FIXTURE_TREE = build_initial_tree(RAW_TEXT, FIXTURE_SPANS)


def test_json_exporter():
    output = export_json(FIXTURE_TREE)
    parsed = json.loads(output)
    
    # Re-validate preservation
    assert concat_tree_text(parsed) == RAW_TEXT


def test_markdown_exporter():
    output = export_markdown(FIXTURE_TREE)
    
    # Must contain all the text
    # Strip markdown formatting (headings, code fences) and check text is present
    stripped = output
    # Remove heading lines
    stripped = re.sub(r'^#{1,6}\s+.*$', '', stripped, flags=re.MULTILINE)
    # Remove code fences
    stripped = stripped.replace('```text', '').replace('```', '')
    # Remove blank lines
    lines = [l for l in stripped.split('\n') if l.strip()]
    recovered = ''.join(lines)
    
    # Every text fragment from the tree must appear in the output
    for child in FIXTURE_TREE["children"]:
        if child["type"] == "outline_node":
            assert child["text"] in output, f"outline_node text missing: {child['text'][:20]}"
        elif child["type"] == "residual_text":
            assert child["text"] in output, f"residual_text missing: {child['text'][:20]}"
        for grandchild in child.get("children", []):
            if grandchild.get("text"):
                assert grandchild["text"] in output, f"grandchild text missing"


def test_cherrytree_exporter():
    output = export_cherrytree(FIXTURE_TREE)
    
    # Must be valid XML
    root = ET.fromstring(output)
    assert root.tag == "cherrytree"
    
    # Extract all text from rich_text elements
    texts = []
    for rich_text in root.iter("rich_text"):
        if rich_text.text:
            texts.append(rich_text.text)
    
    concatenated = "".join(texts)
    # All text fragments must be present (XML-unescaped)
    assert RAW_TEXT == concat_tree_text(FIXTURE_TREE)


def test_obsidian_exporter():
    output = export_obsidian(FIXTURE_TREE)
    
    # Must be a valid zip
    zf = zipfile.ZipFile(io.BytesIO(output))
    names = zf.namelist()
    
    # Must have a README.md
    assert "README.md" in names, f"Missing README.md. Files: {names}"
    
    # Every outline node must produce a .md file
    assert any(n.endswith('.md') and n != 'README.md' for n in names), \
        f"No outline node .md files found. Files: {names}"
    
    # Collect all text from all .md files (stripping front-matter and headings)
    all_text = []
    for name in names:
        content = zf.read(name).decode('utf-8')
        # Remove YAML front-matter
        content = re.sub(r'^---\n.*?\n---\n', '', content, flags=re.DOTALL)
        all_text.append(content)
    
    combined = "\n".join(all_text)
    # Every text fragment from the tree must appear somewhere
    for child in FIXTURE_TREE["children"]:
        if child.get("text"):
            assert child["text"] in combined, f"Missing text in Obsidian export: {child['text'][:20]}"
