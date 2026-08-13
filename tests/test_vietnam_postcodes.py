import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server" / "sync"))

from vietnam_postcodes import VietnamPostcodes, extract_vietnam_postcode_rows


class VietnamPostcodesTest(unittest.TestCase):
    def test_extracts_official_layout_rows_and_counts_malformed_cells(self):
        pages = [
            SimpleNamespace(extract_text=lambda **_: "cover"),
            SimpleNamespace(extract_text=lambda **_: """
                1 TINH AN GIANG
                1 X. An Phu 90456
                2 X. Vi nh Hau 90469
                3 #VALUE! 90470
            """)
        ]
        module = SimpleNamespace(PdfReader=lambda _: SimpleNamespace(pages=pages))
        with patch.dict(sys.modules, {"pypdf": module}):
            rows, malformed = extract_vietnam_postcode_rows("fixture.pdf")
        self.assertEqual(rows, [
            ("TINH AN GIANG", "X. An Phu", "90456"),
            ("TINH AN GIANG", "X. Vi nh Hau", "90469")
        ])
        self.assertEqual(malformed, 1)

    def test_resolves_only_a_unique_province_and_locality_pair(self):
        postcodes = VietnamPostcodes.from_rows([
            ("TP. HO CHI MINH", "P. Ben Thanh", "70000"),
            ("TINH DONG NAI", "X. Loc Thanh", "67614"),
            ("TINH DONG NAI", "X. Loc Thanh", "67611")
        ])
        self.assertEqual(postcodes.resolve({
            "addr:province": "Thanh pho Ho Chi Minh", "addr:ward": "Phuong Ben Thanh"
        }), "70000")
        self.assertEqual(postcodes.resolve({
            "addr:province": "Thanh pho Ho Chi Minh", "addr:ward": "Ben Thanh"
        }), "70000")
        self.assertIsNone(postcodes.resolve({
            "addr:province": "Tinh Dong Nai", "addr:commune": "Xa Loc Thanh"
        }))
        self.assertIsNone(postcodes.resolve({"addr:ward": "Phuong Ben Thanh"}))
        self.assertIsNone(postcodes.resolve({
            "addr:province": "Thanh pho Ho Chi Minh", "addr:ward": "Phuong Ben Thanh",
            "addr:postcode": "70001"
        }))

    def test_normalizes_special_zone_prefixes(self):
        postcodes = VietnamPostcodes.from_rows([
            ("TINH KIEN GIANG", "DAC KHU PHU QUOC", "92500")
        ])
        self.assertEqual(postcodes.resolve({
            "addr:state": "Tinh Kien Giang", "addr:ward": "Phu Quoc"
        }), "92500")


if __name__ == "__main__":
    unittest.main()
