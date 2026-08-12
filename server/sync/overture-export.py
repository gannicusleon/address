import argparse
import json
import math
import os
import pathlib
import re
import sys

import duckdb


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def parquet_input(values):
    if len(values) == 1:
        return sql_string(values[0])
    return "[" + ",".join(sql_string(value) for value in values) + "]"


parser = argparse.ArgumentParser()
parser.add_argument("--country", required=True)
parser.add_argument("--release", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--max-records", type=int, required=True)
parser.add_argument("--per-locality", type=int, required=True)
parser.add_argument("--assets-file", required=True)
parser.add_argument("--building-assets-file", required=True)
parser.add_argument("--bounds", type=float, nargs=4, required=True)
parser.add_argument("--candidate-jsonl")
parser.add_argument("--postcode-pattern")
args = parser.parse_args()

if not args.country.isalpha() or len(args.country) != 2:
    raise ValueError("country must be an ISO alpha-2 code")
if args.max_records < 1 or args.per_locality < 1:
    raise ValueError("record limits must be positive")

memory_limit = os.environ.get("ADDRESS_SYNC_OVERTURE_MEMORY_LIMIT", "4GB").strip().upper()
if not re.fullmatch(r"[1-9]\d*(?:\.\d+)?(?:MB|GB)", memory_limit):
    raise ValueError("ADDRESS_SYNC_OVERTURE_MEMORY_LIMIT must be a positive MB or GB value")
try:
    worker_threads = int(os.environ.get("ADDRESS_SYNC_OVERTURE_THREADS", "2"))
except ValueError as error:
    raise ValueError("ADDRESS_SYNC_OVERTURE_THREADS must be an integer between 1 and 8") from error
if not 1 <= worker_threads <= 8:
    raise ValueError("ADDRESS_SYNC_OVERTURE_THREADS must be an integer between 1 and 8")

assets = json.loads(pathlib.Path(args.assets_file).read_text(encoding="utf-8"))
if (not isinstance(assets, list)
        or (not args.candidate_jsonl and not assets)
        or not all(isinstance(value, str) and value.startswith("https://") for value in assets)):
    raise ValueError("assets-file must contain HTTPS GeoParquet URLs")
building_asset_values = json.loads(pathlib.Path(args.building_assets_file).read_text(encoding="utf-8"))
if not isinstance(building_asset_values, list):
    raise ValueError("building-assets-file must contain HTTPS GeoParquet URLs")
building_asset_entries = []
for value in building_asset_values:
    if isinstance(value, str) and value.startswith("https://"):
        building_asset_entries.append({"url": value, "bbox": None})
    elif (isinstance(value, dict) and isinstance(value.get("url"), str)
          and value["url"].startswith("https://") and isinstance(value.get("bbox"), list)
          and len(value["bbox"]) >= 4):
        building_asset_entries.append({"url": value["url"], "bbox": value["bbox"][:4]})
    else:
        raise ValueError("building-assets-file must contain HTTPS GeoParquet URLs with optional bboxes")
building_assets = [entry["url"] for entry in building_asset_entries]
output_path = pathlib.Path(args.output).resolve()
duckdb_home = output_path.parent / "duckdb-home"
duckdb_home.mkdir(parents=True, exist_ok=True)

connection = duckdb.connect()
connection.execute(f"SET home_directory={sql_string(str(duckdb_home))}")
connection.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
connection.execute("SET preserve_insertion_order=false")
connection.execute(f"SET threads={worker_threads}")
connection.execute("SET enable_http_metadata_cache=true")
connection.execute("SET http_keep_alive=true")
connection.execute("SET http_retries=10")
connection.execute("SET http_retry_wait_ms=250")
connection.execute("SET http_timeout=120")
temporary_directory = output_path.parent / "duckdb-temp"
temporary_directory.mkdir(parents=True, exist_ok=True)
connection.execute(f"SET memory_limit={sql_string(memory_limit)}")
connection.execute(f"SET temp_directory={sql_string(str(temporary_directory))}")
output = sql_string(str(output_path))
country = sql_string(args.country.upper())
minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = args.bounds
if not (-180 <= minimum_longitude < maximum_longitude <= 180
        and -90 <= minimum_latitude < maximum_latitude <= 90):
    raise ValueError("bounds must be a valid minLon minLat maxLon maxLat box")
candidate_limit = args.max_records
candidate_grid_scale = 100
postcode_filter = ("TRUE" if not args.postcode_pattern else
                   f"regexp_full_match(coalesce(trim(postcode), ''), {sql_string(args.postcode_pattern)})")

if args.candidate_jsonl:
    candidate_file = pathlib.Path(args.candidate_jsonl).resolve()
    if not candidate_file.is_file():
        raise ValueError("candidate-jsonl must be an existing file")
    candidate_query = f"""
CREATE TEMP TABLE address_candidates AS
  SELECT
    0 AS priority,
    id, country, admin1, locality, postal_city, district,
    address_levels, postcode, street, number, unit,
    longitude, latitude, source_dataset, source_record_id,
    ST_Point(longitude, latitude) AS geometry
  FROM read_json_auto({sql_string(str(candidate_file))}, format='newline_delimited')
  WHERE country = {country}
    AND {postcode_filter}
    AND longitude BETWEEN {minimum_longitude} AND {maximum_longitude}
    AND latitude BETWEEN {minimum_latitude} AND {maximum_latitude}
  LIMIT {candidate_limit};
"""
else:
    candidate_scan_limit = min(candidate_limit * 2, 600000)
    per_asset_limit = max(1, math.ceil(candidate_scan_limit / len(assets)))
    asset_queries = []
    for asset in assets:
        asset_queries.append(f"""
    SELECT * FROM (
    SELECT
      id,
      country,
      coalesce(address_levels[1].value, '') AS admin1,
      coalesce(
        nullif(trim(postal_city), ''),
        CASE WHEN len(address_levels) >= 3 THEN address_levels[-2].value ELSE address_levels[-1].value END,
        ''
      ) AS locality,
      coalesce(postal_city, '') AS postal_city,
      coalesce(address_levels[-1].value, '') AS district,
      list_transform(address_levels, address_level -> coalesce(address_level.value, '')) AS address_levels,
      coalesce(postcode, '') AS postcode,
      street,
      number,
      coalesce(unit, '') AS unit,
      ST_X(geometry) AS longitude,
      ST_Y(geometry) AS latitude,
      coalesce(sources[1].dataset, 'Overture Maps addresses') AS source_dataset,
      coalesce(sources[1].record_id, id) AS source_record_id,
      geometry
    FROM read_parquet({sql_string(asset)}, union_by_name=true)
    WHERE country = {country}
      AND {postcode_filter}
      AND bbox.xmin >= {minimum_longitude}
      AND bbox.xmax <= {maximum_longitude}
      AND bbox.ymin >= {minimum_latitude}
      AND bbox.ymax <= {maximum_latitude}
      AND nullif(trim(street), '') IS NOT NULL
      AND nullif(trim(number), '') IS NOT NULL
      AND geometry IS NOT NULL
    ORDER BY hash(id)
    LIMIT {per_asset_limit}
    ) AS sampled_asset
""")
    candidate_sources = "\nUNION ALL\n".join(asset_queries)
    candidate_query = f"""
CREATE TEMP TABLE address_candidates AS
  WITH source AS (
{candidate_sources}
  ), ranked AS (
    SELECT *, row_number() OVER (
      PARTITION BY coalesce(nullif(trim(admin1), ''), '*'),
        coalesce(nullif(trim(locality), ''),
          concat('grid:', floor(latitude * {candidate_grid_scale}), ':',
            floor(longitude * {candidate_grid_scale})))
      ORDER BY hash(id)
    ) AS candidate_locality_rank
    FROM source
  )
  SELECT 0 AS priority, * EXCLUDE (candidate_locality_rank)
  FROM ranked
  ORDER BY candidate_locality_rank,
    hash(coalesce(nullif(trim(admin1), ''), '*')), hash(id)
  LIMIT {candidate_limit};
"""
connection.execute(candidate_query)

candidate_count = connection.execute("SELECT count(*) FROM address_candidates").fetchone()[0]
if candidate_count == 0:
    output_path.write_text("", encoding="utf-8")
    print(
        f"Overture {args.country.upper()} has no address candidates satisfying the required fields",
        file=sys.stderr, flush=True
    )
    connection.close()
    sys.exit(0)
connection.execute(f"""
CREATE TEMP TABLE candidate_grids AS
SELECT DISTINCT
  CAST(floor(longitude * {candidate_grid_scale}) AS INTEGER) AS grid_longitude,
  CAST(floor(latitude * {candidate_grid_scale}) AS INTEGER) AS grid_latitude
FROM address_candidates;
""")
candidate_grids = connection.execute(
    "SELECT grid_longitude,grid_latitude FROM candidate_grids ORDER BY grid_latitude,grid_longitude"
).fetchall()

if not building_assets:
    raise RuntimeError("Residential building classification requires building assets")
else:
    selected_building_assets = [
        entry["url"] for entry in building_asset_entries
        if entry["bbox"] is None or any(
            entry["bbox"][2] >= grid_longitude / candidate_grid_scale
            and entry["bbox"][0] < (grid_longitude + 1) / candidate_grid_scale
            and entry["bbox"][3] >= grid_latitude / candidate_grid_scale
            and entry["bbox"][1] < (grid_latitude + 1) / candidate_grid_scale
            for grid_longitude, grid_latitude in candidate_grids
        )
    ]
    if not selected_building_assets:
        raise RuntimeError("No residential building assets intersect the bounded address candidates")
    print(
        f"Overture {args.country.upper()} classification: candidates={candidate_count} "
        f"grids={len(candidate_grids)} building_assets={len(selected_building_assets)}/{len(building_assets)}",
        file=sys.stderr, flush=True
    )
    building_asset_list = parquet_input(selected_building_assets)
    residential_classes = "(" + ",".join(sql_string(value) for value in (
        "allotment_house", "apartments", "bungalow", "cabin", "detached", "dormitory",
        "dwelling_house", "ger", "house", "houseboat", "residential", "semi",
        "semidetached_house", "static_caravan", "stilt_house", "terrace", "trullo"
    )) + ")"
    connection.execute(f"""
CREATE TEMP TABLE residential_buildings AS
SELECT buildings.id, buildings.class, buildings.geometry, buildings.bbox
FROM read_parquet({building_asset_list}, union_by_name=true) AS buildings
SEMI JOIN candidate_grids ON
  candidate_grids.grid_longitude BETWEEN
    CAST(floor(buildings.bbox.xmin * {candidate_grid_scale}) AS INTEGER)
    AND CAST(floor(buildings.bbox.xmax * {candidate_grid_scale}) AS INTEGER)
  AND candidate_grids.grid_latitude BETWEEN
    CAST(floor(buildings.bbox.ymin * {candidate_grid_scale}) AS INTEGER)
    AND CAST(floor(buildings.bbox.ymax * {candidate_grid_scale}) AS INTEGER)
WHERE buildings.class IN {residential_classes}
  AND buildings.geometry IS NOT NULL
  AND buildings.bbox.xmax >= {minimum_longitude}
  AND buildings.bbox.xmin <= {maximum_longitude}
  AND buildings.bbox.ymax >= {minimum_latitude}
  AND buildings.bbox.ymin <= {maximum_latitude};
""")
    residential_building_count = connection.execute(
        "SELECT count(*) FROM residential_buildings"
    ).fetchone()[0]
    if residential_building_count == 0:
        raise RuntimeError("No residential buildings intersect the bounded address candidate cells")
    print(
        f"Overture {args.country.upper()} buildings: filtered={residential_building_count}",
        file=sys.stderr, flush=True
    )
    classified_query = f"""
COPY (
  WITH matches AS (
    SELECT
      address_candidates.id AS address_id,
      residential_buildings.id AS building_id,
      residential_buildings.class AS building_class,
      row_number() OVER (
        PARTITION BY address_candidates.id
        ORDER BY CASE WHEN residential_buildings.class = 'apartments' THEN 0 ELSE 1 END,
          residential_buildings.id
      ) AS building_rank
    FROM address_candidates
    JOIN residential_buildings
      ON address_candidates.longitude BETWEEN residential_buildings.bbox.xmin AND residential_buildings.bbox.xmax
      AND address_candidates.latitude BETWEEN residential_buildings.bbox.ymin AND residential_buildings.bbox.ymax
      AND ST_Intersects(address_candidates.geometry, residential_buildings.geometry)
  ), classified AS (
    SELECT address_id, building_id, building_class
    FROM matches
    WHERE building_rank = 1
  ), residential_candidates AS (
    SELECT
      address_candidates.*,
      CASE WHEN classified.building_class = 'apartments' THEN 'apartment' ELSE 'residential' END AS property_type,
      classified.building_id AS residential_building_id,
      classified.building_class AS residential_building_class,
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim(address_candidates.admin1), ''), '*')
        ORDER BY hash(address_candidates.id)
      ) AS residential_region_rank,
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim(address_candidates.admin1), ''), '*'),
          coalesce(nullif(trim(address_candidates.locality), ''),
            concat('grid:', floor(address_candidates.latitude), ':', floor(address_candidates.longitude)))
        ORDER BY hash(address_candidates.id)
      ) AS residential_locality_rank
    FROM address_candidates
    JOIN classified ON classified.address_id = address_candidates.id
  ), balanced AS (
    SELECT 0 AS residential_priority, * EXCLUDE (residential_region_rank, residential_locality_rank)
    FROM residential_candidates WHERE residential_region_rank = 1
    UNION ALL
    SELECT 1 AS residential_priority, * EXCLUDE (residential_region_rank, residential_locality_rank)
    FROM residential_candidates
    WHERE residential_region_rank > 1 AND residential_locality_rank <= {args.per_locality}
  )
  SELECT
    balanced.* EXCLUDE (priority, residential_priority, geometry)
  FROM balanced
  ORDER BY residential_priority, hash(coalesce(nullif(trim(admin1), ''), '*')), hash(id)
  LIMIT {args.max_records}
) TO {output} (FORMAT JSON, ARRAY false);
"""
    try:
        connection.execute(classified_query)
    except Exception as error:
        pathlib.Path(args.output).unlink(missing_ok=True)
        raise RuntimeError(f"Residential building classification failed: {error}") from error
