from pathlib import Path
from urllib.request import urlretrieve

from pechaform import BookletDocument


in_files = [
    #('rpn_daily_fr.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=588367815&single=true&output=tsv'),
    #('rpn_daily_en.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=1282995497&single=true&output=tsv'),
    #('rpn_daily_pt.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=192513481&single=true&output=tsv'),
    #('rpn_daily_de.tsv', 'https://docs.google.com/spreadsheets/d/1BgVGx2h_ULTUBU1MjCINI5akEGfR4B58MJLPhGsAv2s/pub?gid=951198963&single=true&output=tsv'),
    ('rpn_medium_en.tsv', 'https://docs.google.com/spreadsheets/d/1pc5IUDqk7V54mT1FL6OwB4HYn_1qoRlHnxSursFLMCs/pub?gid=1282995497&single=true&output=tsv'),
    #('rpn_medium_fr.tsv', 'https://docs.google.com/spreadsheets/d/1pc5IUDqk7V54mT1FL6OwB4HYn_1qoRlHnxSursFLMCs/pub?gid=588367815&single=true&output=tsv'),
    #('rpn_medium_pt.tsv','https://docs.google.com/spreadsheets/d/1pc5IUDqk7V54mT1FL6OwB4HYn_1qoRlHnxSursFLMCs/pub?gid=192513481&single=true&output=tsv')
]

for filename, link in in_files:
    # download from Google Drive
    filename = Path('input/'+filename)
    urlretrieve(link, filename)

    # process
    out_path = 'output'
    tt = BookletDocument(filename, template='template_tablet.docx', no_phon=True)
    tt.format(out_path)
