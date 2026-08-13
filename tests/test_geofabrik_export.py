import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


EXPORTER = pathlib.Path(__file__).parents[1] / "server" / "sync" / "geofabrik-export.py"
HAS_DEPENDENCIES = all(importlib.util.find_spec(module) is not None for module in ("osmium", "shapely"))


@unittest.skipUnless(HAS_DEPENDENCIES, "geofabrik exporter dependencies are not installed")
class GeofabrikExportTest(unittest.TestCase):
    def test_address_point_inside_residential_multipolygon_is_classified(self):
        osm = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="address-test">
  <node id="1" version="1" lat="0.5" lon="0.5">
    <tag k="addr:housenumber" v="12"/>
    <tag k="addr:street" v="Main Street"/>
    <tag k="addr:city" v="Test City"/>
    <tag k="addr:state" v="Test State"/>
    <tag k="addr:suburb" v="Test District"/>
    <tag k="addr:postcode" v="12345-678"/>
  </node>
  <node id="2" version="1" lat="0" lon="0"/>
  <node id="3" version="1" lat="0" lon="1"/>
  <node id="4" version="1" lat="1" lon="1"/>
  <node id="5" version="1" lat="1" lon="0"/>
  <way id="10" version="1">
    <nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/>
  </way>
  <relation id="20" version="1">
    <member type="way" ref="10" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="building" v="residential"/>
  </relation>
</osm>
"""
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "fixture.osm"
            output = pathlib.Path(directory) / "addresses.geojsonseq"
            source.write_text(osm, encoding="utf-8")
            subprocess.run([
                sys.executable, str(EXPORTER), "--input", str(source), "--output", str(output),
                "--max-records", "10", "--per-locality", "10", "--country", "BR"
            ], check=True, capture_output=True, text=True)
            records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["properties"]["residential_building_id"], "relation/20")
        self.assertEqual(records[0]["properties"]["residential_building_class"], "residential")

    def test_ph_address_is_enriched_from_administrative_boundaries(self):
        osm = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="address-test">
  <node id="1" version="1" lat="0.5" lon="0.5">
    <tag k="addr:housenumber" v="12"/>
    <tag k="addr:street" v="Main Street"/>
    <tag k="building" v="house"/>
  </node>
  <node id="2" version="1" lat="0" lon="0"/>
  <node id="3" version="1" lat="0" lon="1"/>
  <node id="4" version="1" lat="1" lon="1"/>
  <node id="5" version="1" lat="1" lon="0"/>
  <way id="10" version="1">
    <nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/>
  </way>
  <relation id="20" version="1">
    <member type="way" ref="10" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="4"/>
    <tag k="name" v="Test Province"/>
  </relation>
  <relation id="21" version="1">
    <member type="way" ref="10" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="6"/>
    <tag k="name" v="Test City"/>
  </relation>
</osm>
"""
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "fixture.osm"
            output = pathlib.Path(directory) / "addresses.geojsonseq"
            source.write_text(osm, encoding="utf-8")
            subprocess.run([
                sys.executable, str(EXPORTER), "--input", str(source), "--output", str(output),
                "--max-records", "10", "--per-locality", "10", "--country", "PH"
            ], check=True, capture_output=True, text=True)
            records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["properties"]["addr:state"], "Test Province")
        self.assertEqual(records[0]["properties"]["addr:city"], "Test City")

    def test_vn_address_uses_current_province_and_ward_boundaries(self):
        osm = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="address-test">
  <node id="1" version="1" lat="0.5" lon="0.5">
    <tag k="addr:housenumber" v="12"/>
    <tag k="addr:street" v="Đường Nguồn"/>
    <tag k="addr:state" v="Old Province"/>
    <tag k="building" v="house"/>
  </node>
  <node id="2" version="1" lat="0" lon="0"/>
  <node id="3" version="1" lat="0" lon="1"/>
  <node id="4" version="1" lat="1" lon="1"/>
  <node id="5" version="1" lat="1" lon="0"/>
  <way id="10" version="1">
    <nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/>
  </way>
  <relation id="20" version="1">
    <member type="way" ref="10" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="4"/>
    <tag k="name" v="English Province"/>
    <tag k="name:vi" v="Tỉnh Mới"/>
  </relation>
  <relation id="21" version="1">
    <member type="way" ref="10" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="6"/>
    <tag k="name" v="Phường Mới"/>
  </relation>
</osm>
"""
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "fixture.osm"
            output = pathlib.Path(directory) / "addresses.geojsonseq"
            source.write_text(osm, encoding="utf-8")
            subprocess.run([
                sys.executable, str(EXPORTER), "--input", str(source), "--output", str(output),
                "--max-records", "10", "--per-locality", "10", "--country", "VN"
            ], check=True, capture_output=True, text=True)
            records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["properties"]["addr:state"], "Tỉnh Mới")
        self.assertEqual(records[0]["properties"]["addr:ward"], "Phường Mới")


if __name__ == "__main__":
    unittest.main()
