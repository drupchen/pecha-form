from pathlib import Path
from urllib.request import urlretrieve

from .gen_tibetan_doc import TibetanDocument
from .gen_booklet_doc import BookletDocument
from .conf_parser import ConfParse

__all__ = ['parse_bo_docs', 'parse_trans_docs']

def parse_bo_docs(conf_file):
    parse_text(TibetanDocument, conf_file)

def parse_trans_docs(conf_file):
    parse_text(BookletDocument, conf_file)

def parse_text(parser, conf_file):
    c = ConfParse(conf_file)
    files, in_folder, out_folder, tmplt = c.conf['files'], c.conf['in_folder'], c.conf['out_folder'], c.conf['template']

    for filename, link in c.conf['files'].items():
        # download from Google Drive
        filename = Path(in_folder) / filename
        urlretrieve(link, filename)

        # process
        p = parser(filename, template=tmplt)
        p.format(out_folder)