"""Where the PDF renderer is pointed.

A booklet is printed by headless Chromium off this frontend's `?print=` route — so the address
must be this frontend's. A fixed default guesses, and on a developer machine it guesses wrong:
another project holding :5173 pushes this app to :5174, and the export came back as a one-page
PDF of that project's login screen. The browser asking for the export is ON this frontend, so
it is asked; only an origin the server already trusts is accepted.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db  # noqa: E402
from app.routers.documents import _frontend_origin, FRONTEND_URL  # noqa: E402

init_db()


class _Req:
    def __init__(self, **headers):
        self.headers = {k.lower(): v for k, v in headers.items()}


def test_renders_from_the_origin_the_browser_is_on():
    assert _frontend_origin(_Req(origin="http://localhost:5174")) == "http://localhost:5174"
    # A referer carries a path; only its origin is taken.
    assert _frontend_origin(
        _Req(referer="http://127.0.0.1:5174/documents/20")) == "http://127.0.0.1:5174"


def test_prefers_the_origin_header_over_the_referer():
    assert _frontend_origin(_Req(origin="http://localhost:5174",
                                 referer="http://localhost:5173/x")) == "http://localhost:5174"


def test_refuses_an_origin_the_server_does_not_trust():
    # A forged header must not be able to aim the renderer at another host.
    for hostile in ("http://evil.example.com", "http://localhost:9999", "notaurl", ""):
        assert _frontend_origin(_Req(origin=hostile)) == FRONTEND_URL


def test_falls_back_when_there_is_no_request_at_all():
    # The version worker renders on a background thread, with no browser to ask.
    assert _frontend_origin(None) == FRONTEND_URL
    assert _frontend_origin(_Req()) == FRONTEND_URL
