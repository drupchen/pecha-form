import re
from pathlib import Path
from urllib.request import urlretrieve

from .gen_tibetan_doc import TibetanDocument
from .gen_booklet_doc import BookletDocument
from .gen_booklet_doc_padmakara import BookletDocument as bd
from .gen_booklet_doc_updated import BookletDocument as bd_updated
from .conf_parser import ConfParse

__all__ = ['parse_bo_docs', 'parse_trans_docs']

def parse_bo_docs(conf_file):
    parse_text(TibetanDocument, conf_file)

def parse_trans_docs(conf_file):
    parse_text(BookletDocument, conf_file)

def parse_trans_docs_updated(conf_file):
    parse_text(bd_updated, conf_file)

def parse_trans_docs_padmakara(conf_file):
    parse_text(bd, conf_file)

def parse_text(parser, conf_file):
    c = ConfParse(conf_file)
    debug = c.conf['debug']
    files, in_folder, out_folder, tmplt = c.conf['files'], c.conf['in_folder'], c.conf['out_folder'], c.conf['template']

    for filename, link in c.conf['files'].items():
        print(f'\t{filename}')
        # download from Google Drive
        filename = Path(in_folder) / filename
        urlretrieve(link, filename)
        # find embedded link and download table
        raw_html = filename.read_text()
        if "pageUrl" in raw_html:
            link = re.findall(r'pageUrl: \"([^\"]+)\"', raw_html)[0].replace('\\', '')
            urlretrieve(link, filename)

        # process
        try:
            p = parser(filename, template=tmplt, debug=debug)
            p.format(out_folder)
        except:
            raise SyntaxError('The spreadsheet is not correctly formatted. Please correct it.')