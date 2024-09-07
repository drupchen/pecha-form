from pathlib import Path
from urllib.request import urlretrieve

from pechaform import TibetanDocument

in_files = [
    ('rpn_daily_bo.tsv', 'https://docs.google.com/spreadsheets/d/1RpOex38h2ft7kKCcTVBIy9-7IyuoozoOiEpBeye8Xtk/pub?gid=0&single=true&output=tsv'),
    ('rpn_medium_bo.tsv', 'https://docs.google.com/spreadsheets/d/1dsbidhuIv0Axk8nHSvqYY0Xur6vji1e7zhU5trfa5A0/pub?gid=0&single=true&output=tsv'),
    #('rpn_daily_pt.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=192513481&single=true&output=tsv'),
    #('rpn_daily_de.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=951198963&single=true&output=tsv')
]

for filename, link in in_files:
    # download from Google Drive
    filename = Path('input/'+filename)
    urlretrieve(link, filename)

    # process
    out_path = 'output'
    tt = TibetanDocument(filename, template='template.docx')
    tt.format(out_path)
