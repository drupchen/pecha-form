#!/usr/bin/env bash
# Launch the pecha-form dev stack: FastAPI backend (:8001) + Vite frontend (:5173).
# (Vendored/trimmed from sapche_discovery: raw-text segmentation + big/small/title tagging.)
#
# First run needs the backend venv and frontend deps installed:
#   cd backend  && python3 -m venv .venv && ./.venv/bin/pip install -e .
#   cd frontend && npm install
#
# Then just run this script. Ctrl+C stops both.
set -e
cd "$(dirname "$0")"

BACKEND=backend
FRONTEND=frontend

if [ ! -x "$BACKEND/.venv/bin/uvicorn" ]; then
  echo "Backend venv missing. Run:  cd $BACKEND && python3 -m venv .venv && ./.venv/bin/pip install -e ." >&2
  exit 1
fi
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "Frontend deps missing. Run:  cd $FRONTEND && npm install" >&2
  exit 1
fi

echo "Starting backend on http://localhost:8001 …"
( cd "$BACKEND" && ./.venv/bin/uvicorn app.main:app --port 8001 --reload ) &
BACK_PID=$!

echo "Starting frontend on http://localhost:5173 …"
( cd "$FRONTEND" && npm run dev ) &
FRONT_PID=$!

trap 'echo; echo "Stopping…"; kill "$BACK_PID" "$FRONT_PID" 2>/dev/null || true' INT TERM
echo "Open http://localhost:5173  (Ctrl+C to stop both)"
wait
