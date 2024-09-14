from pathlib import Path
import re
import csv

from .format_doc import FormatDocument


class TibetanDocument:
    def __init__(self, in_file, template=None, debug=False):
        self.parsed = []
        self.in_file = Path(in_file)
        self.debug = debug
        self.__parse()
        self.fd = FormatDocument(template=template)

    def format(self, out_folder, template=None):
        out_file = Path(out_folder) / (self.in_file.stem + '.docx')
        self.fd.format_tibetan(self.parsed, out_file)

    def __parse(self, ):
        LEVEL1_SPLIT_PATTERN = r'\|([^\|]+)\|'
        LEVEL2_SPLIT_PATTERN = r'(\/[^\/]+)\/'
        LEVEL2_BOUNDARY = '/'
        LEVEL2_SPLIT = '-'

        with self.in_file.open(newline='') as csvfile:
            reader = csv.reader(csvfile, delimiter='\t', quotechar='"')
            table = list(reader)
            # remove header
            table.pop(0)
            # keep only first two columns
            lines = []
            for t in table:
                lines.append(''.join(t[:2]))

        raw = '\n'.join(lines)
        # 1. primary segments
        lines = re.split(LEVEL1_SPLIT_PATTERN, raw)
        # remove header
        lines.pop(0)
        while not lines[0]:
            lines = lines[1:]
        segments = [[lines[i], lines[i+1]] for i in range(0, len(lines)-1, 2)]
        # strip segments
        segments = [[a, b.strip()] for a, b in segments]

        # 2. secondary segments
        parsed = []
        for t, text in segments:
            text = re.split(LEVEL2_SPLIT_PATTERN, text)
            # remove empty elements
            while text[-1] == '\n':
                text[-2] += text[-1]
                text = text[:-1]


            if len(text) > 1:
                text_new = []
                for i in text:
                    if i.startswith(LEVEL2_BOUNDARY):
                        ttype, string = i[1:].split(LEVEL2_SPLIT, 1)
                        text_new.append((ttype, string))
                    else:
                        text_new.append(i)
                parsed.append([t, text_new])
            else:
                parsed.append([t, text])
        self.parsed = parsed
