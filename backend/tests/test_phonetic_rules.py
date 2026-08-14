"""Replacement rules for generated phonetics.

The rules are house spellings applied to every generated string — ordered, per kind and per
booklet language, shared by the whole organization. The router only keeps the lists: generation
and application are client-side, which is why there is nothing here about what a rule DOES.

What matters at this layer: the ORDER survives a round trip (dragging a rule up is the whole
point), the four lists a language can have stay apart, and one org never sees another's.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

import pytest  # noqa: E402
from app.db import init_db, get_db  # noqa: E402
from app.routers.phonetics import (  # noqa: E402
    PhoneticRuleIn, PhoneticRuleListIn, PhoneticStyleIn,
    list_phonetic_rules, put_phonetic_rules, list_phonetic_styles, put_phonetic_style,
)

init_db()

ORG = 1
OTHER_ORG = 2


def _org2():
    conn = get_db()
    try:
        conn.execute("INSERT OR IGNORE INTO organizations (id, name) VALUES (?, 'Other')",
                     (OTHER_ORG,))
        conn.commit()
    finally:
        conn.close()


def _rule(find, replace, regex=False, note=""):
    return PhoneticRuleIn(find=find, replace=replace, regex=regex, note=note)


def _put(kind, lang, rules, org=ORG):
    return put_phonetic_rules(
        PhoneticRuleListIn(kind=kind, lang=lang, rules=rules), org_id=org)


def _get(kind, lang, org=ORG):
    for lst in list_phonetic_rules(org_id=org):
        if lst.kind == kind and lst.lang == lang:
            return lst.rules
    return None


def test_the_order_is_the_data():
    order = [_rule("u", "ou", regex=True, note="systematic"),
             _rule("Poudja", "Pudja"),
             _rule("Pema", "Péma")]
    _put("skt", "fr", order)
    assert [r.find for r in _get("skt", "fr")] == ["u", "Poudja", "Pema"]

    # Dragging a rule to the top is saving the list again — and it must come back that way,
    # because a later rule sees what the earlier ones produced.
    _put("skt", "fr", [order[2], order[0], order[1]])
    got = _get("skt", "fr")
    assert [r.find for r in got] == ["Pema", "u", "Poudja"]
    # Every field survives, `regex` included.
    assert got[1].regex is True and got[1].note == "systematic"
    assert got[0].regex is False


def test_each_kind_and_language_keeps_its_own_list():
    _put("skt", "de", [_rule("Hung", "Hung")])
    _put("bo", "de", [_rule("ö", "oe")])
    _put("bo", "pt", [_rule("ph", "f")])
    assert [r.find for r in _get("skt", "de")] == ["Hung"]
    assert [r.find for r in _get("bo", "de")] == ["ö"]
    assert [r.find for r in _get("bo", "pt")] == ["ph"]


def test_an_untouched_list_is_absent_rather_than_empty():
    # Absent means "the org has never said anything", which is what lets the client fall back
    # to its built-in floor. An org that deliberately clears a list stores an empty one.
    assert _get("bo", "es") is None
    _put("bo", "es", [])
    assert _get("bo", "es") == []


def test_one_org_never_sees_another_s_rules():
    _org2()
    _put("skt", "fr", [_rule("Benza", "Bendza")], org=OTHER_ORG)
    assert [r.find for r in _get("skt", "fr", org=OTHER_ORG)] == ["Benza"]
    # The first org's French list is still its own (set in the first test).
    assert [r.find for r in _get("skt", "fr")] == ["Pema", "u", "Poudja"]


def test_each_language_opens_on_its_own_style():
    """The style a language opens on is org-wide: Lotsawa House carries en/fr/de and
    Padmakara is the only one with Portuguese, so the choice is per language, not global."""
    put_phonetic_style(PhoneticStyleIn(lang="fr", style="lotsawahouse"), org_id=ORG)
    put_phonetic_style(PhoneticStyleIn(lang="pt", style="padmakara"), org_id=ORG)
    got = {s.lang: s.style for s in list_phonetic_styles(org_id=ORG)}
    assert got == {"fr": "lotsawahouse", "pt": "padmakara"}
    # A language nobody has chosen for is absent, so the client's built-in default speaks.
    assert "de" not in got

    # Choosing again replaces, rather than adding a second row.
    put_phonetic_style(PhoneticStyleIn(lang="fr", style="rigpa"), org_id=ORG)
    again = {s.lang: s.style for s in list_phonetic_styles(org_id=ORG)}
    assert again["fr"] == "rigpa" and len(again) == 2


def test_a_style_choice_is_per_organization():
    _org2()
    put_phonetic_style(PhoneticStyleIn(lang="fr", style="padmakara"), org_id=OTHER_ORG)
    assert {s.lang: s.style for s in list_phonetic_styles(org_id=OTHER_ORG)} == {"fr": "padmakara"}
    assert {s.lang: s.style for s in list_phonetic_styles(org_id=ORG)}["fr"] == "rigpa"


def test_an_unknown_style_is_refused():
    # A typo stored here would be read back by every bench in the org and silently ignored.
    with pytest.raises(Exception):
        put_phonetic_style(PhoneticStyleIn(lang="fr", style="lotsawa-house"), org_id=ORG)
    with pytest.raises(Exception):
        put_phonetic_style(PhoneticStyleIn(lang="", style="padmakara"), org_id=ORG)


def test_a_bad_list_is_refused():
    with pytest.raises(Exception):
        _put("phonetics", "fr", [])       # not a kind
    with pytest.raises(Exception):
        _put("bo", "", [])                # no language


if __name__ == "__main__":
    test_the_order_is_the_data()
    test_each_kind_and_language_keeps_its_own_list()
    test_an_untouched_list_is_absent_rather_than_empty()
    test_one_org_never_sees_another_s_rules()
    test_each_language_opens_on_its_own_style()
    test_a_style_choice_is_per_organization()
    test_an_unknown_style_is_refused()
    test_a_bad_list_is_refused()
    print("ok")
