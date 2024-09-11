import re
from pathlib import Path


def separate(string, mode=2):
    string = string.replace('Hri', '/b-Hri/')\
    .replace('Houng', '/b-Houng/')\
    .replace('Hung', '/b-Hung/')\
    .replace('Ho', '/b-Ho/')
    parts = re.split(r'\n\s?\n', string)
    if mode == 2:
        phon = []
        trans = []
        for part in parts:
            lines = part.split('\n')
            lines = [l.strip() for l in lines]
            for i in range(0, len(lines)-1, 2):
                phon.append(lines[i])
                trans.append(lines[i+1])
            phon.append('')
            trans.append('')
        return '\n'.join(phon), '\n'.join(trans)
    elif mode == 3:
        phon = []
        trans = []
        for part in parts:
            lines = part.split('\n')
            lines = [l.strip() for l in lines]
            for i in range(0, len(lines)-1, 3):
                phon.append(lines[i+1])
                trans.append(lines[i+2])
            phon.append('')
            trans.append('')
        return '\n'.join(phon), '\n'.join(trans)


in_file = Path('to_separate.txt')
phon, trans = separate(in_file.read_text(), 2)

Path('phon.txt').write_text(phon)
Path('trans.txt').write_text(trans)
