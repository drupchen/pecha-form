#!/usr/bin/env bash
# Launch the pecha-form web interface locally.
set -e
cd "$(dirname "$0")"

# Create the virtualenv on first run (Python 3.13).
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c "import flask" 2>/dev/null; then
    echo "Setting up virtual environment…"
    python3.13 -m venv .venv 2>/dev/null || python3 -m venv .venv
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
fi

echo "Starting pecha-form on http://localhost:5000  (press Ctrl+C to stop)"
.venv/bin/python -m webapp.app
