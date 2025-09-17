from pathlib import Path
import re
import csv
import sys

from bs4 import BeautifulSoup, NavigableString

from .format_doc_updated import FormatDocumentUpdated

csv.field_size_limit(sys.maxsize)


class TibetanDocument:
    def __init__(self, in_file, template=None, debug=False):
        self.parsed = []
        self.in_file = Path(in_file)
        self.debug = debug
        self.__parse()
        self.fd = FormatDocumentUpdated(template=template)

    def format(self, out_folder, template=None):
        out_file = Path(out_folder) / (self.in_file.stem + '.docx')
        self.fd.format_tibetan(self.parsed, out_file)

    def __extract_formatted_text(self, cells):
        """
        Extract text from a cell while preserving formatting information.
        Returns a list of tuples: (text, formatting_dict)
        where formatting_dict contains: {'bold': bool, 'italic': bool}
        """
        SMALL_LETTER_MAX_SIZE = 10

        def remove_multiple_newlines(parts):
            for n, p in enumerate(parts):
                text, style = p
                if 'ཀརྨ་ཐོད་ཕྲེང་གི་དྲ' in text:
                    print()

                text = re.sub(r'\n+', '\n', text)
                parts[n] = (text, style)
            return parts

        formatted = []
        for cell in cells:
            cell = str(cell)
            cell = re.sub(r'<td[^>]+>(.*?)</td>', r'\1', cell) # remove td tag
            cell = cell.replace('<br/>', '\n')
            if 'span' in cell:
                parts = []
                spans = re.split(r'(<span.*?</span>)', cell)
                for s in spans:
                    if 'span' in s:
                        size = re.findall(r'font-size:([0-9]+)pt', s)[0]
                        size = int(size)
                        if size <= SMALL_LETTER_MAX_SIZE:
                            style = {'small letters': True}
                        else:
                            style = {'small letters': False}
                        text = re.findall(r'<span[^>]+>(.*?)</span>', s)[0]
                        parts.append((text, style))
                    else:
                        style = {'small letters': False}
                        parts.append((s, style))
                parts[-1] = (parts[-1][0]+'\n', parts[-1][1])
                parts = remove_multiple_newlines(parts)
                formatted.extend(parts)
            else:
                style = {'small letters': False}
                parts = remove_multiple_newlines([(cell+'\n', style)])
                formatted.extend(parts)

        # remove trailing newlines
        while formatted and formatted[-1][0] == '\n':
            formatted = formatted[:-1]
        return formatted

    def __parse_html(self):
        raw_html = self.in_file.read_text()
        soup = BeautifulSoup(raw_html, 'html.parser')

        # Find the table
        table = soup.find('table')

        if not table:
            raise ValueError("No table found in the Google Sheets HTML")

        # Extract all rows with formatting information
        rows = []
        for tr in table.find_all('tr'):
            row = []
            formatted_row = []
            for td in tr.find_all(['td', 'th']):
                # Get plain text for non-translation columns
                text = td.get_text(strip=True)
                row.append(text)

                # Store the cell element for later formatting extraction
                formatted_row.append(td)

            rows.append((row, formatted_row))

        return rows

    def __parse(self, ):
        LEVEL1_SPLIT_PATTERN = r'\|([^\|]+)\|'
        LEVEL2_SPLIT_PATTERN = r'(\/[^\/]+)\/'
        LEVEL2_BOUNDARY = '/'
        LEVEL2_SPLIT = '-'

        # Fetch data from Google Sheets
        table_data = self.__parse_html()

        if not table_data:
            raise ValueError("No data found in Google Sheets")

        # Extract headers from the first row
        headers, _ = table_data[1]
        hub, tibetan =  None, None
        for n, h in enumerate(headers):
            if h == 'Tibetan':
                tibetan = n
            if h == 'hub':
                hub = n
        if not hub or not tibetan:
            raise ValueError("the tibetan sheet should have a column named 'Tibetan' and another column named 'hub'")

        # keep only first two columns
        segments = []
        cur_type = None
        cur_cells = []
        for raw, html in table_data[2:]:
            if not ''.join(raw):
                continue

            if not cur_type:
                cur_type = raw[hub]

            if raw[hub] == cur_type or raw[hub] == '':
                cur_cells.append(html[tibetan])
            else:
                segments.append((cur_type, cur_cells))
                cur_cells = []

                cur_type = raw[hub]
                cur_cells.append(html[tibetan])

        parsed = []
        for t, text in segments:
            t = t.replace('|', '')

            formatted_cells = self.__extract_formatted_text(text)
            parsed.append((t, formatted_cells))
        self.parsed = parsed
