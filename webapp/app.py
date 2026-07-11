"""Local web interface for pecha-form.

Run with:  python -m webapp.app   (from the repo root)
Then open  http://localhost:5000
"""
import threading
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from pechaform import run_selected
from pechaform.conf_store import load_entries, save_entries

ROOT = Path(__file__).resolve().parent.parent

CONF_FILES = {
    'bo': ROOT / 'texts_bo_conf.yaml',
    'trans': ROOT / 'texts_trans_conf.yaml',
}
MODE_LABELS = {'bo': 'Tibetan texts', 'trans': 'Translations'}

app = Flask(__name__, static_folder=None)

# In-memory job registry (single local user).
_jobs = {}
_jobs_lock = threading.Lock()


def _conf_file(mode):
    if mode not in CONF_FILES:
        raise ValueError(f'unknown mode: {mode!r}')
    return CONF_FILES[mode]


def _templates():
    return sorted(p.name for p in ROOT.glob('*.docx') if not p.name.startswith('~'))


@app.get('/')
def index():
    return send_from_directory(Path(__file__).resolve().parent, 'index.html')


@app.get('/api/config')
def get_config():
    mode = request.args.get('mode', 'bo')
    try:
        data = load_entries(_conf_file(mode))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    data['templates'] = _templates()
    data['mode'] = mode
    data['label'] = MODE_LABELS.get(mode, mode)
    return jsonify(data)


@app.post('/api/config')
def post_config():
    body = request.get_json(force=True)
    mode = body.get('mode', 'bo')
    try:
        save_entries(_conf_file(mode), body.get('settings', {}), body.get('entries', []))
    except (ValueError, KeyError) as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'ok': True})


@app.post('/api/run')
def post_run():
    body = request.get_json(force=True)
    mode = body.get('mode', 'bo')
    settings = body.get('settings', {})
    # Only enabled entries are processed.
    entries = [e for e in body.get('entries', []) if e.get('enabled')]

    if mode not in CONF_FILES:
        return jsonify({'error': f'unknown mode: {mode!r}'}), 400
    if not entries:
        return jsonify({'error': 'No texts selected'}), 400

    files = {e['name']: e['url'] for e in entries}
    in_folder = str(ROOT / settings.get('in_folder', 'input'))
    out_folder = str(ROOT / settings.get('out_folder', 'output'))
    template = settings.get('template', 'template.docx')
    template_path = str(ROOT / template) if template else None
    debug = bool(settings.get('debug', False))

    job_id = uuid.uuid4().hex
    job = {'running': True, 'log': [], 'results': [], 'error': None}
    with _jobs_lock:
        _jobs[job_id] = job

    def progress(name, status, detail=''):
        messages = {
            'download': f'Downloading {name}…',
            'process': f'Formatting {name}…',
            'done': f'✓ {name} → {Path(detail).name}',
            'error': f'✗ {name}: {detail}',
        }
        job['log'].append(messages.get(status, f'{name}: {status}'))
        if status == 'done':
            job['results'].append({'name': name, 'path': detail})

    def worker():
        try:
            run_selected(mode, files, in_folder, out_folder, template_path, debug,
                         progress=progress)
            job['log'].append('Done.')
        except Exception as e:  # noqa: BLE001 - surface any failure to the UI
            job['error'] = str(e)
            job['log'].append(f'Error: {e}')
        finally:
            job['running'] = False

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({'job_id': job_id})


@app.get('/api/status/<job_id>')
def get_status(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return jsonify({'error': 'unknown job'}), 404
    return jsonify(job)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False)
