import sys
import os
import random
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

from tree_builder import build_initial_tree, concat_tree_text
import copy

def flatten_tree_nodes(node, outlines_only=False):
    """Return all references to child nodes."""
    res = []
    if node["type"] == "outline_node":
        res.append(node)
        
    for c in node["children"]:
        res.extend(flatten_tree_nodes(c, outlines_only))
    return res

def test_randomized_preservation_invariant():
    """
    Simulate a realistic user workflow and check the preservation invariant.
    """
    # 1. Base Text
    raw_text = "Refuge text here. Bodhicitta follows immediately. Then we have a large main block. Finally a long dedication with many words and spaces."
    
    # Random seeds
    for seed in range(50):
        random.seed(seed)
        
        # Create some random spans (non overlapping)
        spans = []
        pointer = 0
        tag_id = 1
        
        while pointer < len(raw_text) - 10:
            if random.random() > 0.5:
                # Add gap
                pointer += random.randint(1, 10)
            else:
                # Add span
                end = min(len(raw_text), pointer + random.randint(5, 15))
                if end > pointer:
                    spans.append({
                        "id": tag_id,
                        "start": pointer,
                        "end": end,
                        "name": f"Tag-{tag_id}",
                    })
                    tag_id += 1
                pointer = end

        # Rebuild tree
        tree = build_initial_tree(raw_text, spans)
        
        # Apply N random UI operations
        for _ in range(10):
            assert concat_tree_text(tree) == raw_text
            
            # Ops: 
            # 1. Drag outline to new parent
            # 2. Untag outline
            op = random.choice(["drag", "untag"])
            
            all_outlines = flatten_tree_nodes(tree, outlines_only=True)
            if not all_outlines:
                break
                
            if op == "untag":
                node_to_untag = random.choice(all_outlines)
                
                # find parent
                def find_parent(n, target_id):
                    for c in n["children"]:
                        if c["id"] == target_id:
                            return n
                        p = find_parent(c, target_id)
                        if p: return p
                    return None
                
                parent = find_parent(tree, node_to_untag["id"])
                if parent:
                    idx = next(i for i, c in enumerate(parent["children"]) if c["id"] == node_to_untag["id"])
                    
                    residual = {
                        "id": f"res_{random.randint(1000, 9999)}",
                        "type": "residual_text",
                        "text": node_to_untag["text"],
                        "start": node_to_untag["start"],
                        "end": node_to_untag["end"],
                        "children": []
                    }
                    
                    # Splice: replace node with its text + promote its children
                    new_children = [residual] + node_to_untag["children"]
                    parent["children"] = parent["children"][:idx] + new_children + parent["children"][idx+1:]
                    
            elif op == "drag":
                node_to_drag = random.choice(all_outlines)
                
                # Cannot drag into self or descendant
                descendants = [n["id"] for n in flatten_tree_nodes(node_to_drag, outlines_only=True)]
                
                # Find valid target
                valid_targets = [tree] + [n for n in all_outlines if n["id"] != node_to_drag["id"] and n["id"] not in descendants]
                if not valid_targets:
                    continue
                    
                target = random.choice(valid_targets)
                
                def find_parent(n, target_id):
                    for c in n["children"]:
                        if c["id"] == target_id:
                            return n
                        p = find_parent(c, target_id)
                        if p: return p
                    return None
                    
                parent = find_parent(tree, node_to_drag["id"])
                if parent:
                    idx = next(i for i, c in enumerate(parent["children"]) if c["id"] == node_to_drag["id"])
                    
                    node_copy = copy.deepcopy(node_to_drag)
                    # remove from old
                    del parent["children"][idx]
                    
                    # insert to new (append)
                    target["children"].append(node_copy)
                    
        # Final validation
        assert concat_tree_text(tree) == raw_text
