from pathlib import Path
import re
from collections import OrderedDict, defaultdict

from docx import Document # package name: python-docx
from botok import TokChunks


def docx_to_spread(in_file, letter_sizes=None):
    if not letter_sizes:
        letter_sizes = {
            20: 'big',
            21: 'big',
            22: 'big',
            14: 'small'
        }
    parsed = parse_docx(in_file, letter_sizes)

    # split in verses
    for i, p in enumerate(parsed):
        chunk = split_in_verses(parsed[i][1])
        parsed[i][1] = chunk

    # format in spreadsheet

    print()


def split_in_verses(string):
    chunks = re.split(r'\s', string)
    chunks = [{'text': c} for c in chunks]

    # find syl size of each chunk
    for c in chunks:
        t = TokChunks(c['text']).get_syls()
        c['size'] = len(t)

    # 1. Detect verses
    sizes = [c['size'] for c in chunks if c['size']]
    # remove sanskrit initial syllables
    if sizes[0] == 1 or sizes[0] == 2 or sizes[0] == 3:
        sizes = sizes[1:]
    # two chunks of the same size, either at beginning or at end, is considered proof of verses
    verse_size = None
    if len(sizes) < 2:
        is_verses = False
    else:
        # checks if a majority (50% or more) of chunks have the same size, and if the first two
        # (excluding sanskrit initial syllables) or last two chunks have the same size.
        # takes includes chunks that have 1 syllable less (to account for པདྨ་ ཀརྨ་ etc.)
        has_verses, size = find_size_distrib(sizes)
        if has_verses:
            is_verses = True
            verse_size = size
        elif sizes[0] == sizes[1]:
            is_verses = True
            verse_size = sizes[0]
        elif sizes[-2] == sizes[-1]:
            is_verses = True
            verse_size = sizes[-1]
        else:
            is_verses = False
    if is_verses:
        for c in chunks:
            if c['size'] == verse_size or c['size'] == verse_size - 1:
                c['verse'] = True

    # join initial sanskrit syllables
    for i, c in enumerate(chunks):
        if i > 1 and 'verse' in c and chunks[i-1]['size'] <= 3:
            c['text'] = ' '.join([chunks[i-1]['text'], c['text']])
            chunks[i-1]['text'] = ''

    # join non verses together and add \n to mark verse boundaries
    out = []
    cur = []
    for c in chunks:
        if 'verse' not in c:
            cur.append(c['text'])
        else:
            if cur:
                out.extend(cur)
                cur = []
            out.append(c['text'] + '\n')
    if cur:
        out.extend(cur)

    # reinsert spaces + split at verse boundaries
    joined = ' '.join(out)
    joined = joined.replace('\n ', ' \n')
    joined = joined.replace('\n།', '།\n')  # include second shad in the previous verse
    joined = re.sub(r' +', ' ', joined)
    if '\n' in joined:
        joined = [j for j in joined.split('\n') if j]
    if isinstance(joined, str):
        joined = [joined]

    return joined


def find_size_distrib(sizes):
    size_distribution = defaultdict(int)
    for s in sizes:
        size_distribution[s] += 1

    has_verses = False
    verse_size = None
    for size, freq in size_distribution.items():
        if len(sizes) == 2 and len(size_distribution) == 2:
            pass
        elif freq >= len(sizes) / 2:
            has_verses = True
            verse_size = size

    return has_verses, verse_size


def parse_docx(in_file, letter_sizes):
    doc = Document(in_file)

    log = []
    out = []
    for par in doc.paragraphs:
        cur = []
        for run in par.runs:
            if cur and not run.text.strip():
                cur[-1][1] += run.text
                continue

            size = run.font.size.pt
            if cur and size in letter_sizes and letter_sizes[size] == cur[-1][0]:
                cur[-1][1] += run.text
            elif size in letter_sizes:
                cur.append([letter_sizes[size], run.text])
            else:
                log.append([size, run.text])
        out.extend(cur)
    if log:
        print('\nUnknown sizes:')
        for s, string in log:
            print(f'\t{s}, "{string}"')
        exit('Please attribute value to those sizes and rerun.')

    else:
        return out


if __name__ == '__main__':
    letter_sizes = {
        20: 'big',
        21: 'big',
        22: 'big',
        14: 'small'
    }
    for f in Path('./input').glob('*.docx'):
        docx_to_spread(f, letter_sizes)
