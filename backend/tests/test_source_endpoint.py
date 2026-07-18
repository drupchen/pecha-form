"""§13: upload round-trip over the live API.

The original test asserted ``GET /export/source`` returned the uploaded bytes,
but the export endpoints were removed (export returns later, on the syllable
model). What the app still promises — and what this now checks — is that the
uploaded bytes are kept verbatim in ``source_text`` (so a future exporter has
them), and that the served projection obeys the §5 boundary invariant.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db, get_db  # noqa: E402

init_db()

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402


def teardown_module():
    if os.path.exists(_tmp.name):
        os.remove(_tmp.name)


def test_upload_roundtrip_source_kept_and_boundary_invariant():
    client = TestClient(app)

    # Unusual whitespace, blank line, trailing spaces — the shapes normalization touches.
    original_text = "  སྐྱབས་འགྲོ།\n\nབྱང་ཆུབ་སེམས་བསྐྱེད།  \n"
    res = client.post(
        "/api/texts",
        files={"file": ("test.txt", original_text.encode("utf-8"), "text/plain")},
    )
    assert res.status_code == 200, res.text
    text_id = res.json()["id"]

    # The uploaded bytes are stored verbatim (raw_text is the normalized view).
    conn = get_db()
    row = conn.execute(
        "SELECT source_text, raw_text FROM texts WHERE id = ?", (text_id,)
    ).fetchone()
    conn.close()
    assert row["source_text"] == original_text

    # The served projection: units partition raw_text exactly (§5).
    res = client.get(f"/api/texts/{text_id}")
    assert res.status_code == 200, res.text
    body = res.json()
    raw, units = body["raw_text"], body["units"]
    assert raw == row["raw_text"]
    assert units, "units must not be empty"
    assert units[0][0] == 0
    assert units[-1][1] == len(raw)
    for a, b in zip(units, units[1:]):
        assert a[1] == b[0], f"gap/overlap between unit ending {a[1]} and unit starting {b[0]}"
    assert "".join(u[2] for u in units) == raw
