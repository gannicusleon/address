import json
import pathlib
import sys
import tempfile
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server" / "sync"))

from spatial_postcodes import SpatialPostcodes


class SpatialPostcodesTest(unittest.TestCase):
    def test_resolves_only_an_unambiguous_containing_polygon(self):
        feature = lambda postcode, coordinates: {
            "type": "Feature",
            "properties": {"Pincode": postcode},
            "geometry": {"type": "Polygon", "coordinates": [coordinates]}
        }
        document = {
            "type": "FeatureCollection",
            "features": [
                feature("110001", [[77.0, 28.0], [78.0, 28.0], [78.0, 29.0], [77.0, 29.0], [77.0, 28.0]]),
                feature("400001", [[72.0, 18.0], [73.0, 18.0], [73.0, 19.0], [72.0, 19.0], [72.0, 18.0]])
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "postcodes.geojson"
            source.write_text(json.dumps(document), encoding="utf-8")
            postcodes = SpatialPostcodes(source, minimum_features=2)

        self.assertEqual(postcodes.resolve({}, 77.2, 28.5), "110001")
        self.assertIsNone(postcodes.resolve({"addr:postcode": "999999"}, 77.2, 28.5))
        self.assertIsNone(postcodes.resolve({}, 80.0, 25.0))


if __name__ == "__main__":
    unittest.main()
