from pathlib import Path
import re
import csv
import requests
from bs4 import BeautifulSoup, NavigableString
from typing import Optional, Union, List, Dict, Tuple

from .format_doc_updated import FormatDocumentUpdated


class BookletDocument:
    def __init__(self, in_file: Union[str, Path], template=None, no_phon=False, debug=False,
                 google_sheets_url = True):
        self.no_phon = no_phon
        self.parsed = []
        self.debug = debug
        self.google_sheets_url = google_sheets_url
        self.in_file = Path(in_file)

        self.__parse()
        self.fd = FormatDocumentUpdated(template=template)

    def format(self, out_folder):
        if self.no_phon:
            out_file = Path(out_folder) / (self.in_file.stem + '_nophon.docx')
        else:
            out_file = Path(out_folder) / (self.in_file.stem + '.docx')
        self.fd.format_booklet(self.parsed, out_file, no_phon=self.no_phon)

    def __extract_formatted_text(self, cell):
        """
        Extract text from a cell while preserving formatting information.
        Returns a list of tuples: (text, formatting_dict)
        where formatting_dict contains: {'bold': bool, 'italic': bool}
        """
        if not cell:
            return [("", {'bold': False, 'italic': False})]

        formatted_parts = []

        def process_element(element, parent_bold=False, parent_italic=False):
            if isinstance(element, NavigableString):
                text = str(element)
                if text:
                    formatted_parts.append((text, {
                        'bold': parent_bold,
                        'italic': parent_italic
                    }))
            else:
                # Check if current element adds formatting
                if element.attrs:
                    style = element.attrs['style']
                    if parent_bold or "bold" in style:
                        is_bold = True
                    else:
                        is_bold = False
                    if parent_italic or "italic" in style:
                        is_italic = True
                    else:
                        is_italic = False

                    # Process children
                    for child in element.children:
                        process_element(child, is_bold, is_italic)

        # Process all children of the cell
        for child in cell.children:
            if cell.attrs['class'][0] == 's4':
                process_element(child, parent_italic=True)
            else:
                process_element(child)

        # If no formatted parts were found, return plain text
        if not formatted_parts:
            text = cell.get_text(strip=True)
            return [(text, {'bold': False, 'italic': False})] if text else [("", {'bold': False, 'italic': False})]

        return formatted_parts

    def __formatted_text_to_string(self, formatted_parts):
        """
        Convert formatted text parts to a single string with formatting markers.
        Uses markdown-style markers: **bold** and *italic*
        """
        result = []
        for text, fmt in formatted_parts:
            if not text:
                continue

            # Apply formatting markers
            if fmt['bold'] and fmt['italic']:
                result.append(f"***{text}***")
            elif fmt['bold']:
                result.append(f"**{text}**")
            elif fmt['italic']:
                result.append(f"*{text}*")
            else:
                result.append(text)

        # Join with spaces, but handle punctuation
        text = ""
        for i, part in enumerate(result):
            if i == 0:
                text = part
            else:
                # Add space before part unless it starts with punctuation or previous part ends with opening quote/parenthesis
                if (part and part[0] not in '.,;:!?)' and
                        text and text[-1] not in '("\''):
                    text += " " + part
                else:
                    text += part

        return text

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

    def __parse(self):
        LEVEL2_SPLIT_PATTERN = r'(\/[^\/]+)\/'
        LEVEL2_BOUNDARY = '/'
        LEVEL2_SPLIT = '-'

        if self.google_sheets_url:
            # Fetch data from Google Sheets
            table_data = self.__parse_html()

            if not table_data:
                raise ValueError("No data found in Google Sheets")

            # Extract headers from the first row
            headers, _ = table_data[1]

            # Map Google Sheets columns to expected column names
            column_mapping = {
                'hub': 'hub',
                'Tibetan- no phonetics': 'Tibetan-no phon',
                'Translation': 'Translation',
                'Tibetan': 'Tibetan',
                'Phonetics': 'Phonetics',
                'Sanskrit': 'Sanskrit',
                'Sanskrit phonetics': 'Sanskrit phon',
                'Translation reference': 'TranslationRef',  # Keep this for potential future use
            }

            # Find column indices in the Google Sheets data
            keys = {}
            translation_col_idx = None
            for idx, header in enumerate(headers):
                header = header.strip()
                if header in column_mapping and column_mapping[header]:
                    keys[column_mapping[header]] = idx
                    if column_mapping[header] == 'Translation':
                        translation_col_idx = idx

            # Ensure we have all required columns
            required_columns = ['hub', 'Tibetan-no phon', 'Translation', 'Tibetan', 'Phonetics', 'Sanskrit', 'Sanskrit phon']
            for col in required_columns:
                if col not in keys:
                    # Try to find column with partial match
                    for idx, header in enumerate(headers):
                        if col.lower() in header.lower():
                            keys[col] = idx
                            if col == 'Translation':
                                translation_col_idx = idx
                            break

            # Process the table data
            table = []
            formatted_translations = []

            for row_data, formatted_row in table_data[2:]:  # Skip header row
                table.append(row_data)

                # Extract formatted text from translation column
                if translation_col_idx is not None and translation_col_idx < len(formatted_row):
                    formatted_text = self.__extract_formatted_text(formatted_row[translation_col_idx])
                    formatted_translations.append(formatted_text)
                else:
                    formatted_translations.append([("", {'bold': False, 'italic': False})])

        else:
            # Original file-based parsing
            PHON = 'Phonetics'
            SKT = 'Sanskrit phon'
            TIB = 'Tibetan'
            TIB_NOPHON = 'Tibetan- no phonetics'
            TRANS = 'Translation'
            HUB = 'hub'

            with self.in_file.open(newline='') as csvfile:
                reader = csv.reader(csvfile, delimiter='\t', quotechar='"')
                table = list(reader)
            keys = {k: n for n, k in enumerate(table[0])}
            table = table[1:]

            # No formatting information for file-based input
            formatted_translations = None

        # 1. from lines to raw segments (groups of lines)
        segments_raw = []
        cur_seg = []
        cur_seg_formatted = []

        for i, line in enumerate(table):
            # Ensure line has enough columns
            if len(line) <= max(keys.values()):
                # Pad with empty strings if needed
                line.extend([''] * (max(keys.values()) + 1 - len(line)))

            hub_value = line[keys.get('hub', 0)] if 'hub' in keys else ''

            # Store formatted translation if available
            formatted_trans = formatted_translations[i] if formatted_translations and i < len(
                formatted_translations) else None

            if not hub_value.startswith('|'):
                cur_seg.append(line)
                cur_seg_formatted.append(formatted_trans)
            else:
                if cur_seg:
                    # remove trailing empty line
                    if not [c for c in cur_seg[-1] if c.strip()]:
                        cur_seg.pop()
                        if cur_seg_formatted:
                            cur_seg_formatted.pop()
                    segments_raw.append((cur_seg, cur_seg_formatted))
                    cur_seg = []
                    cur_seg_formatted = []
                cur_seg.append(line)
                cur_seg_formatted.append(formatted_trans)

        # last segment
        if cur_seg:
            # remove trailing empty line
            if not [c for c in cur_seg[-1] if c.strip()]:
                cur_seg.pop()
                if cur_seg_formatted:
                    cur_seg_formatted.pop()
            segments_raw.append((cur_seg, cur_seg_formatted))

        # parse segments
        segments_parsed = []
        for seg_data in segments_raw:
            seg, seg_formatted = seg_data

            if self.debug:
                print(seg)

            hub_value = seg[0][keys.get('hub', 0)] if seg and 'hub' in keys else ''
            seg_type = hub_value.strip('|')
            content = []

            for j, line in enumerate(seg):
                cur = {
                    'phon': line[keys['Phonetics']] if 'Phonetics' in keys else '',
                    'tib': line[keys['Tibetan']] if 'Tibetan' in keys else '',
                    'skt': line[keys['Sanskrit phon']] if 'Sanskrit phon' in keys else ''
                }

                # Get formatted translation if available
                if seg_formatted and j < len(seg_formatted) and seg_formatted[j]:
                    # Convert formatted parts to string with formatting markers
                    trans_text = self.__formatted_text_to_string(seg_formatted[j])
                    # Store both plain and formatted versions
                    cur['trans_formatted'] = seg_formatted[j]
                else:
                    trans_text = line[keys['Translation']] if 'Translation' in keys else ''
                    cur['trans_formatted'] = None

                # parse secondary segments in translation
                trans = []
                parts = re.split(LEVEL2_SPLIT_PATTERN, trans_text)

                # remove empty initial elements
                while parts and len(parts) > 1 and not parts[0]:
                    parts = parts[1:]

                if len(parts) > 1:
                    parts_new = []
                    for i in parts:
                        if i.startswith(LEVEL2_BOUNDARY):
                            if LEVEL2_SPLIT in i[1:]:
                                ttype, string = i[1:].split(LEVEL2_SPLIT, 1)
                                parts_new.append((ttype, string))
                            else:
                                # Handle case where there's no split character
                                parts_new.append(i)
                        else:
                            parts_new.append(i)
                    trans.extend(parts_new)
                else:
                    trans.extend(parts)

                cur['trans'] = trans
                content.append(cur)

            # del empty string in trans if the current segment has no translation at all
            if len(content) == 1 and content[0]['trans'] and not content[0]['trans'][0]:
                content[0]['trans'].pop()

            segments_parsed.append((seg_type, content))

        self.parsed = segments_parsed