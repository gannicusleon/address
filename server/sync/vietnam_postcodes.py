import re
import unicodedata
from collections import defaultdict


def _fold(value):
    value = unicodedata.normalize("NFD", str(value or "").casefold()).replace("đ", "d")
    return "".join(character for character in value if unicodedata.category(character) != "Mn")


def normalized_vietnamese_place(value):
    value = _fold(value).strip()
    value = re.sub(
        r"^(?:tinh|tp\.?|thanh pho|xa|x\.?|phuong|p\.?|dac khu|thi tran)\s+",
        "",
        value
    )
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())


def extract_vietnam_postcode_rows(path):
    from pypdf import PdfReader

    province = None
    rows = []
    malformed = 0
    for page in PdfReader(path).pages[1:]:
        for line in page.extract_text(extraction_mode="layout").splitlines():
            line = " ".join(line.split())
            province_match = re.fullmatch(r"\d+\s+(.+)", line)
            if province_match:
                candidate = _fold(province_match.group(1)).strip()
                if candidate.startswith(("tinh ", "tp. ", "tp ")):
                    province = province_match.group(1)
                    continue
            row_match = re.fullmatch(r"\d+\s+(.+?)\s+(\d{5})", line)
            if row_match and province:
                locality, postcode = row_match.groups()
                locality_prefix = _fold(locality).strip()
                if locality_prefix.startswith(("x. ", "x ", "p. ", "p ", "dac khu ")):
                    rows.append((province, locality, postcode))
                elif "#VALUE!" in locality:
                    malformed += 1
            elif province and "#VALUE!" in line:
                malformed += 1
    return rows, malformed


class VietnamPostcodes:
    def __init__(self, pdf_path):
        rows, malformed = extract_vietnam_postcode_rows(pdf_path)
        provinces = {normalized_vietnamese_place(province) for province, _, _ in rows}
        if len(rows) < 3300 or len(provinces) != 34:
            raise RuntimeError(
                f"Vietnam postcode mapping is unexpectedly small: rows={len(rows)} provinces={len(provinces)}"
            )
        self._load(rows, malformed)

    @classmethod
    def from_rows(cls, rows):
        instance = cls.__new__(cls)
        instance._load(rows, 0)
        return instance

    def _load(self, rows, malformed):
        by_pair = defaultdict(set)
        for province, locality, postcode in rows:
            if re.fullmatch(r"\d{5}", postcode):
                by_pair[(
                    normalized_vietnamese_place(province),
                    normalized_vietnamese_place(locality)
                )].add(postcode)
        self.by_pair = dict(by_pair)
        self.row_count = len(rows)
        self.malformed_count = malformed
        self.ambiguous_key_count = sum(len(postcodes) != 1 for postcodes in self.by_pair.values())
        self.ambiguous_row_count = sum(len(postcodes) for postcodes in self.by_pair.values() if len(postcodes) != 1)
        self.unique_key_count = sum(len(postcodes) == 1 for postcodes in self.by_pair.values())

    def resolve(self, tags, longitude=None, latitude=None):
        if str(tags.get("addr:postcode", "")).strip():
            return None
        provinces = {
            normalized_vietnamese_place(tags.get(key, ""))
            for key in ("addr:province", "addr:state") if str(tags.get(key, "")).strip()
        }
        localities = {
            normalized_vietnamese_place(tags.get(key, ""))
            for key in (
                "addr:ward", "addr:commune", "addr:subdistrict", "addr:city",
                "addr:town", "addr:village", "addr:municipality"
            ) if str(tags.get(key, "")).strip()
        }
        matches = set()
        for province in provinces:
            for locality in localities:
                postcodes = self.by_pair.get((province, locality), set())
                if len(postcodes) == 1:
                    matches.update(postcodes)
                elif len(postcodes) > 1:
                    return None
        return next(iter(matches)) if len(matches) == 1 else None
