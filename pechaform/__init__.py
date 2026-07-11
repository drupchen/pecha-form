import re
import urllib
from pathlib import Path
from urllib.request import urlretrieve
import requests
from bs4 import BeautifulSoup

from .gen_tibetan_doc import TibetanDocument
from .gen_tibetan_doc_updated import TibetanDocument as td_updated
from .gen_booklet_doc import BookletDocument
from .gen_booklet_doc_padmakara import BookletDocument as bd
from .gen_booklet_doc_updated import BookletDocument as bd_updated
from .conf_parser import ConfParse

__all__ = ['parse_bo_docs', 'parse_trans_docs', 'run_selected']

# Parser class for each web-app "mode".
PARSERS = {
    'bo': td_updated,
    'trans': bd_updated,
}

def parse_bo_docs(conf_file):
    parse_text(TibetanDocument, conf_file)

def parse_bo_docs_updated(conf_file):
    parse_text(td_updated, conf_file)

def parse_trans_docs(conf_file):
    parse_text(BookletDocument, conf_file)

def parse_trans_docs_updated(conf_file):
    parse_text(bd_updated, conf_file)

def parse_trans_docs_padmakara(conf_file):
    parse_text(bd, conf_file)

def parse_text(parser, conf_file):
    """Load a yaml conf file and process every active entry (CLI entry point)."""
    c = ConfParse(conf_file)
    parse_text_conf(parser, c.conf)

def parse_text_conf(parser, conf, progress=None):
    """Process an already-built conf dict.

    ``conf`` must contain ``files`` (mapping of ``name.tsv`` -> Google Sheet link),
    ``in_folder``, ``out_folder``, ``template`` and ``debug``.
    ``progress`` is an optional callback ``progress(name, status)`` where status is one
    of ``'download'``, ``'process'``, ``'done'`` or ``'error'``.

    Returns the list of generated output ``Path`` objects.
    """
    debug = conf['debug']
    in_folder, out_folder, tmplt = conf['in_folder'], conf['out_folder'], conf['template']
    Path(in_folder).mkdir(parents=True, exist_ok=True)
    Path(out_folder).mkdir(parents=True, exist_ok=True)

    generated = []
    for filename, link in conf['files'].items():
        print(f'\t{filename}')
        # download from Google Drive
        filename = Path(in_folder) / filename
        inner_link = None
        if progress:
            progress(filename.stem, 'download')
        try:
            # Get the main published page
            response = requests.get(link)
            soup = BeautifulSoup(response.content, 'html.parser')

            # Look for any references to files folder or sheet.html
            # This might be in script tags or as iframe sources
            scripts = soup.find_all('script')
            for script in scripts:
                if not inner_link and script.string and 'pageUrl: "' in script.string:
                    res = re.findall(r'pageUrl: \"([^\"]+)\"', script.string)
                    inner_link = res[0]
                    inner_link = inner_link.replace('\\', '')
                    break

        except Exception as e:
            print(f"Error accessing HTML structure: {e}")

        if inner_link:
            urlretrieve(inner_link, filename)
        else:
            urlretrieve(link, filename)

        # process
        if progress:
            progress(filename.stem, 'process')
        try:
            p = parser(filename, template=tmplt, debug=debug)
            p.format(out_folder)
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            if progress:
                progress(filename.stem, 'error', str(e))
            continue

        out_file = Path(out_folder) / (filename.stem + '.docx')
        generated.append(out_file)
        if progress:
            progress(filename.stem, 'done', str(out_file))

    return generated

def run_selected(mode, files, in_folder, out_folder, template, debug, progress=None):
    """Process a caller-supplied selection of texts (used by the web app).

    ``mode`` is ``'bo'`` or ``'trans'``. ``files`` maps a plain ``name`` (no extension)
    to its Google Sheet link. The ``.tsv`` extension is appended here to mirror
    :class:`ConfParse` so the downloaded filenames match those in ``in_folder``.
    """
    if mode not in PARSERS:
        raise ValueError(f"Unknown mode {mode!r}; expected one of {list(PARSERS)}")
    parser = PARSERS[mode]
    conf = {
        'in_folder': in_folder,
        'out_folder': out_folder,
        'template': template,
        'debug': debug,
        'files': {f'{name}.tsv': link for name, link in files.items()},
    }
    return parse_text_conf(parser, conf, progress=progress)
