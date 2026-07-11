"""Read/write the ``texts_*_conf.yaml`` files while preserving the comment convention.

The yaml ``files:`` block uses commented-out lines to mark texts that should be skipped
(e.g. ``#rpn_long_bo: https://...``) and plain lines for texts to process. PyYAML drops
comments on round-trip, so this module edits the ``files:`` block line-by-line instead:

- an *enabled* entry is written as ``    name: url``
- a *disabled* entry is written as ``    #name: url``

This keeps both the web UI (checkboxes) and the CLI (``usage.py`` via ``ConfParse``) in
sync off the same file.
"""
from pathlib import Path

# name: url, optionally commented with a leading '#'. Captures indent, comment marker,
# name and url.
import re

_HEADER_KEYS = ('in_folder', 'out_folder', 'template', 'debug')
_ENTRY_RE = re.compile(r'^(\s*)(#\s*)?([\w-]+)\s*:\s*(https?://\S+)\s*$')
_FILES_RE = re.compile(r'^\s*files\s*:\s*$')
_SETTING_RE = re.compile(r'^(\s*)([\w-]+)\s*:\s*(.*?)\s*$')


def load_entries(conf_file):
    """Return ``{'settings': {...}, 'entries': [{name, url, enabled}, ...]}``."""
    text = Path(conf_file).read_text(encoding='utf-8')
    settings = {}
    entries = []
    in_files = False

    for line in text.splitlines():
        if _FILES_RE.match(line):
            in_files = True
            continue

        if not in_files:
            m = _SETTING_RE.match(line)
            if m and m.group(2) in _HEADER_KEYS:
                settings[m.group(2)] = _coerce(m.group(3))
            continue

        # inside the files: block
        m = _ENTRY_RE.match(line)
        if m:
            entries.append({
                'name': m.group(3),
                'url': m.group(4),
                'enabled': m.group(2) is None,
            })

    return {'settings': settings, 'entries': entries}


def save_entries(conf_file, settings, entries):
    """Rewrite ``conf_file`` with updated header settings and files block.

    Header lines (in_folder/out_folder/template/debug) are preserved in place and updated
    from ``settings`` when provided. The ``files:`` block is fully re-emitted from
    ``entries`` (a list of ``{name, url, enabled}``).
    """
    conf_path = Path(conf_file)
    original = conf_path.read_text(encoding='utf-8').splitlines()

    header_lines = []
    seen_keys = set()
    for line in original:
        if _FILES_RE.match(line):
            break
        m = _SETTING_RE.match(line)
        if m and m.group(2) in _HEADER_KEYS and m.group(2) in (settings or {}):
            key = m.group(2)
            header_lines.append(f'{key}: {_format(settings[key])}')
            seen_keys.add(key)
        else:
            header_lines.append(line)

    # Append any settings keys that weren't already present in the header.
    for key in _HEADER_KEYS:
        if settings and key in settings and key not in seen_keys:
            header_lines.append(f'{key}: {_format(settings[key])}')

    lines = list(header_lines)
    lines.append('files:')
    for e in entries:
        prefix = '' if e.get('enabled') else '#'
        lines.append(f'    {prefix}{e["name"]}: {e["url"]}')

    conf_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def _coerce(value):
    """Convert a raw yaml scalar string into a Python value (bools stay bool)."""
    v = value.strip()
    # strip inline comments like "False  # True or False"
    if '#' in v:
        v = v.split('#', 1)[0].strip()
    low = v.lower()
    if low in ('true', 'false'):
        return low == 'true'
    return v


def _format(value):
    if isinstance(value, bool):
        return 'True' if value else 'False'
    return str(value)
