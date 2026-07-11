"""Phase 1: yig-mgo detection + main-text portion gap attribution.

Run: `venv/bin/python tests/test_attribution.py`
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.tokenizer import is_yigmgo, split_text_at_yigmgo, tokenize_tibetan
from app.manifest import generate_syllables
from app.main_text_align import attribute_gaps, snap_section_boundary


def _syls():
    # ཀ(0-3) ཁ(3-6) །(6-7) ག(7-10) ༅ (10-12) ང(12-15)
    rows = [(0, 3, 'ཀ', 'TEXT'), (3, 6, 'ཁ', 'TEXT'), (6, 7, '།', 'PUNCT'),
            (7, 10, 'ག', 'TEXT'), (10, 12, '༅ ', 'PUNCT'), (12, 15, 'ང', 'TEXT')]
    return [{'start_offset': s, 'end_offset': e, 'text': t, 'nature': n} for s, e, t, n in rows]


CUES = [{'seg_id': 1}, {'seg_id': 2}, {'seg_id': 3}]


def test_is_yigmgo():
    assert is_yigmgo('༄༅ ') and is_yigmgo('༅')
    assert is_yigmgo('༄༅། །')  # opening flourish: leads with yig-mgo, trailing shads OK
    assert is_yigmgo('༼')       # U+0F3C gug rtags gyon: an opening mark, joins the following
    assert not is_yigmgo('། །') and not is_yigmgo('ཀ') and not is_yigmgo('༄ ཨ')


def test_split_text_at_yigmgo():
    assert split_text_at_yigmgo('།། །། ༄༅། །') == ['།། །། ', '༄༅། །']  # closing | opening
    assert split_text_at_yigmgo('༄༅། །') == ['༄༅། །']  # already leads with yig-mgo
    assert split_text_at_yigmgo('། །') == ['། །']        # no yig-mgo
    assert split_text_at_yigmgo('༔ ༼') == ['༔ ', '༼']    # opening bracket starts its own syllable


def test_opening_bracket_starts_its_own_syllable():
    # ``༔ ༼`` must tokenize as two PUNCT syllables, the second starting at ༼.
    syls = generate_syllables('ཨོཾ༔ ༼ཞེས', 'i')
    texts = [s['text'] for s in syls]
    assert '༔ ' in texts and '༼' in texts
    assert ''.join(texts) == 'ཨོཾ༔ ༼ཞེས'  # still tiles exactly
    i = texts.index('༼')
    assert syls[i - 1]['text'] == '༔ '     # the ༔ (with its space) is the preceding syllable


def test_both_tokenizers_split_at_yigmgo():
    raw = 'ཀ།། །། ༄༅། །ཁ'
    uuid_layer = [s['text'] for s in generate_syllables(raw, 'i')]
    units = [u[2] for u in tokenize_tibetan(raw)]
    assert uuid_layer == units                                  # the two layers agree
    assert '།། །། ' in uuid_layer and '༄༅། །' in uuid_layer     # cluster split in two
    assert ''.join(uuid_layer) == raw                           # still tiles exactly


def test_adjacent_gap_folds_into_preceding():
    m = [{'seg_id': 1, 'start_offset': 0, 'end_offset': 6},
         {'seg_id': 2, 'start_offset': 7, 'end_offset': 10}]
    attribute_gaps(m, _syls(), CUES, 0, 10)
    assert m[0]['end_offset'] == 7 and m[1]['start_offset'] == 7  # '།' joined cue 1


def test_leading_yigmgo_joins_following():
    m = [{'seg_id': 1, 'start_offset': 0, 'end_offset': 6},
         {'seg_id': 2, 'start_offset': 12, 'end_offset': 15}]
    attribute_gaps(m, _syls(), CUES, 0, 15)
    assert m[0]['end_offset'] == 10 and m[1]['start_offset'] == 10  # ༅ stays with cue 2


def test_snap_section_boundary_pulls_back_leading_yigmgo():
    # ག(7-10) ༅ (10-12) ང(12-15): a section boundary placed at the recited text (12,
    # start of ང) must pull back over the leading yig-mgo so the head mark introduces —
    # and joins — the following section. Same offsets stay put when no yig-mgo precedes.
    syls = _syls()
    starts = [s["start_offset"] for s in syls]
    assert snap_section_boundary(12, syls, starts) == 10   # ༅  joins the following section
    assert snap_section_boundary(7, syls, starts) == 7     # plain text boundary unchanged
    assert snap_section_boundary(11, syls, starts) == 10   # offset inside ༅  → its start


def test_unmatched_middle_cue_leaves_gap():
    m = [{'seg_id': 1, 'start_offset': 0, 'end_offset': 3},
         {'seg_id': 3, 'start_offset': 12, 'end_offset': 15}]
    attribute_gaps(m, _syls(), CUES, 0, 15)
    assert m[0]['end_offset'] == 3  # gap (cue 2 region) left open → coverage warning


def test_head_tail_extend_when_first_last_cue_matched():
    m = [{'seg_id': 1, 'start_offset': 3, 'end_offset': 6},
         {'seg_id': 3, 'start_offset': 7, 'end_offset': 12}]
    # cues here are 1..3; first(1) and last(3) matched → head→open(0), tail→close(15)
    attribute_gaps(m, _syls(), CUES, 0, 15)
    assert m[0]['start_offset'] == 0 and m[-1]['end_offset'] == 15


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
