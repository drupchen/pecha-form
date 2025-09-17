from pathlib import Path
import re
import csv

from .format_doc_padmakara import FormatDocument


class BookletDocument:
    def __init__(self, in_file, template=None, no_phon=False, debug=False):
        self.no_phon = no_phon
        self.parsed = []
        self.in_file = Path(in_file)
        self.debug = debug
        self.__parse()
        self.fd = FormatDocument(template=template)

    def format(self, out_folder):
        if self.no_phon:
            out_file = Path(out_folder) / (self.in_file.stem + '_nophon.docx')
        else:
            out_file = Path(out_folder) / (self.in_file.stem + '.docx')
        self.fd.format_booklet(self.parsed, out_file, no_phon=self.no_phon)

    def __parse(self, ):
        LEVEL2_SPLIT_PATTERN = r'(\/[^\/]+)\/'
        LEVEL2_BOUNDARY = '/'
        LEVEL2_SPLIT = '-'
        PHON_BO = 'Phonetics bo'
        PHON_SKT = 'Phonetics skt'
        SKT = 'Sanskrit'
        TIB = 'Tibetan'
        TIB_NOPHON = 'Tibetan- no phonetics'
        TRANS = 'Translation'
        HUB = 'hub'

        with self.in_file.open(newline='') as csvfile:
            reader = csv.reader(csvfile, delimiter='\t', quotechar='"')
            table = list(reader)
        keys = {k: n for n, k in enumerate(table[0])}
        table = table[1:]

        # 1. from lines to raw segments (groups of lines)
        segments_raw = []
        cur_seg = []
        for line in table:
            if not line[keys[HUB]].startswith('|'):
                if ''.join([l for l in line if l]):
                    cur_seg.append(line)
            else:
                if cur_seg:
                    # remove trailing empty line
                    if not [c for c in cur_seg[-1] if c.strip()]:
                        cur_seg.pop()
                    segments_raw.append(cur_seg)
                    cur_seg = []
                cur_seg.append(line)

        # last segment
        if cur_seg:
            # remove trailing empty line
            if not [c for c in cur_seg[-1] if c.strip()]:
                cur_seg.pop()
            segments_raw.append(cur_seg)

        # parse segments
        segments_parsed = []
        for seg in segments_raw:
            if self.debug:
                print(seg)
            seg_type = seg[0][keys[HUB]].strip('|')
            if not seg_type:
                if seg[0][keys['Tibetan- no phonetics']]:
                    seg_type = 's'
                elif seg[0][keys['Tibetan']]:
                    seg_type = 'n'
                elif seg[0][keys['Sanskrit']]:
                    seg_type = 'k'
                else:
                    print(cur)
                    print('problematic segment')

            content = []
            for line in seg:
                cur = {'phon_bo': line[keys[PHON_BO]], 'phon_skt': line[keys[PHON_SKT]],
                       'tib_small': line[keys[TIB_NOPHON]],
                       'tib': line[keys[TIB]], 'skt': line[keys[SKT]]}

                # parse secondary segments in translation
                trans = []
                parts = re.split(LEVEL2_SPLIT_PATTERN, line[keys[TRANS]])
                # remove empty initial elements
                while parts and len(parts) > 1 and not parts[0]:
                    parts = parts[1:]

                if len(parts) > 1:
                    parts_new = []
                    for i in parts:
                        if i.startswith(LEVEL2_BOUNDARY):
                            ttype, string = i[1:].split(LEVEL2_SPLIT, 1)
                            parts_new.append((ttype, string))
                        else:
                            parts_new.append(i)
                    trans.extend(parts_new)
                else:
                    trans.extend(parts)

                cur['trans'] = trans
                content.append(cur)

            # del empty string in trans if the current segment has no translation at all
            if len(content) == 1 and not content[0]['trans'][0]:
                content[0]['trans'].pop()
            segments_parsed.append((seg_type, content))

        self.parsed = segments_parsed
