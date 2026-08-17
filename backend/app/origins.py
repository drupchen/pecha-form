"""The origins this server trusts, in one place.

Two things ask the question and must not answer it differently:

  * CORS, deciding whose browser may call the API (`main.py`);
  * the PDF export, deciding where headless Chromium may be pointed to render the booklet
    (`routers/documents.py`) — it takes the origin from the requesting browser, and accepts it
    only if it is on this list.

Extra origins — a production domain, an alternate dev port — come from `SAPCHE_CORS_ORIGINS`,
comma-separated. Keeping the list here is also what keeps the trap in `docs/ARCHITECTURE.md`
from spreading: a vite port missing from the allowlist fails login with an opaque network
error, and would now also send the PDF renderer to the wrong app.
"""
import os

# 5174 is where vite lands here whenever another project holds 5173 — which happens, and is
# exactly how a booklet export once came back as another project's login page.
_DEV_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:5174", "http://127.0.0.1:5174",
    "http://localhost:5175", "http://127.0.0.1:5175",
]


def extra_origins() -> list[str]:
    return [o.strip().rstrip("/") for o in
            os.environ.get("SAPCHE_CORS_ORIGINS", "").split(",") if o.strip()]


def allowed_origins() -> list[str]:
    """Read at call time, not at import: the env is set before uvicorn boots, and a test or a
    scratch server may set it later."""
    return [*_DEV_ORIGINS, *extra_origins()]
