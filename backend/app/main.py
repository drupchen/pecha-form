import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .db import init_db
from .routers import (
    texts, tags, spans, markers, tree_nodes, suggestions, notes, passages,
    derivation, text_groups, reading_positions, display_breaks, translations,
    phonetics, documents, styles,
)

app = FastAPI(title="Sapche Backend API")

app.include_router(texts.router)
app.include_router(text_groups.router)
app.include_router(tags.router)
app.include_router(spans.router)
app.include_router(markers.router)
app.include_router(tree_nodes.router)
app.include_router(suggestions.router)
app.include_router(notes.router)
app.include_router(passages.router)
app.include_router(derivation.router)
app.include_router(reading_positions.router)
app.include_router(display_breaks.router)
app.include_router(translations.router)
app.include_router(phonetics.router)
app.include_router(documents.router)
app.include_router(styles.router)


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


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
