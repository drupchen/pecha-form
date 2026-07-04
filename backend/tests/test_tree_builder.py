import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

from tree_builder import build_initial_tree, concat_tree_text
import pytest

def test_tree_builder_no_spans():
    raw_text = "This is a simple text with no elements."
    spans = []
    tree = build_initial_tree(raw_text, spans)
    
    assert concat_tree_text(tree) == raw_text
    assert len(tree["children"]) == 1
    assert tree["children"][0]["type"] == "residual_text"

def test_tree_builder_adjacent_spans():
    raw_text = "Hello World"
    # "Hello" -> start: 0, end: 5
    # " World" -> start: 5, end: 11
    spans = [
        {"id": 1, "start": 0, "end": 5, "name": "tag1", "color": "#000"},
        {"id": 2, "start": 5, "end": 11, "name": "tag2", "color": "#111"}
    ]
    tree = build_initial_tree(raw_text, spans)
    
    assert concat_tree_text(tree) == raw_text
    # 2 children under text: the two outlines. No residual text because there are no gaps.
    assert len(tree["children"]) == 2
    assert tree["children"][0]["type"] == "outline_node"
    assert tree["children"][1]["type"] == "outline_node"

def test_tree_builder_gap():
    raw_text = "GapBeforeSpan1 GapBetween Span2 GapAfter"
    spans = [
        {"id": 1, "start": 9, "end": 14, "name": "tag1", "color": "#000"},
        {"id": 2, "start": 26, "end": 31, "name": "tag2", "color": "#000"},
    ]
    tree = build_initial_tree(raw_text, spans)
    
    assert concat_tree_text(tree) == raw_text
    
    # "GapBefore" is residual directly beneath text Root (or first element).
    # Wait, the spec says residual text *between* span k and k+1 becomes child of span k.
    # GapBefore is before everything. It goes to root.
    
    assert tree["children"][0]["type"] == "residual_text"
    assert tree["children"][0]["text"].startswith("GapBefore")

    assert tree["children"][1]["type"] == "outline_node"
    assert tree["children"][1]["text"] == "Span1"
    
    # GapBetween goes to Span1
    assert len(tree["children"][1]["children"]) == 1
    assert tree["children"][1]["children"][0]["type"] == "residual_text"
    assert tree["children"][1]["children"][0]["text"].startswith(" GapBetween")

def test_overlap_rejected():
    raw_text = "Overlap me"
    spans = [
        {"id": 1, "start": 0, "end": 5, "name": "t1"},
        {"id": 2, "start": 3, "end": 8, "name": "t2"}
    ]
    with pytest.raises(ValueError):
        build_initial_tree(raw_text, spans)
