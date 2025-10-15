from pathlib import Path
import re
from collections import OrderedDict, defaultdict
import csv

from docx import Document # package name: python-docx
from botok import TokChunks, WordTokenizer, ChunkTokenizer

t = WordTokenizer()


def docx_to_spread(in_file, letter_sizes=None):
    # A. parse docx + detect big and small letters
    if not letter_sizes:
        letter_sizes = {
            20: 'big',
            21: 'big',
            22: 'big',
            26: 'big',
            23: 'small',
            14: 'small'
        }
    parsed = parse_docx(in_file, letter_sizes)

    # B. split in verses and detect sanskrit
    for i, p in enumerate(parsed):
        chunk = split_in_verses(parsed[i][1])
        parsed[i][1] = chunk

    # C. format in spreadsheet
    # a. generate Tibetan sheet
    tib_rows = gen_tibetan_rows(parsed)
    #write to csv
    trans_csv = in_file.parent.parent / 'output' / (in_file.stem + '_tib.csv')
    with open(trans_csv, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerows(tib_rows)

    # b. generate translation sheet
    trans_rows = gen_translation_rows(parsed)
    #write to csv
    trans_csv = in_file.parent.parent / 'output' / (in_file.stem + '_trans.csv')
    with open(trans_csv, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerows(trans_rows)


def gen_tibetan_rows(chunks):
    rows = [['hub', 'Tibetan']]
    types = {'big': '|b|', 'small': '|s|'}
    prev_type = None
    for type, chunk in chunks:
        for c in chunk:
            new = ['', '']
            cur_type = type
            if prev_type and prev_type != cur_type:
                new[0] = types[cur_type]
                rows.append(['', ''])
            if isinstance(c, str):
                new[1] = cleanup_line(c)
            elif isinstance(c, tuple):
                new[1] = cleanup_line(c[1])
                if prev_type and prev_type != cur_type:
                    new[0] = types[cur_type]
                    rows.append(['', ''])

            rows.append(new)
            prev_type = cur_type

    return rows


def gen_translation_rows(chunks):
    rows = [['hub', 'Tibetan- no phonetics', 'Translation', 'Tibetan', 'Phonetics', 'Sanskrit']]
    types = {'big': '|n|', 'small': '|s|', 'skrt': '|k|'}
    prev_type = None
    for type, chunk in chunks:
        for c in chunk:
            new = ['', '', '', '', '', '']
            cur_type = type
            if prev_type and prev_type != cur_type:
                new[0] = types[cur_type]
                rows.append(['', '', '', '', '', ''])
            if isinstance(c, str):
                clean = cleanup_line(c)
                if type == 'big':
                    new[3] = clean
                elif type == 'small':
                    new[1] = clean
            elif isinstance(c, tuple):
                clean = cleanup_line(c[1])
                cur_type = c[0]
                if type == 'big':
                    new[3] = clean
                elif type == 'small':
                    new[1] = clean
                new[0] = types[cur_type]
                rows.append(['', '', '', '', '', ''])

            rows.append(new)
            prev_type = cur_type

    return rows


def cleanup_line(string):
    string = string.strip()
    if string.endswith(' །') or string.endswith(' །'):
        string = string[:-2] + string[-1]
    return string


def split_in_verses(string):
    # join all non-text chunks
    raw = ChunkTokenizer(string).tokenize()
    raw_chunks = []
    for type, c in raw:
        if not raw_chunks:
            raw_chunks.append([type, c])
        else:
            if type != 'TEXT' and raw_chunks[-1][0] != 'TEXT':
                raw_chunks[-1][1] += c
            else:
                raw_chunks.append([type, c])

    chunks = []
    cur = []
    for type, c in raw_chunks:
        if type == 'TEXT':
            cur.append(c)
        elif type == 'PUNCT' and not cur:
            cur.append(c)
        else:
            cur.append(c)
            chunks.append(''.join(cur))
            cur = []
    if cur:
        chunks.append(''.join(cur))
    chunks = [{'text': c} for c in chunks]

    # find syl size of each chunk
    for c in chunks:
        t = TokChunks(c['text']).get_syls()
        c['size'] = len(t)
        is_skrt = contains_skrt(c['text'])
        if is_skrt:
            c['skrt'] = True

    # 1. Detect verses
    sizes = [c['size'] for c in chunks if c['size']]
    # remove sanskrit initial syllables
    if sizes and (sizes[0] == 1 or sizes[0] == 2 or sizes[0] == 3):
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
        if i >= 1 and 'verse' in c and chunks[i-1]['size'] <= 3:
            c['text'] = ''.join([chunks[i-1]['text'], c['text']])
            chunks[i-1]['text'] = ''
    # remove empty elements
    chunks = [c for c in chunks if c['text']]

    # join non verses together and add \n to mark verse boundaries
    out = []
    cur = []
    for c in chunks:
        if 'verse' not in c and 'skrt' not in c:
            cur.append(c['text'])
        elif 'skrt' in c:
            if cur:
                out.append(''.join(cur))
                cur = []
            out.append(('skrt', c['text']))
        else:
            if cur:
                out.append(''.join(cur))
                cur = []
            out.append(c['text'])
    if cur:
        out.append(''.join(cur))

    return out


def contains_skrt(string):
    tokens = t.tokenize(string)
    skrt_total = 0
    for tk in tokens:
        if tk.skrt:
            skrt_total += 1

    if skrt_total and skrt_total == len(tokens):
        return True
    elif skrt_total >= 3:
        return True
    else:
        return False


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

            try:
                size = run.font.size.pt
            except:
                try:
                    size = run.style.font.size.pt
                except AttributeError:
                    size = 32.0  # hack for when no size applied == big letters
                    print(run.text)
                    print('there must be some superscript somewhere')
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
        26: "small",
        32: "big",
        23: "small",
        14: 'small'
    }
    for f in Path('./input').glob('*.docx'):
        if not f.name.startswith('RPN'):
            continue
        print(f)
        docx_to_spread(f, letter_sizes)
