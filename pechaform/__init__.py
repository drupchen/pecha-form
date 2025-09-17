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

__all__ = ['parse_bo_docs', 'parse_trans_docs']

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
    c = ConfParse(conf_file)
    debug = c.conf['debug']
    files, in_folder, out_folder, tmplt = c.conf['files'], c.conf['in_folder'], c.conf['out_folder'], c.conf['template']

    for filename, link in c.conf['files'].items():
        print(f'\t{filename}')
        # download from Google Drive
        filename = Path(in_folder) / filename
        inner_link = None
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
        p = parser(filename, template=tmplt, debug=debug)
        p.format(out_folder)