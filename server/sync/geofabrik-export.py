import argparse
import hashlib
import heapq
import json
import math
import pathlib
import re
from html.parser import HTMLParser

import osmium
from osmium.filter import KeyFilter
from shapely import contains_xy, intersects_xy, prepare
from shapely.geometry import LineString, shape
from shapely.ops import unary_union
from spatial_postcodes import SpatialPostcodes
from vietnam_postcodes import VietnamPostcodes


RESIDENTIAL_BUILDINGS = {
    "apartments", "bungalow", "cabin", "detached", "dormitory", "ger",
    "house", "residential", "semidetached_house", "terrace"
}

NON_RESIDENTIAL_POI_KEYS = {
    "amenity", "craft", "healthcare", "industrial", "leisure", "military",
    "office", "public_transport", "shop", "tourism"
}


def normalized_place(value):
    value = re.sub(r"[^0-9a-z]+", " ", value.casefold()).strip()
    value = re.sub(r"^(city|municipality|province) of ", "", value)
    value = re.sub(r" (city|municipality|province)$", "", value)
    return " ".join(value.split())


class PostalTableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.in_cell = False
        self.row = []
        self.cell = []
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "table" and attributes.get("id") == "offices":
            self.in_table = True
        elif self.in_table and tag == "tr":
            self.row = []
        elif self.in_table and tag in {"td", "th"}:
            self.in_cell = True
            self.cell = []

    def handle_data(self, data):
        if self.in_cell:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if self.in_table and tag in {"td", "th"}:
            self.row.append(" ".join("".join(self.cell).split()))
            self.in_cell = False
        elif self.in_table and tag == "tr":
            if self.row:
                self.rows.append(self.row)
            self.row = []
        elif self.in_table and tag == "table":
            self.in_table = False


class PhilippinePostcodes:
    def __init__(self, html_path):
        parser = PostalTableParser()
        parser.feed(pathlib.Path(html_path).read_text(encoding="utf-8"))
        entries = []
        for row in parser.rows:
            if len(row) < 4 or not re.fullmatch(r"\d{4}", row[3]):
                continue
            province = normalized_place(row[1])
            locality = normalized_place(row[2])
            if province and locality:
                entries.append((province, locality, row[3]))
        if len(entries) < 900:
            raise RuntimeError(f"PHLPost mapping is unexpectedly small: {len(entries)}")
        self.by_pair = {}
        self.by_locality = {}
        for province, locality, postcode in entries:
            self.by_pair.setdefault((province, locality), set()).add(postcode)
            self.by_locality.setdefault(locality, set()).add(postcode)

    def resolve(self, tags, longitude=None, latitude=None):
        if tags.get("addr:postcode", "").strip():
            return None
        locality = next((normalized_place(tags.get(key, "")) for key in (
            "addr:city", "addr:town", "addr:municipality", "addr:village"
        ) if tags.get(key, "").strip()), "")
        if not locality:
            return None
        provinces = {
            normalized_place(tags.get(key, "")) for key in (
                "addr:province", "addr:state", "addr:county"
            ) if tags.get(key, "").strip()
        }
        pair_matches = set().union(*(self.by_pair.get((province, locality), set()) for province in provinces))
        if len(pair_matches) == 1:
            return next(iter(pair_matches))
        locality_matches = self.by_locality.get(locality, set())
        return next(iter(locality_matches)) if len(locality_matches) == 1 else None


def has_non_residential_poi(tags):
    return any(
        tags.get(key, "").strip().casefold() not in {"", "no", "none"}
        for key in NON_RESIDENTIAL_POI_KEYS
    )


def rank(value):
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:8], 16)


def point_in_ring(longitude, latitude, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous[:2]
        x2, y2 = current[:2]
        cross_product = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1)
        if abs(cross_product) <= 1e-12 and min(x1, x2) <= longitude <= max(x1, x2) \
                and min(y1, y2) <= latitude <= max(y1, y2):
            return True
        if (y1 > latitude) != (y2 > latitude):
            crossing = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing:
                inside = not inside
        previous = current
    return inside


class CompiledBoundary:
    def __init__(self, geometry):
        self.geometry = geometry
        polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        holes = [LineString(ring.coords) for polygon in polygons for ring in polygon.interiors]
        self.hole_boundaries = unary_union(holes) if holes else None
        prepare(self.geometry)
        if self.hole_boundaries is not None:
            prepare(self.hole_boundaries)

    def contains(self, longitude, latitude):
        return bool(contains_xy(self.geometry, longitude, latitude) or (
            intersects_xy(self.geometry, longitude, latitude)
            and (self.hole_boundaries is None or not intersects_xy(self.hole_boundaries, longitude, latitude))
        ))


def boundary_from_geojson(path):
    if not path:
        return None
    document = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    features = document.get("features", [document]) if document.get("type") == "FeatureCollection" else [document]
    geometries = [shape(feature.get("geometry", feature)) for feature in features]
    boundary = unary_union([geometry for geometry in geometries if not geometry.is_empty])
    return CompiledBoundary(boundary)


class AddressSampler:
    def __init__(self, max_records, per_locality, boundary, exclude_boundary=None, postcodes=None):
        self.max_records = max_records
        self.per_locality = per_locality
        self.maximum_groups = min(max_records, max(1, math.ceil(max_records / 10)))
        self.group_limit = max(1, min(per_locality, max_records))
        self.residential_limit = max_records
        self.boundary = boundary
        self.exclude_boundary = exclude_boundary
        self.postcodes = postcodes
        self.groups = {}
        self.group_heap = []
        self.residential = []

    def inside_boundary(self, longitude, latitude):
        if self.exclude_boundary is not None and self.exclude_boundary.contains(longitude, latitude):
            return False
        if self.boundary is None:
            return True
        return self.boundary.contains(longitude, latitude)

    def capture(self, object_type, object_id, tags, longitude, latitude, residential_building=None):
        if self.postcodes:
            postcode = self.postcodes.resolve(tags, longitude, latitude)
            if postcode:
                tags = {**tags, "addr:postcode": postcode}
        house_number = tags.get("addr:housenumber", "").strip()
        street = (tags.get("addr:street") or tags.get("addr:place") or "").strip()
        if not house_number or not street:
            return
        if has_non_residential_poi(tags):
            return
        if not self.inside_boundary(longitude, latitude):
            return
        locality = next((tags.get(key, "").strip() for key in (
            "addr:city", "addr:town", "addr:village", "addr:municipality", "addr:place", "addr:postcode"
        ) if tags.get(key, "").strip()), "")
        record_id = f"{object_type}/{object_id}"
        record_rank = rank(record_id)
        building = tags.get("building", "").strip().casefold()
        is_residential = building in RESIDENTIAL_BUILDINGS or residential_building is not None
        group_key = locality.casefold() if locality else f"grid:{math.floor(longitude * 10)}:{math.floor(latitude * 10)}"
        group = self.groups.get(group_key)
        if group is None:
            group_rank = rank(group_key)
            accept_group = True
            if len(self.groups) >= self.maximum_groups:
                while self.group_heap and (
                    self.group_heap[0][1] not in self.groups
                    or self.groups[self.group_heap[0][1]]["rank"] != -self.group_heap[0][0]
                ):
                    heapq.heappop(self.group_heap)
                worst_rank, worst_key = (-self.group_heap[0][0], self.group_heap[0][1]) if self.group_heap else (-1, "")
                if group_rank >= worst_rank:
                    accept_group = False
                else:
                    del self.groups[worst_key]
            if accept_group:
                group = {"rank": group_rank, "records": []}
                self.groups[group_key] = group
                heapq.heappush(self.group_heap, (-group_rank, group_key))
        if group is None and not is_residential:
            return
        properties = {"@type": object_type, "@id": f"{object_type}/{object_id}"}
        for key in (
            "addr:housenumber", "addr:street", "addr:state", "addr:province", "addr:city",
            "addr:town", "addr:village", "addr:municipality", "addr:place", "addr:district",
            "addr:subdistrict", "addr:barangay", "addr:ward", "addr:commune",
            "addr:suburb", "addr:county", "addr:postcode", "addr:unit", "addr:flats",
            "addr:country", "name", "building"
        ):
            if key in tags:
                properties[key] = tags[key]
        if residential_building is not None:
            properties.pop("name", None)
            properties["residential_building_id"] = residential_building[0]
            properties["residential_building_class"] = residential_building[1]
        record = json.dumps({
            "type": "Feature",
            "id": record_id,
            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
            "properties": properties
        }, ensure_ascii=False, separators=(",", ":"))
        if group is not None:
            candidate = (-record_rank, record_id, record)
            if len(group["records"]) < self.group_limit:
                heapq.heappush(group["records"], candidate)
            elif record_rank < -group["records"][0][0]:
                heapq.heapreplace(group["records"], candidate)
        if is_residential:
            candidate = (-record_rank, record_id, record)
            if len(self.residential) < self.residential_limit:
                heapq.heappush(self.residential, candidate)
            elif record_rank < -self.residential[0][0]:
                heapq.heapreplace(self.residential, candidate)

    def node(self, node, tags=None, residential_building=None):
        if not node.location.valid():
            return
        self.capture(
            "node", node.id, tags or {tag.k: tag.v for tag in node.tags},
            node.location.lon, node.location.lat, residential_building
        )

    def way(self, way, tags=None):
        tags = tags or {tag.k: tag.v for tag in way.tags}
        if not tags.get("addr:housenumber") or not (tags.get("addr:street") or tags.get("addr:place")):
            return
        locations = [node.location for node in way.nodes if node.location.valid()]
        if not locations:
            return
        self.capture(
            "way", way.id, tags,
            sum(location.lon for location in locations) / len(locations),
            sum(location.lat for location in locations) / len(locations)
        )


class ResidentialBuildingMatcher:
    def __init__(self, sampler):
        self.sampler = sampler
        self.geometry_factory = osmium.geom.GeoJSONFactory()
        self.points_by_tile = {}
        self.matches = {}
        self.inserted = 0
        self.occupied_tiles = set()

    def node(self, node, tags):
        house_number = tags.get("addr:housenumber", "").strip()
        street = (tags.get("addr:street") or tags.get("addr:place") or "").strip()
        if not house_number or not street or not node.location.valid():
            return
        longitude = node.location.lon
        latitude = node.location.lat
        if not self.sampler.inside_boundary(longitude, latitude):
            return
        tile = (math.floor(longitude * 100), math.floor(latitude * 100))
        self.points_by_tile.setdefault(tile, []).append((node.id, longitude, latitude))
        self.occupied_tiles.add(tile)
        self.inserted += 1

    def way(self, way, tags):
        building_class = tags.get("building", "").strip().casefold()
        if building_class not in RESIDENTIAL_BUILDINGS:
            return
        locations = [node.location for node in way.nodes]
        if len(locations) < 4 or not all(location.valid() for location in locations):
            return
        ring = [(location.lon, location.lat) for location in locations]
        if ring[0] != ring[-1]:
            return
        longitudes = [point[0] for point in ring]
        latitudes = [point[1] for point in ring]
        minimum_longitude, maximum_longitude = min(longitudes), max(longitudes)
        minimum_latitude, maximum_latitude = min(latitudes), max(latitudes)
        minimum_tile_longitude = math.floor(minimum_longitude * 100)
        maximum_tile_longitude = math.floor(maximum_longitude * 100)
        minimum_tile_latitude = math.floor(minimum_latitude * 100)
        maximum_tile_latitude = math.floor(maximum_latitude * 100)
        tile_count = (maximum_tile_longitude - minimum_tile_longitude + 1) \
            * (maximum_tile_latitude - minimum_tile_latitude + 1)
        if tile_count <= 10000 and not any(
            (tile_longitude, tile_latitude) in self.occupied_tiles
            for tile_longitude in range(minimum_tile_longitude, maximum_tile_longitude + 1)
            for tile_latitude in range(minimum_tile_latitude, maximum_tile_latitude + 1)
        ):
            return
        candidates = (
            point
            for tile_longitude in range(minimum_tile_longitude, maximum_tile_longitude + 1)
            for tile_latitude in range(minimum_tile_latitude, maximum_tile_latitude + 1)
            for point in self.points_by_tile.get((tile_longitude, tile_latitude), ())
            if minimum_longitude <= point[1] <= maximum_longitude
            and minimum_latitude <= point[2] <= maximum_latitude
        )
        for address_id, longitude, latitude in candidates:
            if not point_in_ring(longitude, latitude, ring):
                continue
            existing = self.matches.get(address_id)
            candidate = (way.id, f"way/{way.id}", building_class)
            if existing is None or candidate[:2] < existing[:2]:
                self.matches[address_id] = candidate

    def area(self, area, tags):
        if area.from_way():
            return
        building_class = tags.get("building", "").strip().casefold()
        if building_class not in RESIDENTIAL_BUILDINGS:
            return
        try:
            geometry = shape(json.loads(self.geometry_factory.create_multipolygon(area)))
        except (RuntimeError, ValueError, json.JSONDecodeError):
            return
        if geometry.is_empty:
            return
        prepare(geometry)
        minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = geometry.bounds
        minimum_tile_longitude = math.floor(minimum_longitude * 100)
        maximum_tile_longitude = math.floor(maximum_longitude * 100)
        minimum_tile_latitude = math.floor(minimum_latitude * 100)
        maximum_tile_latitude = math.floor(maximum_latitude * 100)
        building_id = f"relation/{area.orig_id()}"
        for tile_longitude in range(minimum_tile_longitude, maximum_tile_longitude + 1):
            for tile_latitude in range(minimum_tile_latitude, maximum_tile_latitude + 1):
                for address_id, longitude, latitude in self.points_by_tile.get((tile_longitude, tile_latitude), ()):
                    if not (contains_xy(geometry, longitude, latitude) or intersects_xy(geometry, longitude, latitude)):
                        continue
                    existing = self.matches.get(address_id)
                    candidate = (area.orig_id(), building_id, building_class)
                    if existing is None or candidate[:2] < existing[:2]:
                        self.matches[address_id] = candidate

    def selected_matches(self, limit):
        selected = []
        for address_id, (_, building_id, building_class) in self.matches.items():
            record_id = f"node/{address_id}"
            record_rank = rank(record_id)
            candidate = (-record_rank, address_id, building_id, building_class)
            if len(selected) < limit:
                heapq.heappush(selected, candidate)
            elif record_rank < -selected[0][0]:
                heapq.heapreplace(selected, candidate)
        return {
            address_id: (building_id, building_class)
            for _, address_id, building_id, building_class in selected
        }

    def close(self):
        self.points_by_tile.clear()
        self.matches.clear()


ADMINISTRATIVE_LEVELS = {
    "IN": {4: "admin1", 6: "locality", 8: "locality"},
    "PH": {4: "admin1", 6: "locality", 10: "district"},
    # Vietnam's 2025 two-tier hierarchy uses admin_level=4 provinces and
    # admin_level=6 wards/communes. Older level 8 boundaries are incomplete.
    "VN": {4: "admin1", 6: "ward"}
}

ADMINISTRATIVE_TARGET_TAGS = {
    "admin1": "addr:state",
    "locality": "addr:city",
    "district": "addr:district",
    "ward": "addr:ward"
}


class AdministrativeBoundaryMatcher:
    def __init__(self, country, address_matcher):
        self.country = country
        self.levels = ADMINISTRATIVE_LEVELS.get(country, {})
        self.geometry_factory = osmium.geom.GeoJSONFactory()
        self.points_by_tile = {}
        for points in address_matcher.points_by_tile.values():
            for point in points:
                _, longitude, latitude = point
                tile = (math.floor(longitude * 10), math.floor(latitude * 10))
                self.points_by_tile.setdefault(tile, []).append(point)
        self.matches = {}

    def area(self, area, tags):
        if not self.levels or tags.get("boundary", "").strip().casefold() != "administrative":
            return
        try:
            level = int(tags.get("admin_level", ""))
        except ValueError:
            return
        field = self.levels.get(level)
        name = (tags.get("name:vi", "") if self.country == "VN" else "").strip() \
            or tags.get("name", "").strip()
        if not field or not name:
            return
        try:
            geometry = shape(json.loads(self.geometry_factory.create_multipolygon(area)))
        except (RuntimeError, ValueError, json.JSONDecodeError):
            return
        if geometry.is_empty:
            return
        prepare(geometry)
        minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = geometry.bounds
        for tile_longitude in range(math.floor(minimum_longitude * 10), math.floor(maximum_longitude * 10) + 1):
            for tile_latitude in range(math.floor(minimum_latitude * 10), math.floor(maximum_latitude * 10) + 1):
                for address_id, longitude, latitude in self.points_by_tile.get((tile_longitude, tile_latitude), ()):
                    if not (contains_xy(geometry, longitude, latitude) or intersects_xy(geometry, longitude, latitude)):
                        continue
                    key = (address_id, field)
                    candidate = (geometry.area, -level, name)
                    if key not in self.matches or candidate < self.matches[key]:
                        self.matches[key] = candidate

    def enrich(self, address_id, tags):
        enriched = tags
        for field, target_tag in ADMINISTRATIVE_TARGET_TAGS.items():
            match = self.matches.get((address_id, field))
            authoritative_vietnam_boundary = self.country == "VN" and field in {"admin1", "ward"}
            if match is None or (str(tags.get(target_tag, "")).strip() and not authoritative_vietnam_boundary):
                continue
            if enriched is tags:
                enriched = dict(tags)
            enriched[target_tag] = match[2]
        return enriched

    def close(self):
        self.points_by_tile.clear()
        self.matches.clear()

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--boundary")
parser.add_argument("--exclude-boundary", action="append", default=[])
parser.add_argument("--max-records", required=True, type=int)
parser.add_argument("--per-locality", required=True, type=int)
parser.add_argument("--country", required=True)
parser.add_argument("--postcode-html")
parser.add_argument("--postcode-pdf")
parser.add_argument("--postcode-geojson")
args = parser.parse_args()

if args.postcode_html and args.country != "PH":
    raise RuntimeError("Official PHLPost enrichment is only valid for PH")
if args.postcode_pdf and args.country != "VN":
    raise RuntimeError("Official Vietnam postcode enrichment is only valid for VN")
if args.postcode_geojson and args.country != "IN":
    raise RuntimeError("Official India postcode enrichment is only valid for IN")
if sum(bool(value) for value in (args.postcode_html, args.postcode_pdf, args.postcode_geojson)) > 1:
    raise RuntimeError("Only one postcode enrichment source may be configured")
postcodes = PhilippinePostcodes(args.postcode_html) if args.postcode_html \
    else VietnamPostcodes(args.postcode_pdf) if args.postcode_pdf \
    else SpatialPostcodes(args.postcode_geojson) if args.postcode_geojson else None

exclude_geometries = [boundary_from_geojson(path).geometry for path in args.exclude_boundary]
exclude_boundary = CompiledBoundary(unary_union(exclude_geometries)) if exclude_geometries else None
sampler = AddressSampler(
    args.max_records, args.per_locality, boundary_from_geojson(args.boundary), exclude_boundary, postcodes
)
matcher = ResidentialBuildingMatcher(sampler)
administrative_matcher = None
location_index = None
location_storage = "flex_mem"
if pathlib.Path(args.input).stat().st_size >= 1_000_000_000:
    location_index = pathlib.Path(args.output).with_suffix(pathlib.Path(args.output).suffix + ".locations.idx")
    location_index.unlink(missing_ok=True)
    location_storage = f"sparse_file_array,{location_index}"
filter_keys = ["addr:housenumber", "addr:street", "addr:place", "building", "boundary"]
try:
    processor = osmium.FileProcessor(args.input).with_locations(location_storage) \
        .with_areas(KeyFilter("building", "boundary")).with_filter(KeyFilter(*filter_keys))
    try:
        for entity in processor:
            if entity.is_node():
                tags = {tag.k: tag.v for tag in entity.tags}
                matcher.node(entity, tags)
            elif entity.is_way():
                tags = {tag.k: tag.v for tag in entity.tags}
                sampler.way(entity, tags)
                matcher.way(entity, tags)
            elif entity.is_area():
                tags = {tag.k: tag.v for tag in entity.tags}
                matcher.area(entity, tags)
                if administrative_matcher is None and args.country != "VN" \
                        and ADMINISTRATIVE_LEVELS.get(args.country):
                    administrative_matcher = AdministrativeBoundaryMatcher(args.country, matcher)
                if administrative_matcher is not None:
                    administrative_matcher.area(entity, tags)
    finally:
        del processor
        if location_index:
            location_index.unlink(missing_ok=True)
    if args.country == "VN":
        administrative_matcher = AdministrativeBoundaryMatcher(args.country, matcher)
        processor = osmium.FileProcessor(args.input).with_locations(location_storage) \
            .with_areas(KeyFilter("boundary")).with_filter(KeyFilter("boundary"))
        try:
            for entity in processor:
                if entity.is_area():
                    administrative_matcher.area(entity, {tag.k: tag.v for tag in entity.tags})
        finally:
            del processor
            if location_index:
                location_index.unlink(missing_ok=True)
    selected_matches = matcher.selected_matches(args.max_records)
    if selected_matches or ADMINISTRATIVE_LEVELS.get(args.country):
        processor = osmium.FileProcessor(args.input).with_filter(KeyFilter("addr:housenumber", "addr:street", "addr:place"))
        try:
            for entity in processor:
                if not entity.is_node() or not entity.location.valid():
                    continue
                tags = {tag.k: tag.v for tag in entity.tags}
                residential_building = selected_matches.get(entity.id)
                if residential_building is None \
                        and tags.get("building", "").strip().casefold() not in RESIDENTIAL_BUILDINGS:
                    continue
                if administrative_matcher is not None:
                    tags = administrative_matcher.enrich(entity.id, tags)
                sampler.node(entity, tags, residential_building)
        finally:
            del processor
finally:
    matcher.close()
    if administrative_matcher is not None:
        administrative_matcher.close()
selected = sorted(
    ((-negative_rank, record_id, record)
     for group in sampler.groups.values()
     for negative_rank, record_id, record in group["records"]),
    key=lambda item: item[0]
)[:args.max_records]
residential_selected = sorted(
    ((-negative_rank, record_id, record) for negative_rank, record_id, record in sampler.residential),
    key=lambda item: item[0]
)
combined = []
seen = set()
for _, record_id, record in residential_selected + selected:
    if record_id in seen:
        continue
    seen.add(record_id)
    combined.append(record)
    if len(combined) >= args.max_records:
        break
if not combined:
    raise RuntimeError("Geofabrik extract produced no valid address objects")
pathlib.Path(args.output).write_text("\n".join(combined) + "\n", encoding="utf-8")
