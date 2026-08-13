import json
import math
import pathlib
import re

from shapely import contains_xy, intersects_xy, prepare
from shapely.geometry import shape


def _postcode(properties):
    normalized = {str(key).casefold().replace("_", ""): value for key, value in properties.items()}
    value = str(normalized.get("pincode") or normalized.get("postcode") or normalized.get("zipcode") or "").strip()
    return value if re.fullmatch(r"\d{6}", value) else ""


class SpatialPostcodes:
    def __init__(self, geojson_path, minimum_features=10_000):
        document = json.loads(pathlib.Path(geojson_path).read_text(encoding="utf-8"))
        features = document.get("features", []) if document.get("type") == "FeatureCollection" else []
        entries = []
        grid = {}
        for feature in features:
            postcode = _postcode(feature.get("properties") or {})
            geometry_value = feature.get("geometry")
            if not postcode or not geometry_value:
                continue
            geometry = shape(geometry_value)
            if geometry.is_empty:
                continue
            prepare(geometry)
            entry_index = len(entries)
            entries.append((postcode, geometry))
            minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = geometry.bounds
            for longitude in range(math.floor(minimum_longitude), math.floor(maximum_longitude) + 1):
                for latitude in range(math.floor(minimum_latitude), math.floor(maximum_latitude) + 1):
                    grid.setdefault((longitude, latitude), []).append(entry_index)
        if len(entries) < minimum_features:
            raise RuntimeError(f"Spatial postcode mapping is unexpectedly small: {len(entries)}")
        self.entries = entries
        self.grid = grid

    def resolve(self, tags, longitude=None, latitude=None):
        if str(tags.get("addr:postcode", "")).strip():
            return None
        if not isinstance(longitude, (int, float)) or not isinstance(latitude, (int, float)):
            return None
        matches = set()
        for entry_index in self.grid.get((math.floor(longitude), math.floor(latitude)), ()):
            postcode, geometry = self.entries[entry_index]
            if contains_xy(geometry, longitude, latitude) or intersects_xy(geometry, longitude, latitude):
                matches.add(postcode)
                if len(matches) > 1:
                    return None
        return next(iter(matches)) if len(matches) == 1 else None
