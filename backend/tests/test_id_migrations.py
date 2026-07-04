"""UUID-change report: the removed->successor diff that prevents webapp orphans.

Run: `venv/bin/python tests/test_id_migrations.py`
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.exporters.id_migrations_exporter import _diff_sequence, _diff_scope


def S(uuid, text, group_key=None):
    return {"uuid": uuid, "text": text, "group_key": group_key}


def test_merge_remaps_punctuation_to_survivor():
    # ། \xa0 ། -> ། །   (two punct tokens dropped, both remap onto the merged token A)
    old = [S('A', '།'), S('B', '\xa0'), S('C', '།'), S('W', 'དང་')]
    new = [S('A', '། །'), S('W', 'དང་')]
    removed, added = _diff_sequence(old, new)
    assert {r['old_uuid'] for r in removed} == {'B', 'C'}
    assert all(r['successor_uuid'] == 'A' for r in removed)
    assert added == []


def test_unchanged_is_empty():
    seq = [S('A', 'ཀ'), S('B', 'ཁ'), S('C', '། །')]
    removed, added = _diff_sequence(seq, seq)
    assert removed == [] and added == []


def test_word_syllables_never_removed_on_punct_merge():
    old = [S('w1', 'ཐོག་'), S('p1', '།'), S('s', ' '), S('p2', '།'), S('w2', 'མར་')]
    new = [S('w1', 'ཐོག་'), S('p1', '། །'), S('w2', 'མར་')]
    removed, added = _diff_sequence(old, new)
    removed_ids = {r['old_uuid'] for r in removed}
    assert 'w1' not in removed_ids and 'w2' not in removed_ids  # words keep identity
    # the dropped space/second-shad remap onto a surviving neighbour
    assert all(r['successor_uuid'] in {'p1', 'w1', 'w2'} for r in removed)


def test_insertion_is_added_not_removed():
    old = [S('A', 'ཀ'), S('B', 'ཁ')]
    new = [S('A', 'ཀ'), S('N', 'ག'), S('B', 'ཁ')]
    removed, added = _diff_sequence(old, new)
    assert removed == [] and added == ['N']


def test_diff_scope_aligns_per_group_and_flattens():
    # transcript: two sessions; a merge in session B only. Output is flat (uuids global).
    old = [S('a', 'ཀ', 'A1'), S('p', '།', 'B1'), S('q', '\xa0', 'B1'), S('r', '།', 'B1')]
    new = [S('a', 'ཀ', 'A1'), S('p', '། །', 'B1')]
    out = _diff_scope(old, new)
    assert {r['old_uuid'] for r in out['removed']} == {'q', 'r'}
    assert all(r['successor_uuid'] == 'p' for r in out['removed'])
    assert out['added'] == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
