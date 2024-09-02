from pathlib import Path
from urllib.request import urlretrieve

from pechaform import TibetanDocument, BookletDocument


# in_file = 'input/rpn_daily_bo.txt'
# out_path = 'output'
# tt = TibetanDocument(in_file, template='template.docx')
# tt.format(out_path)

def download_gdocs(filename, link):
    urlretrieve(link, filename)

in_files = [
    ('rpn_daily_fr.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=588367815&single=true&output=tsv'),
    #('rpn_daily_en.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=1282995497&single=true&output=tsv')
]

for a, b in in_files:
    in_file = Path('input/'+a)
    download_gdocs(in_file, b)
    out_path = 'output'
    tt = BookletDocument(in_file, template='template.docx')
    tt.format(out_path)
