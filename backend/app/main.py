import logging
import os

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from .auth import guard
from .db import init_db
from .routers import (
    texts, tags, spans, markers, tree_nodes, suggestions, notes, passages,
    derivation, text_groups, reading_positions, display_breaks, translations,
    phonetics, documents, styles, auth as auth_router, orgs,
)

app = FastAPI(title="Sapche Backend API")

# Whole-document JSON payloads (syllables, spans, translations) compress ~80% —
# registered first so it wraps innermost, compressing after CORS/error handling.
app.add_middleware(GZipMiddleware, minimum_size=1000)


def _guarded(router, section, resolvers=None, write_level="modify"):
    """Attach the auth/org/permission guard at include time (see auth.guard) —
    routing-level enforcement, zero churn inside the router files."""
    app.include_router(
        router, dependencies=[Depends(guard(section, resolvers, write_level))]
    )


# Section mapping: "texts" = managing the texts themselves; "workspace" = the
# annotation surface over them; the rest map 1:1. reading_positions only ever
# writes the caller's OWN bookmark, so read access suffices for its PUT.
_guarded(texts.router, "texts", {"id": "text"})
_guarded(text_groups.router, "texts")
_guarded(tags.router, "workspace", {"text_id": "text", "tag_id": "tag"})
_guarded(spans.router, "workspace", {"text_id": "text", "span_id": "span"})
_guarded(markers.router, "workspace", {"text_id": "text", "marker_id": "marker"})
_guarded(tree_nodes.router, "workspace", {"text_id": "text", "node_id": "node"})
_guarded(suggestions.router, "workspace",
         {"text_id": "text", "suggestion_id": "suggestion"})
_guarded(notes.router, "workspace",
         {"text_id": "text", "note_id": "note", "category_id": "note_category"})
_guarded(passages.router, "workspace", {"text_id": "text", "passage_id": "passage"})
_guarded(derivation.router, "workspace", {"text_id": "text", "op_id": "op"})
_guarded(display_breaks.router, "workspace", {"text_id": "text"})
_guarded(reading_positions.router, "texts", {"text_id": "text"}, write_level="read")
_guarded(translations.router, "translate",
         {"text_id": "text", "chunk_id": "chunk", "sug_id": "tr_suggestion",
          "layout_id": "chunk_layout"})
_guarded(phonetics.router, "phonetics", {"text_id": "text"})
_guarded(documents.router, "documents",
         {"document_id": "document", "item_id": "doc_item"})
_guarded(styles.router, "documents", {"document_id": "document", "font_id": "font"})
app.include_router(auth_router.router)   # public: login/invites do their own checks
app.include_router(orgs.router)          # per-endpoint superuser/can_manage_org checks


# Turn any unhandled exception into a JSON 500 *before* it escapes past the CORS
# middleware. Without this, an uncaught error is handled by Starlette's outermost
# ServerErrorMiddleware and the response carries no CORS headers, so the browser
# reports a generic "Failed to fetch" instead of the real error. Registered here
# (before CORS) so CORS stays the outermost middleware and tags this response.
@app.middleware("http")
async def json_500_with_cors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logging.getLogger("uvicorn.error").exception(
            "Unhandled error on %s %s", request.method, request.url.path
        )
        return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


# Exact-origin allowlist (credentials mode forbids "*"). Extra origins — a
# production domain, an alternate dev port — come from the env, comma-separated.
_extra_origins = [
    o.strip() for o in os.environ.get("SAPCHE_CORS_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", *_extra_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health_check():
    return {"status": "ok"}
