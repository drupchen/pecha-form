# pecha-form

Tibetan practice-booklet tooling. The project is being rebuilt as a **segmentation
+ tagging webapp** (FastAPI + React/Vite), vendored and trimmed from
[`sapche_discovery`](../sapche_discovery). The current milestone lets you take a raw
Tibetan text, **segment it into the sapche syllable structure**, and **manually tag
runs** (e.g. big/small/title, via the regular-tag/span system). The translation/booklet
features from the old library are ported on top of this in later steps.

## Dev stack

Two processes: a FastAPI backend on **:8001** and a Vite frontend on **:5173**.

### First-time setup

```bash
# Backend (Python ≥3.11; installs botok from git, so git is required)
cd backend && python3 -m venv .venv && ./.venv/bin/pip install -e . && cd ..

# Frontend (Node/npm)
cd frontend && npm install && cd ..
```

### Run

```bash
./dev.sh          # starts backend + frontend; open http://localhost:5173  (Ctrl+C stops both)
```

Or run each side yourself:

```bash
cd backend  && ./.venv/bin/uvicorn app.main:app --port 8001 --reload
cd frontend && npm run dev
```

The SQLite DB (`backend/sapche.db`) is created automatically on first run.

### Using it

1. **Documents** tab → *Upload plain text* (a `.txt` of raw Tibetan). It is tokenized
   into syllables on upload (botok, with a pure-Python fallback).
2. Open the document in the **Workspace** (Open Tag Editor). The tagger shows the
   segmented syllables and a tree pane for the sapche outline.
3. Select a run of syllables and apply a tag (create tags like `title`, `sapche`,
   `main-text`, …). Tags/spans persist to the DB.

## Layout

- `backend/` — FastAPI app (documents, segmentation, tags/spans, tree/markers), trimmed
  from sapche_discovery. `db.init_db()` recreates the schema.
- `frontend/` — React 19 + Vite + TypeScript + Tailwind; Documents + Workspace surface.
- `pechaform/`, `texts_*_conf.yaml`, `*.docx` — the **legacy** booklet/translation library
  and its assets, kept as the source for the upcoming translation-feature port.

## Deprecated

The old Flask booklet UI (`webapp/`, `run_web.sh`, `ui.py`) is no longer maintained; the
project has moved to the stack above.
