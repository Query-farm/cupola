# /// script
# requires-python = ">=3.13"
# dependencies = [
#     # Pinned to the VGI wire protocol Cupola's extension build speaks, NOT to
#     # the newest release. VGI_EXTENSION_VERSION in src/lib/duckdb-engine.ts is
#     # protocol 1.3.0, which is vgi-python 0.28.x with the vgi-rpc of that era;
#     # any newer worker rejects every request with ProtocolVersionError
#     # ("client is too old"), and vgi-rpc 0.46+ additionally demands a routing
#     # key that build never sends. Move these only together with that pin.
#     # `./run.sh --latest` lifts them for use with `?vgi_version=latest`.
#     "vgi-python[http]>=0.28.1,<0.29",
#     "vgi-rpc>=0.42.2,<0.43",
#     "numpy",
#     "pyarrow",
# ]
# ///
"""Cupola's own VGI test worker: small, large, and awkward datasets on demand.

Everything is synthesized from a seed — no data files, no network — so a row is
the same on every machine and every run, and a spec can assert on exact values.
See README.md for the dataset inventory and how to run it.

    ./run.sh                                   # HTTP on :9009, no auth
    ATTACH 'cupola_test' (TYPE vgi, LOCATION 'uv run stress_worker.py');
"""

import json
import time
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
from vgi_rpc import ArrowSerializableDataclass

from vgi import Arg, Worker
from vgi.arguments import Arguments
from vgi.catalog import Catalog, Schema, Table, View
from vgi.table_function import (
    OutputCollector,
    ProcessParams,
    TableFunctionGenerator,
    bind_fixed_schema,
    init_single_worker,
)

SEED = 20260917

# Rows per process() call. Over HTTP each call is one round trip, so this trades
# request count against response size; the wide table uses a smaller chunk
# because its rows are ~10x heavier.
CHUNK = 50_000
WIDE_CHUNK = 20_000

GEOARROW_WKB = {b"ARROW:extension:name": b"geoarrow.wkb", b"ARROW:extension:metadata": b"{}"}

# ---------------------------------------------------------------------------
# Reference data shared by every dataset, so small and large tables join.
# ---------------------------------------------------------------------------

REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West", "Canada", "Europe", "Asia Pacific"]
REGION_CENTERS = [
    (42.4, -73.9), (33.0, -83.5), (41.6, -90.2), (33.4, -106.1),
    (39.5, -119.8), (50.4, -97.1), (48.9, 9.2), (-2.5, 118.0),
]
CHANNELS = ["Web", "Retail", "Partner", "Phone"]
STATUSES = ["completed", "shipped", "pending", "returned", "cancelled"]
STATUS_WEIGHTS = [0.62, 0.2, 0.08, 0.06, 0.04]
CATEGORIES = [
    "Apparel", "Books", "Electronics", "Garden", "Grocery", "Health",
    "Home", "Music", "Office", "Outdoors", "Pets", "Toys",
]
N_PRODUCTS = 200
N_STORES = 250
N_CUSTOMERS = 50_000
EPOCH_START = np.datetime64("2023-01-01T00:00:00", "us")
SPAN_DAYS = 3 * 365
# Month-of-year demand curve, so trend and seasonality charts have shape.
SEASONALITY = np.array([0.82, 0.78, 0.9, 0.95, 1.0, 1.04, 1.02, 0.98, 1.0, 1.08, 1.3, 1.55])

_products = np.arange(1, N_PRODUCTS + 1)
PRODUCT_PRICE_CENTS = (500 + (_products * 3_719) % 49_500).astype(np.int64)
PRODUCT_CATEGORY = (_products - 1) % len(CATEGORIES)

_stores = np.arange(1, N_STORES + 1)
STORE_REGION = (_stores - 1) % len(REGIONS)
_store_rng = np.random.default_rng([SEED, 1])
STORE_LAT = np.array([REGION_CENTERS[r][0] for r in STORE_REGION]) + _store_rng.normal(0, 2.5, N_STORES)
STORE_LON = np.array([REGION_CENTERS[r][1] for r in STORE_REGION]) + _store_rng.normal(0, 4.0, N_STORES)


def labels(values: list[str], index: np.ndarray) -> pa.Array:
    """Vectorized ``values[index]`` as a plain string column."""
    return pa.array(values).take(pa.array(index))


def decimal_from_cents(cents: np.ndarray, precision: int = 14) -> pa.Array:
    """Non-negative integer cents -> DECIMAL(precision, 2), without a Python loop."""
    words = np.zeros((len(cents), 2), dtype="<u8")
    words[:, 0] = cents
    return pa.Array.from_buffers(pa.decimal128(precision, 2), len(cents), [None, pa.py_buffer(words.tobytes())])


def timestamps(micros: np.ndarray) -> pa.Array:
    return pa.array(micros.astype("datetime64[us]")).cast(pa.timestamp("us", tz="UTC"))


def binary_from_fixed(records: np.ndarray) -> pa.Array:
    """A packed fixed-width numpy record array -> variable BINARY column."""
    width = records.dtype.itemsize
    offsets = (np.arange(len(records) + 1, dtype=np.int64) * width).astype(np.int32)
    return pa.Array.from_buffers(
        pa.binary(), len(records), [None, pa.py_buffer(offsets.tobytes()), pa.py_buffer(records.tobytes())]
    )


WKB_POINT = np.dtype([("order", "u1"), ("type", "<u4"), ("xy", "<f8", (2,))])
WKB_SQUARE = np.dtype([("order", "u1"), ("type", "<u4"), ("rings", "<u4"), ("points", "<u4"), ("xy", "<f8", (10,))])


def wkb_points(lon: np.ndarray, lat: np.ndarray) -> pa.Array:
    records = np.zeros(len(lon), dtype=WKB_POINT)
    records["order"], records["type"] = 1, 1
    records["xy"][:, 0], records["xy"][:, 1] = lon, lat
    return binary_from_fixed(records)


def wkb_squares(lon: np.ndarray, lat: np.ndarray, half: np.ndarray) -> pa.Array:
    """Closed 5-point square polygons centered on (lon, lat)."""
    records = np.zeros(len(lon), dtype=WKB_SQUARE)
    records["order"], records["type"], records["rings"], records["points"] = 1, 3, 1, 5
    for corner, (dx, dy) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]):
        records["xy"][:, corner * 2] = lon + dx * half
        records["xy"][:, corner * 2 + 1] = lat + dy * half
    return binary_from_fixed(records)


# ---------------------------------------------------------------------------
# Generator plumbing
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class Cursor(ArrowSerializableDataclass):
    """How many rows have been emitted; survives HTTP state round-trips."""

    emitted: int = 0


@dataclass(slots=True, frozen=True, kw_only=True)
class NoArgs:
    """Tables and functions that take no arguments."""


@dataclass(slots=True, frozen=True, kw_only=True)
class RowsArgs:
    rows: Annotated[int, Arg(0, doc="Number of rows to generate", ge=0)]


class ChunkedGenerator(TableFunctionGenerator[RowsArgs, Cursor]):
    """Stream ``total_rows`` rows, ``CHUNK_ROWS`` per process() call.

    Subclasses build one chunk from a global row offset. Each chunk seeds its
    own RNG from that offset, so a chunk's contents do not depend on how many
    chunks came before it, and a scan is reproducible row for row.
    """

    CHUNK_ROWS: ClassVar[int] = CHUNK

    @classmethod
    def total_rows(cls, args: Any) -> int:
        return int(args.rows)

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: Any) -> list[pa.Array]:
        raise NotImplementedError

    @classmethod
    def initial_state(cls, params: ProcessParams[Any]) -> Cursor:
        return Cursor()

    @classmethod
    def process(cls, params: ProcessParams[Any], state: Cursor, out: OutputCollector) -> None:
        total = cls.total_rows(params.args)
        if state.emitted >= total:
            out.finish()
            return
        count = min(total - state.emitted, cls.CHUNK_ROWS)
        rng = np.random.default_rng([SEED, state.emitted])
        arrays = cls.chunk(state.emitted, count, total, rng, params.args)
        out.emit(pa.RecordBatch.from_arrays(arrays, schema=params.output_schema))
        state.emitted += count


def order_micros(start: int, count: int, total: int, rng: np.random.Generator) -> np.ndarray:
    """Timestamps spread evenly over the span in row order, plus jitter — so the
    table is time-ordered like a real fact table whatever its row count."""
    span = SPAN_DAYS * 86_400_000_000
    position = (np.arange(start, start + count, dtype=np.float64) + rng.random(count)) / max(total, 1)
    return (position * span).astype(np.int64)


# ---------------------------------------------------------------------------
# Large, row-count-parameterized generators
# ---------------------------------------------------------------------------


@init_single_worker
@bind_fixed_schema
class GenerateOrders(ChunkedGenerator):
    """Retail order lines: the general-purpose fact table for report stress tests."""

    class Meta:
        name = "generate_orders"
        description = "Synthetic retail order lines; rows are deterministic for a given position"
        categories = ["generator"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("order_id", pa.int64()),
        ("order_ts", pa.timestamp("us", tz="UTC")),
        ("order_date", pa.date32()),
        ("region", pa.string()),
        ("store_id", pa.int32()),
        ("channel", pa.string()),
        ("category", pa.string()),
        ("product_id", pa.int32()),
        ("customer_id", pa.int32()),
        ("quantity", pa.int32()),
        ("unit_price", pa.decimal128(14, 2)),
        ("discount_pct", pa.float64()),
        ("revenue", pa.float64()),
        ("status", pa.string()),
        ("is_returned", pa.bool_()),
        ("latitude", pa.float64()),
        ("longitude", pa.float64()),
        ("note", pa.string()),
    ])

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: Any) -> list[pa.Array]:
        micros = order_micros(start, count, total, rng)
        when = EPOCH_START + micros.astype("timedelta64[us]")
        month = when.astype("datetime64[M]").astype(np.int64) % 12
        store = rng.integers(0, N_STORES, count)
        product = rng.integers(0, N_PRODUCTS, count)
        quantity = 1 + rng.poisson(1.6 * SEASONALITY[month])
        discount = np.round(rng.choice([0, 0, 0, 0.05, 0.1, 0.15, 0.25], count), 2)
        price = PRODUCT_PRICE_CENTS[product]
        revenue = np.round(quantity * price * (1 - discount) / 100, 2)
        status = rng.choice(len(STATUSES), count, p=STATUS_WEIGHTS)
        note = labels(["gift wrap", "expedite", "fragile", "call on arrival"], rng.integers(0, 4, count))
        note = pc.if_else(pa.array(rng.random(count) < 0.7), pa.scalar(None, pa.string()), note)
        return [
            pa.array(np.arange(start + 1, start + count + 1, dtype=np.int64)),
            timestamps(when),
            pa.array(when.astype("datetime64[D]")),
            labels(REGIONS, STORE_REGION[store]),
            pa.array((store + 1).astype(np.int32)),
            labels(CHANNELS, rng.choice(len(CHANNELS), count, p=[0.55, 0.3, 0.1, 0.05])),
            labels(CATEGORIES, PRODUCT_CATEGORY[product]),
            pa.array((product + 1).astype(np.int32)),
            pa.array(rng.integers(1, N_CUSTOMERS + 1, count).astype(np.int32)),
            pa.array(quantity.astype(np.int32)),
            decimal_from_cents(price),
            pa.array(discount),
            pa.array(revenue),
            labels(STATUSES, status),
            pa.array(status == STATUSES.index("returned")),
            pa.array(STORE_LAT[store] + rng.normal(0, 0.05, count)),
            pa.array(STORE_LON[store] + rng.normal(0, 0.05, count)),
            note,
        ]


WIDE_MEASURES = 40
WIDE_COUNTERS = 10
WIDE_DIMENSIONS = 9


@init_single_worker
@bind_fixed_schema
class GenerateWide(ChunkedGenerator):
    """60 columns: what a wide result does to row materialization and grids."""

    class Meta:
        name = "generate_wide"
        description = "A 60-column table (40 DOUBLE measures, 10 BIGINT counters, 9 VARCHAR dimensions)"
        categories = ["generator"]

    CHUNK_ROWS: ClassVar[int] = WIDE_CHUNK
    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema(
        [("id", pa.int64())]
        + [(f"measure_{i:02d}", pa.float64()) for i in range(WIDE_MEASURES)]
        + [(f"counter_{i:02d}", pa.int64()) for i in range(WIDE_COUNTERS)]
        + [(f"dimension_{i:02d}", pa.string()) for i in range(WIDE_DIMENSIONS)]
    )

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: Any) -> list[pa.Array]:
        measures = rng.normal(100, 25, (WIDE_MEASURES, count)).round(4)
        counters = rng.integers(0, 1_000_000, (WIDE_COUNTERS, count))
        # Cardinality grows with the column index: dimension_00 has 2 values,
        # dimension_08 has 512 — a range of group-by fan-outs.
        dimensions = [
            labels([f"d{i}_{v:03d}" for v in range(2 ** (i + 1))], rng.integers(0, 2 ** (i + 1), count))
            for i in range(WIDE_DIMENSIONS)
        ]
        return [
            pa.array(np.arange(start + 1, start + count + 1, dtype=np.int64)),
            *[pa.array(row) for row in measures],
            *[pa.array(row) for row in counters],
            *dimensions,
        ]


EVENT_TYPES = ["page_view", "click", "search", "add_to_cart", "checkout", "error"]
BROWSERS = ["Chrome", "Safari", "Firefox", "Edge"]
SYSTEMS = ["macOS", "Windows", "Linux", "iOS", "Android"]
TAGS = ["mobile", "beta", "internal", "returning", "campaign", "eu", "slow"]


@init_single_worker
@bind_fixed_schema
class GenerateEvents(ChunkedGenerator):
    """Clickstream: high-cardinality strings, long text, LIST and STRUCT columns."""

    class Meta:
        name = "generate_events"
        description = "Synthetic clickstream with high-cardinality strings and nested columns"
        categories = ["generator"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("event_id", pa.int64()),
        ("event_ts", pa.timestamp("us", tz="UTC")),
        ("user_id", pa.int64()),
        ("session_id", pa.string()),
        ("event_type", pa.string()),
        ("url", pa.string()),
        ("payload_json", pa.string()),
        ("tags", pa.list_(pa.string())),
        ("client", pa.struct([("browser", pa.string()), ("os", pa.string()), ("duration_ms", pa.int32())])),
    ])

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: Any) -> list[pa.Array]:
        ids = np.arange(start + 1, start + count + 1, dtype=np.int64)
        user = rng.integers(1, 250_000, count)
        event = rng.choice(len(EVENT_TYPES), count, p=[0.55, 0.22, 0.1, 0.07, 0.04, 0.02])
        product = rng.integers(1, N_PRODUCTS + 1, count)
        duration = rng.gamma(2.0, 180.0, count).astype(np.int32)
        session = np.char.add("s-", np.char.zfill((user * 7919 + ids // 40).astype(str), 12))
        url = np.char.add("https://shop.example/products/", product.astype(str))
        payload = np.char.add(
            np.char.add('{"product_id":', product.astype(str)),
            np.char.add(',"trace":"', np.char.add(np.char.zfill(ids.astype(str), 160), '"}')),
        )
        tag_counts = rng.integers(0, 4, count)
        tag_offsets = np.concatenate([[0], np.cumsum(tag_counts)]).astype(np.int32)
        tag_values = labels(TAGS, rng.integers(0, len(TAGS), int(tag_offsets[-1])))
        client = pa.StructArray.from_arrays(
            [labels(BROWSERS, rng.integers(0, len(BROWSERS), count)), labels(SYSTEMS, rng.integers(0, len(SYSTEMS), count)), pa.array(duration)],
            names=["browser", "os", "duration_ms"],
        )
        return [
            pa.array(ids),
            timestamps(EPOCH_START + order_micros(start, count, total, rng).astype("timedelta64[us]")),
            pa.array(user),
            pa.array(session),
            labels(EVENT_TYPES, event),
            pa.array(url),
            pa.array(payload),
            pa.ListArray.from_arrays(pa.array(tag_offsets), tag_values),
            client,
        ]


LAND_USE = ["Residential", "Commercial", "Agricultural", "Industrial", "Public", "Vacant"]
ZONING = ["R1", "R2", "R4", "C1", "C2", "LI", "RA", "PUD"]


@init_single_worker
@bind_fixed_schema
class GenerateParcels(ChunkedGenerator):
    """Land parcels with a WKB polygon per row — the heavy-geometry case."""

    class Meta:
        name = "generate_parcels"
        description = "Synthetic land parcels on a grid, each with a GEOMETRY polygon"
        categories = ["generator"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("parcel_id", pa.int64()),
        ("owner", pa.string()),
        ("land_use", pa.string()),
        ("zoning", pa.string()),
        ("acres", pa.float64()),
        ("assessed_value", pa.int64()),
        ("year_built", pa.int32()),
        ("latitude", pa.float64()),
        ("longitude", pa.float64()),
        pa.field("geom", pa.binary(), metadata=GEOARROW_WKB),
    ])

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: Any) -> list[pa.Array]:
        ids = np.arange(start, start + count, dtype=np.int64)
        # A 1000-wide grid of ~110m cells west of Charlottesville, VA.
        lon = -78.9 + (ids % 1000) * 0.001
        lat = 37.8 + (ids // 1000) * 0.001
        acres = np.round(rng.lognormal(0.2, 0.9, count), 3)
        land_use = rng.choice(len(LAND_USE), count, p=[0.58, 0.12, 0.14, 0.05, 0.04, 0.07])
        built = rng.integers(1890, 2026, count).astype(np.int32)
        year_built = pc.if_else(pa.array(land_use == LAND_USE.index("Vacant")), pa.scalar(None, pa.int32()), pa.array(built))
        return [
            pa.array(ids + 1),
            pa.array(np.char.add("Owner ", np.char.zfill(rng.integers(1, 80_000, count).astype(str), 5))),
            labels(LAND_USE, land_use),
            labels(ZONING, rng.integers(0, len(ZONING), count)),
            pa.array(acres),
            pa.array((acres * rng.uniform(40_000, 220_000, count)).astype(np.int64)),
            year_built,
            pa.array(lat),
            pa.array(lon),
            wkb_squares(lon, lat, np.full(count, 0.00045)),
        ]


# ---------------------------------------------------------------------------
# Small reference tables
# ---------------------------------------------------------------------------


class StaticTable(TableFunctionGenerator[NoArgs]):
    """A small table built once and emitted in a single batch."""

    @classmethod
    def build(cls) -> list[pa.Array]:
        raise NotImplementedError

    @classmethod
    def process(cls, params: ProcessParams[NoArgs], state: None, out: OutputCollector) -> None:
        out.emit(pa.RecordBatch.from_arrays(cls.build(), schema=params.output_schema))
        out.finish()


@init_single_worker
@bind_fixed_schema
class RegionsScan(StaticTable):
    class Meta:
        name = "regions_scan"
        description = "Scan function backing small.regions"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("region", pa.string()), ("manager", pa.string()), ("latitude", pa.float64()), ("longitude", pa.float64()),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        managers = ["A. Rivera", "B. Chen", "C. Okafor", "D. Novak", "E. Haddad", "F. Tremblay", "G. Weber", "H. Tanaka"]
        return [pa.array(REGIONS), pa.array(managers), pa.array([c[0] for c in REGION_CENTERS]), pa.array([c[1] for c in REGION_CENTERS])]


@init_single_worker
@bind_fixed_schema
class ProductsScan(StaticTable):
    class Meta:
        name = "products_scan"
        description = "Scan function backing small.products"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("product_id", pa.int32()), ("product_name", pa.string()), ("category", pa.string()), ("list_price", pa.decimal128(14, 2)),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        return [
            pa.array(_products.astype(np.int32)),
            pa.array([f"Product {p:03d}" for p in _products]),
            labels(CATEGORIES, PRODUCT_CATEGORY),
            decimal_from_cents(PRODUCT_PRICE_CENTS),
        ]


@init_single_worker
@bind_fixed_schema
class StoresScan(StaticTable):
    class Meta:
        name = "stores_scan"
        description = "Scan function backing small.stores"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("store_id", pa.int32()), ("store_name", pa.string()), ("region", pa.string()),
        ("opened", pa.date32()), ("square_feet", pa.int32()),
        ("latitude", pa.float64()), ("longitude", pa.float64()),
        pa.field("geom", pa.binary(), metadata=GEOARROW_WKB),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        rng = np.random.default_rng([SEED, 2])
        opened = np.datetime64("2005-01-01") + rng.integers(0, 6500, N_STORES).astype("timedelta64[D]")
        return [
            pa.array(_stores.astype(np.int32)),
            pa.array([f"Store {s:03d}" for s in _stores]),
            labels(REGIONS, STORE_REGION),
            pa.array(opened),
            pa.array(rng.integers(4, 60, N_STORES).astype(np.int32) * 1000),
            pa.array(STORE_LAT), pa.array(STORE_LON),
            wkb_points(STORE_LON, STORE_LAT),
        ]


@init_single_worker
@bind_fixed_schema
class MonthlyTargetsScan(StaticTable):
    """36 months x 8 regions: targets and actuals for bullet/slope/sparkline blocks."""

    class Meta:
        name = "monthly_targets_scan"
        description = "Scan function backing small.monthly_targets"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("month", pa.date32()), ("region", pa.string()),
        ("target_revenue", pa.float64()), ("actual_revenue", pa.float64()), ("orders", pa.int32()),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        rng = np.random.default_rng([SEED, 3])
        months = np.arange(np.datetime64("2023-01"), np.datetime64("2026-01"))
        month = np.repeat(months, len(REGIONS))
        region = np.tile(np.arange(len(REGIONS)), len(months))
        growth = 1 + 0.012 * np.repeat(np.arange(len(months)), len(REGIONS))
        target = np.round(180_000 * (1 + region * 0.11) * growth * SEASONALITY[month.astype(np.int64) % 12], -2)
        actual = np.round(target * rng.normal(1.0, 0.09, len(target)), 2)
        return [
            pa.array(month.astype("datetime64[D]")), labels(REGIONS, region),
            pa.array(target), pa.array(actual), pa.array((actual / 84).astype(np.int32)),
        ]


# ---------------------------------------------------------------------------
# Type and shape edge cases
# ---------------------------------------------------------------------------

ALL_TYPES_ROWS = 1_000


@init_single_worker
@bind_fixed_schema
class AllTypesScan(StaticTable):
    """One column per Arrow type the frontend has to format. Every 7th value of
    each nullable column is NULL, so null rendering is exercised everywhere."""

    class Meta:
        name = "all_types_scan"
        description = "Scan function backing edge.all_types"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("id", pa.int32()),
        ("c_bool", pa.bool_()),
        ("c_int8", pa.int8()), ("c_int16", pa.int16()), ("c_int32", pa.int32()), ("c_int64", pa.int64()),
        ("c_uint8", pa.uint8()), ("c_uint16", pa.uint16()), ("c_uint32", pa.uint32()), ("c_uint64", pa.uint64()),
        ("c_float", pa.float32()), ("c_double", pa.float64()),
        ("c_decimal_small", pa.decimal128(9, 4)), ("c_decimal_huge", pa.decimal128(38, 0)),
        ("c_date", pa.date32()), ("c_time", pa.time64("us")),
        ("c_timestamp", pa.timestamp("us")), ("c_timestamp_tz", pa.timestamp("us", tz="UTC")),
        ("c_interval", pa.duration("us")),
        ("c_varchar", pa.string()), ("c_unicode", pa.string()), ("c_blob", pa.binary()),
        ("c_list", pa.list_(pa.int32())),
        ("c_struct", pa.struct([("x", pa.float64()), ("label", pa.string())])),
        ("c_map", pa.map_(pa.string(), pa.int32())),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        from decimal import Decimal

        n = ALL_TYPES_ROWS
        ids = list(range(n))
        unicode_samples = ["naïve café", "日本語テキスト", "emoji 🚀📊", "tab\there", "line\nbreak", "  padded  ", "", "Ωμέγα"]

        def nullable(values: list[Any]) -> list[Any]:
            return [None if i % 7 == 6 else v for i, v in enumerate(values)]

        schema = cls.FIXED_SCHEMA
        columns: dict[str, list[Any]] = {
            "id": ids,
            "c_bool": nullable([i % 2 == 0 for i in ids]),
            "c_int8": nullable([(i % 256) - 128 for i in ids]),
            "c_int16": nullable([(i * 37 % 65_536) - 32_768 for i in ids]),
            "c_int32": nullable([(-1) ** i * i * 2_147_483 for i in ids]),
            # Includes values past 2^53, where a JS Number silently loses precision.
            "c_int64": nullable([(-1) ** i * (9_007_199_254_740_993 + i) for i in ids]),
            "c_uint8": nullable([i % 256 for i in ids]),
            "c_uint16": nullable([i * 61 % 65_536 for i in ids]),
            "c_uint32": nullable([4_294_967_295 - i for i in ids]),
            "c_uint64": nullable([18_446_744_073_709_551_615 - i for i in ids]),
            "c_float": nullable([i / 3 for i in ids]),
            "c_double": nullable([float("inf") if i == 1 else float("nan") if i == 2 else i * 1e-3 - 0.5 for i in ids]),
            "c_decimal_small": nullable([Decimal(i * 12_345 - 5_000_000) / 10_000 for i in ids]),
            "c_decimal_huge": nullable([Decimal(10**37 + i) * (-1) ** i for i in ids]),
            "c_date": nullable([np.datetime64("1969-12-25") + np.timedelta64(i * 23, "D") for i in ids]),
            "c_time": nullable([(i * 86_399_999_999 // n) for i in ids]),
            "c_timestamp": nullable([np.datetime64("1999-12-31T23:59:59.999999") + np.timedelta64(i * 3_600_000_001, "us") for i in ids]),
            "c_timestamp_tz": nullable([np.datetime64("2024-03-10T06:30:00") + np.timedelta64(i * 86_400_000_000, "us") for i in ids]),
            "c_interval": nullable([i * 90_061_000_001 for i in ids]),
            "c_varchar": nullable([f"value {i}" for i in ids]),
            "c_unicode": nullable([unicode_samples[i % len(unicode_samples)] for i in ids]),
            "c_blob": nullable([bytes([i % 256, 0, 255, (i * 7) % 256]) for i in ids]),
            "c_list": nullable([list(range(i % 5)) for i in ids]),
            "c_struct": nullable([{"x": i / 10, "label": f"s{i % 4}"} for i in ids]),
            "c_map": nullable([[("a", i), ("b", i * 2)][: i % 3] for i in ids]),
        }
        arrays = []
        for field in schema:
            values = columns[field.name]
            if pa.types.is_date(field.type) or pa.types.is_timestamp(field.type):
                values = [None if v is None else v.astype("datetime64[us]").item() for v in values]
                if pa.types.is_date(field.type):
                    values = [None if v is None else v.date() for v in values]
            arrays.append(pa.array(values, type=field.type))
        return arrays


@init_single_worker
@bind_fixed_schema
class EmptyScan(TableFunctionGenerator[NoArgs]):
    """Zero rows, real schema: the empty-state path of every block."""

    class Meta:
        name = "empty_scan"
        description = "Scan function backing edge.empty"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([("id", pa.int64()), ("name", pa.string()), ("amount", pa.float64())])

    @classmethod
    def process(cls, params: ProcessParams[NoArgs], state: None, out: OutputCollector) -> None:
        out.finish()


@init_single_worker
@bind_fixed_schema
class AllNullsScan(StaticTable):
    class Meta:
        name = "all_nulls_scan"
        description = "Scan function backing edge.all_nulls"
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([("id", pa.int64()), ("name", pa.string()), ("amount", pa.float64()), ("at", pa.timestamp("us"))])

    @classmethod
    def build(cls) -> list[pa.Array]:
        return [pa.array(range(100), type=pa.int64())] + [pa.nulls(100, field.type) for field in list(cls.FIXED_SCHEMA)[1:]]


@init_single_worker
@bind_fixed_schema
class AwkwardNamesScan(StaticTable):
    """Column names that break unquoted SQL, JSON paths, and Vega field lookups."""

    class Meta:
        name = "awkward_names_scan"
        description = "Scan function backing edge.\"awkward names\""
        categories = ["table-backing"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([
        ("Order ID", pa.int64()), ("total $", pa.float64()), ("naïve café", pa.string()), ("select", pa.string()),
        ('with"quote', pa.string()), ("dotted.name", pa.float64()), ("bracket[0]", pa.int32()), ("UPPER_lower", pa.string()),
    ])

    @classmethod
    def build(cls) -> list[pa.Array]:
        n = 50
        return [
            pa.array(range(1, n + 1), type=pa.int64()), pa.array([i * 12.5 for i in range(n)]),
            pa.array([f"é{i}" for i in range(n)]), pa.array([f"kw{i % 3}" for i in range(n)]),
            pa.array([f'q"{i}' for i in range(n)]), pa.array([i / 7 for i in range(n)]),
            pa.array(range(n), type=pa.int32()), pa.array([f"Mixed{i % 5}" for i in range(n)]),
        ]


# ---------------------------------------------------------------------------
# Latency and failure injection
# ---------------------------------------------------------------------------


@dataclass(slots=True, frozen=True, kw_only=True)
class SlowArgs:
    rows: Annotated[int, Arg(0, doc="Number of rows to generate", ge=0)]
    delay_ms: Annotated[int, Arg(1, doc="Sleep before each 1,000-row chunk, in milliseconds", ge=0, le=60_000)]


@init_single_worker
@bind_fixed_schema
class SlowRows(ChunkedGenerator):
    """A slow source: loading states, progress UI, cancellation, refresh overlap."""

    class Meta:
        name = "slow_rows"
        description = "Rows that arrive slowly: sleeps delay_ms before every 1,000-row chunk"
        categories = ["fault-injection"]

    # The framework reads the argument class off the generic parameter, which
    # this subclass inherits as RowsArgs; an explicit attribute overrides it.
    FunctionArguments = SlowArgs
    CHUNK_ROWS: ClassVar[int] = 1_000
    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([("n", pa.int64()), ("value", pa.float64())])

    @classmethod
    def chunk(cls, start: int, count: int, total: int, rng: np.random.Generator, args: SlowArgs) -> list[pa.Array]:
        time.sleep(args.delay_ms / 1000)
        return [pa.array(np.arange(start, start + count, dtype=np.int64)), pa.array(rng.random(count))]


@init_single_worker
@bind_fixed_schema
class FailAfter(ChunkedGenerator):
    """Streams ``rows`` good rows, then fails mid-scan."""

    class Meta:
        name = "fail_after"
        description = "Emits the requested rows, then raises — a source that dies mid-stream"
        categories = ["fault-injection"]

    CHUNK_ROWS: ClassVar[int] = 1_000
    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([("n", pa.int64())])

    @classmethod
    def process(cls, params: ProcessParams[RowsArgs], state: Cursor, out: OutputCollector) -> None:
        if state.emitted >= params.args.rows:
            raise RuntimeError(f"cupola_test.fail_after: synthetic failure after {params.args.rows} rows")
        count = min(params.args.rows - state.emitted, cls.CHUNK_ROWS)
        out.emit(pa.RecordBatch.from_arrays([pa.array(np.arange(state.emitted, state.emitted + count, dtype=np.int64))], schema=params.output_schema))
        state.emitted += count


@init_single_worker
@bind_fixed_schema
class RateLimited(TableFunctionGenerator[NoArgs]):
    """Always fails the way a throttled upstream API does, so the report
    runner's rate-limit classification and run-pausing can be tested offline."""

    class Meta:
        name = "rate_limited"
        description = "Always fails with an HTTP 429 rate-limit error"
        categories = ["fault-injection"]

    FIXED_SCHEMA: ClassVar[pa.Schema] = pa.schema([("n", pa.int64())])

    @classmethod
    def process(cls, params: ProcessParams[NoArgs], state: None, out: OutputCollector) -> None:
        raise RuntimeError("HTTP 429 Too Many Requests: rate limit exceeded. Try again in 5 seconds.")


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


def schema(name: str, **fields: Any) -> Schema:
    """``Schema(path=[...])`` replaced ``Schema(name=...)`` in vgi-python 0.32;
    accept both so ``./run.sh --latest`` works from the same file."""
    key = {"path": [name]} if "path" in Schema.__dataclass_fields__ else {"name": name}
    return Schema(**key, **fields)


def examples(*pairs: tuple[str, str]) -> str:
    return json.dumps([{"description": description, "sql": sql} for description, sql in pairs])


def sized(name: str, function: type[ChunkedGenerator], rows: int, title: str, doc: str, **extra: Any) -> Table:
    tags = {"vgi.title": title, "vgi.doc_llm": doc, "vgi.category": "stress", **extra.pop("tags", {})}
    return Table(
        name=name,
        function=function,
        arguments=Arguments(positional=(pa.scalar(rows),)),
        cardinality_estimate=rows,
        cardinality_max=rows,
        comment=f"{title} ({rows:,} rows)",
        tags=tags,
        **extra,
    )


ORDERS_DOC = (
    "Synthetic retail order lines. One row per order line, time-ordered over 2023-2025 with a holiday "
    "peak. Joins to small.products on product_id, small.stores on store_id, small.regions on region. "
    "revenue = quantity * unit_price * (1 - discount_pct). status 'returned' rows have is_returned = true."
)
ORDER_KEYS = {"not_null": ("order_id",), "primary_key": (("order_id",),)}

SMALL = schema(
    "small",
    comment="Reference tables a report can render in full",
    tags={"vgi.title": "Small reference data"},
    functions=[RegionsScan, ProductsScan, StoresScan, MonthlyTargetsScan],
    tables=[
        Table(name="regions", function=RegionsScan, comment="Sales regions (8 rows)", primary_key=(("region",),),
              tags={"vgi.title": "Regions", "vgi.doc_llm": "The 8 sales regions with a manager and a map center."}),
        Table(name="products", function=ProductsScan, comment="Product catalog (200 rows)", primary_key=(("product_id",),),
              tags={"vgi.title": "Products", "vgi.doc_llm": "200 products across 12 categories with a list price."}),
        Table(name="stores", function=StoresScan, comment="Stores with point geometry (250 rows)", primary_key=(("store_id",),),
              tags={"vgi.title": "Stores", "vgi.doc_llm": "250 stores with region, latitude/longitude and a GEOMETRY point. Good for map blocks."}),
        Table(name="monthly_targets", function=MonthlyTargetsScan, comment="Target vs actual revenue by month and region (288 rows)",
              tags={"vgi.title": "Monthly targets", "vgi.doc_llm": "36 months x 8 regions of target_revenue and actual_revenue. Good for bullet, slopegraph, sparkline and KPI blocks.",
                    "vgi.example_queries": examples(("Attainment by region", "SELECT region, sum(actual_revenue) / sum(target_revenue) AS attainment FROM cupola_test.small.monthly_targets GROUP BY region ORDER BY attainment DESC"))}),
        sized("orders_1k", GenerateOrders, 1_000, "Orders, 1k", ORDERS_DOC, tags={"vgi.category": "orders"}, **ORDER_KEYS),
    ],
)

LARGE = schema(
    "large",
    comment="Row counts chosen to stress result decoding, grids, charts and Perspective",
    tags={"vgi.title": "Large stress data"},
    functions=[GenerateOrders, GenerateWide, GenerateEvents, GenerateParcels],
    tables=[
        sized("orders_100k", GenerateOrders, 100_000, "Orders, 100k", ORDERS_DOC, **ORDER_KEYS),
        sized("orders_400k", GenerateOrders, 400_000, "Orders, 400k", ORDERS_DOC + " This size killed the tab in a report Perspective block.", **ORDER_KEYS,
              tags={"vgi.example_queries": examples(
                  ("Monthly revenue by region", "SELECT date_trunc('month', order_date) AS month, region, sum(revenue) AS revenue FROM cupola_test.large.orders_400k GROUP BY ALL ORDER BY month, region"),
                  ("Everything, for Perspective", "SELECT * FROM cupola_test.large.orders_400k"),
              )}),
        sized("orders_2m", GenerateOrders, 2_000_000, "Orders, 2M", ORDERS_DOC, **ORDER_KEYS),
        sized("wide_400k", GenerateWide, 400_000, "Wide, 400k x 60", "400k rows by 60 columns. dimension_00..08 have 2..512 distinct values."),
        sized("events_1m", GenerateEvents, 1_000_000, "Events, 1M", "Clickstream with a ~190 character payload_json, a LIST tags column and a STRUCT client column."),
        sized("parcels_400k", GenerateParcels, 400_000, "Parcels, 400k", "Land parcels with a WKB polygon GEOMETRY per row; latitude/longitude are the polygon center."),
    ],
    views=[
        View(name="daily_revenue", definition="SELECT order_date, region, count(*) AS orders, sum(revenue) AS revenue FROM cupola_test.large.orders_400k GROUP BY ALL",
             comment="orders_400k rolled up to ~8.8k rows: a heavy source behind a small result"),
    ],
)

# Fault injection is exposed as FUNCTIONS only (edge.slow_rows, edge.fail_after,
# edge.rate_limited). Every TABLE in this catalog is safe to scan, so anything
# that walks the catalog — a spec picking "any table", column statistics, the
# data preview — never trips a deliberate failure.
EDGE = schema(
    "edge",
    comment="Types and shapes that break formatters, SQL quoting and empty states",
    tags={"vgi.title": "Edge cases"},
    functions=[AllTypesScan, EmptyScan, AllNullsScan, AwkwardNamesScan, SlowRows, FailAfter, RateLimited],
    tables=[
        Table(name="all_types", function=AllTypesScan, comment=f"One column per Arrow type ({ALL_TYPES_ROWS:,} rows); every 7th value NULL"),
        Table(name="empty", function=EmptyScan, comment="A schema and zero rows"),
        Table(name="all_nulls", function=AllNullsScan, comment="100 rows; every column but id is entirely NULL"),
        Table(name="awkward names", function=AwkwardNamesScan, comment="Identifiers with spaces, quotes, dots, brackets, keywords and non-ASCII"),
        Table(name="hidden$table", function=EmptyScan, comment="Hidden by the hideDollarTables setting"),
    ],
)


class CupolaTestWorker(Worker):
    """Serves the ``cupola_test`` catalog."""

    catalog = Catalog(
        name="cupola_test",
        default_schema="small",
        comment="Synthetic datasets for testing Cupola: reports, grids, charts, Perspective",
        tags={
            "vgi.title": "Cupola test data",
            "vgi.doc_llm": "Deterministic synthetic retail data for testing Cupola. Use small.* for reference tables, large.* for volume, edge.* for type and failure cases.",
            "vgi.author": "Query Farm",
        },
        schemas=[SMALL, LARGE, EDGE],
    )


if __name__ == "__main__":
    CupolaTestWorker.main()
