#!/usr/bin/env python3
"""Walking network for the route finder, from OpenStreetMap.

    python3 scripts/build_walk.py          (or: npm run data:walk)

Needs osmium-tool (apt install osmium-tool) and pyosmium (pip install osmium).
Downloads the Geofabrik extracts for England, Scotland and Wales (about 1.9 GB)
into data-raw/osm/, and writes public/data/walk/: index.json plus one
gzip-compressed binary tile per ~5 x 5 km square. The app downloads only the
tiles a route passes through and finds the route on the phone.

What counts as walkable: footways, paths, pedestrian streets, steps, tracks,
bridleways, cycleways and every road except motorways, unless tagged foot=no
or private. Separately mapped pavements (footway=sidewalk) and crossings are
left out, because the street they run beside is already walkable; this halves
the size in cities. Driveways and car-park aisles are left out too. Tiny
fragments that connect to nothing (under 1 km of path in total) are dropped
so a postcode is never snapped onto one.

Data: (c) OpenStreetMap contributors, Open Database Licence (ODbL) 1.0. The
tiles are a derived database, published under the same licence
(public/data/walk/LICENSE).

Tile format (all integers are LEB128 varints; signed ones zigzag-encoded;
coordinates in millionths of a degree):
  "UKW1", version, nV, nE, nG
  nV x (dlon, dlat)            vertex coordinates, delta from the previous
  nV x degree                  outgoing edges per vertex
  nE x (dtarget, metres, geom) edges in vertex order: target id minus source
                               id, length, 1 + index of the shape in this
                               tile's list (0 = straight line). Shapes belong to
                               the lower-numbered end; the other direction
                               points to the same shape, reversed.
  nG x (dsource, n, n x (dlon, dlat))  shape points between the two ends
Vertex ids are global: tile i's vertices are base_i .. base_i + nV - 1
(index.json), ordered along a Z curve so nearby vertices have nearby ids.
"""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from array import array
from pathlib import Path

import numpy as np
import osmium
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw" / "osm"
OUT = ROOT / "public" / "data" / "walk"
UA = "ukrentmap-data-fetch/1.0 (+https://github.com/GabPuccini/ukrentmap)"
GEOFABRIK = "https://download.geofabrik.de/europe/united-kingdom/{}-latest.osm.pbf"
COUNTRIES = ["england", "scotland", "wales"]

# Tile grid, in degrees: about 5.3 km east-west by 5.6 km north-south in the UK.
X0, Y0, DX, DY = -9.0, 49.0, 0.08, 0.05
NX = int(round(12.0 / DX))

WALKABLE = {
    "footway", "path", "pedestrian", "steps", "living_street", "residential", "unclassified",
    "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link",
    "trunk", "trunk_link", "service", "track", "bridleway", "cycleway", "road",
}
NO_FOOT = {"no", "private"}
YES_FOOT = {"yes", "designated", "permissive", "destination", "official"}
SKIP_SERVICE = {"driveway", "parking_aisle", "drive-through", "emergency_access"}
SKIP_FOOTWAY = {"sidewalk", "crossing", "traffic_island"}
MIN_FRAGMENT_M = 1000.0
SIMPLIFY_DEG = 2.5e-5  # about 2-3 m
EARTH = 6_371_008.8


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def download() -> list[Path]:
    RAW.mkdir(parents=True, exist_ok=True)
    paths = []
    for c in COUNTRIES:
        path = RAW / f"{c}-latest.osm.pbf"
        if not path.exists():
            url = GEOFABRIK.format(c)
            log(f"downloading {url}")
            expected = urllib.request.urlopen(urllib.request.Request(url + ".md5", headers={"User-Agent": UA})).read().split()[0].decode()
            tmp = path.with_suffix(".part")
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=600) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 22)
            md5 = hashlib.md5(tmp.read_bytes()).hexdigest()
            if md5 != expected:
                raise RuntimeError(f"{path.name}: checksum {md5} != {expected}")
            tmp.replace(path)
        paths.append(path)
    return paths


def prefilter(paths: list[Path]) -> tuple[Path, str]:
    """Keep only highway ways and their nodes, merged into one small file."""
    out = RAW / "walk-highways.osm.pbf"
    parts = []
    for p in paths:
        part = RAW / (p.name.replace("-latest.osm.pbf", "-highways.osm.pbf"))
        if not part.exists() or part.stat().st_mtime < p.stat().st_mtime:
            log(f"filtering {p.name}")
            subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(part), str(p), "w/highway"], check=True)
        parts.append(part)
    if not out.exists() or any(out.stat().st_mtime < q.stat().st_mtime for q in parts):
        log("merging")
        subprocess.run(["osmium", "merge", "--overwrite", "-o", str(out), *map(str, parts)], check=True)
    stamp = ""
    info = subprocess.run(["osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", str(paths[0])],
                          capture_output=True, text=True)
    stamp = info.stdout.strip()[:10]
    return out, stamp


class Ways(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.ids = array("q")
        self.lon = array("i")
        self.lat = array("i")
        self.lens = array("i")
        self.skipped = 0

    def way(self, w) -> None:
        t = w.tags
        hw = t.get("highway")
        if hw not in WALKABLE:
            return
        foot = t.get("foot")
        if foot in NO_FOOT:
            return
        if t.get("access") in NO_FOOT and foot not in YES_FOOT:
            return
        if hw == "service" and t.get("service") in SKIP_SERVICE:
            return
        if hw == "footway" and t.get("footway") in SKIP_FOOTWAY:
            return
        if t.get("area") == "yes" and hw not in ("pedestrian", "footway"):
            return
        ids, lon, lat = [], [], []
        for n in w.nodes:
            loc = n.location
            if not loc.valid():
                self.skipped += 1
                return
            ids.append(n.ref)
            lon.append(round(loc.lon * 1e6))
            lat.append(round(loc.lat * 1e6))
        if len(ids) < 2:
            return
        self.ids.extend(ids)
        self.lon.extend(lon)
        self.lat.extend(lat)
        self.lens.append(len(ids))


def zigzag(a: np.ndarray) -> np.ndarray:
    a = a.astype(np.int64)
    return ((a << 1) ^ (a >> 63)).astype(np.uint64)


def varints(a: np.ndarray) -> np.ndarray:
    """LEB128-encode an array of non-negative integers."""
    v = a.astype(np.uint64)
    n = np.ones(len(v), dtype=np.int64)
    t = v >> np.uint64(7)
    while True:
        more = t > 0
        if not more.any():
            break
        n += more
        t >>= np.uint64(7)
    out = np.empty(int(n.sum()), dtype=np.uint8)
    pos = np.concatenate([[0], np.cumsum(n)[:-1]])
    for k in range(int(n.max(initial=1))):
        m = n > k
        b = (v[m] & np.uint64(0x7F)).astype(np.uint8)
        b[n[m] > k + 1] |= 0x80
        out[pos[m] + k] = b
        v[m] >>= np.uint64(7)
    return out


def morton(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    def spread(v):
        v = v.astype(np.uint64) & np.uint64(0xFFFF)
        v = (v | (v << np.uint64(8))) & np.uint64(0x00FF00FF)
        v = (v | (v << np.uint64(4))) & np.uint64(0x0F0F0F0F)
        v = (v | (v << np.uint64(2))) & np.uint64(0x33333333)
        v = (v | (v << np.uint64(1))) & np.uint64(0x55555555)
        return v
    return spread(x) | (spread(y) << np.uint64(1))


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--input", type=Path, help="use this OSM file instead of downloading Geofabrik's (for tests)")
    ap.add_argument("--out", type=Path, default=OUT, help="output folder (default public/data/walk)")
    args = ap.parse_args()
    out_dir: Path = args.out
    t0 = time.time()
    if args.input:
        src, osm_date = args.input, "test"
    else:
        src, osm_date = prefilter(download())

    log("reading walkable ways")
    h = Ways()
    h.apply_file(str(src), locations=True, idx="flex_mem")
    ids = np.frombuffer(h.ids, dtype=np.int64)
    lon = np.frombuffer(h.lon, dtype=np.int32).astype(np.int64)
    lat = np.frombuffer(h.lat, dtype=np.int32).astype(np.int64)
    lens = np.frombuffer(h.lens, dtype=np.int32).astype(np.int64)
    log(f"{len(lens):,} ways, {len(ids):,} way nodes ({h.skipped} ways cut by the extract edge skipped)")

    # ---------------------------------------------------------------- graph
    starts = np.concatenate([[0], np.cumsum(lens)[:-1]])
    ends = starts + lens - 1
    way_of = np.repeat(np.arange(len(lens)), lens)
    _, inv, counts = np.unique(ids, return_inverse=True, return_counts=True)
    is_v = counts[inv] >= 2
    is_v[starts] = True
    is_v[ends] = True
    P = np.flatnonzero(is_v)
    same = way_of[P[:-1]] == way_of[P[1:]]
    eu, ev = P[:-1][same], P[1:][same]

    # Segment lengths (equirectangular, fine for metres-long segments).
    mlat = np.radians((lat[:-1] + lat[1:]) / 2e6)
    dx = np.radians((lon[1:] - lon[:-1]) / 1e6) * np.cos(mlat) * EARTH
    dy = np.radians((lat[1:] - lat[:-1]) / 1e6) * EARTH
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(dx, dy))])
    elen = cum[ev] - cum[eu]

    vnodes = np.unique(ids[P])
    u = np.searchsorted(vnodes, ids[eu])
    v = np.searchsorted(vnodes, ids[ev])
    first = np.zeros(len(vnodes), dtype=np.int64)
    first[np.searchsorted(vnodes, ids[P])] = P
    vlon, vlat = lon[first], lat[first]
    log(f"{len(vnodes):,} junctions, {len(u):,} edges")

    # Drop loops and duplicate edges, keeping the shortest of each pair.
    keep = u != v
    u, v, elen, eu, ev = u[keep], v[keep], elen[keep], eu[keep], ev[keep]
    a, b = np.minimum(u, v), np.maximum(u, v)
    order = np.lexsort((elen, b, a))
    a, b = a[order], b[order]
    first_of_pair = np.ones(len(a), dtype=bool)
    first_of_pair[1:] = (a[1:] != a[:-1]) | (b[1:] != b[:-1])
    sel = order[first_of_pair]
    u, v, elen, eu, ev = u[sel], v[sel], elen[sel], eu[sel], ev[sel]

    # Drop fragments that connect to almost nothing.
    n = len(vnodes)
    g = coo_matrix((np.ones(len(u)), (u, v)), shape=(n, n))
    ncomp, comp = connected_components(g, directed=False)
    comp_len = np.bincount(comp[u], weights=elen, minlength=ncomp)
    good_v = comp_len[comp] >= MIN_FRAGMENT_M
    keep = good_v[u]
    u, v, elen, eu, ev = u[keep], v[keep], elen[keep], eu[keep], ev[keep]
    used = np.zeros(n, dtype=bool)
    used[u] = True
    used[v] = True
    log(f"{ncomp:,} connected pieces; kept {used.sum():,} junctions and {len(u):,} edges "
        f"({elen.sum() / 1000:,.0f} km of walkable way)")

    # ---------------------------------------------------------------- order
    old = np.flatnonzero(used)
    ox, oy = vlon[old], vlat[old]
    tx = np.floor((ox / 1e6 - X0) / DX).astype(np.int64)
    ty = np.floor((oy / 1e6 - Y0) / DY).astype(np.int64)
    key = ty * NX + tx
    qx = ((ox / 1e6 - X0 - tx * DX) / DX * 65535).astype(np.int64)
    qy = ((oy / 1e6 - Y0 - ty * DY) / DY * 65535).astype(np.int64)
    order = np.lexsort((morton(qx, qy), key))
    new_of_old = np.full(n, -1, dtype=np.int64)
    new_of_old[old[order]] = np.arange(len(old))
    gx, gy, gkey = ox[order], oy[order], key[order]
    u, v = new_of_old[u], new_of_old[v]

    # Canonical direction: from the lower id. Shape points between the ends,
    # simplified, oriented the same way. Everything here works on whole
    # arrays: GB has millions of shaped edges.
    flip = u > v
    ca, cb = np.where(flip, v, u), np.where(flip, u, v)
    hidx = np.flatnonzero(ev - eu - 1 > 0)
    log(f"simplifying {len(hidx):,} edge shapes")
    counts_full = ev[hidx] - eu[hidx] + 1
    offs = np.concatenate([[0], np.cumsum(counts_full)])
    take = np.repeat(eu[hidx] - offs[:-1], counts_full) + np.arange(offs[-1])
    coords = np.column_stack([lon[take] / 1e6, lat[take] / 1e6])
    lines = shapely.from_ragged_array(shapely.GeometryType.LINESTRING, coords, (offs,))
    lines = shapely.simplify(lines, SIMPLIFY_DEG, preserve_topology=False)
    sc, (soffs,) = shapely.to_ragged_array(lines)[1:]
    del coords, lines, take
    # Inner points only (the two ends are vertices), per shaped edge.
    n_inner = np.diff(soffs) - 2
    keep_s = n_inner > 0
    sh_edge = hidx[keep_s]  # edge index of each kept shape
    sh_len = n_inner[keep_s]
    sh_first = soffs[:-1][keep_s] + 1
    total_pts = int(sh_len.sum())
    log(f"{len(sh_edge):,} shapes, {total_pts:,} shape points kept")

    # ---------------------------------------------------------------- tiles
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    tiles_keys, tile_start = np.unique(gkey, return_index=True)
    tile_end = np.concatenate([tile_start[1:], [len(gkey)]])
    tile_of_vertex = np.repeat(np.arange(len(tiles_keys)), tile_end - tile_start)

    # Shapes are stored in the tile of their canonical source, ordered by it,
    # and numbered from 1 within the tile.
    sh_src = ca[sh_edge]
    sh_tile = tile_of_vertex[sh_src]
    so = np.lexsort((sh_src, sh_tile))
    sh_edge, sh_len, sh_first, sh_src, sh_tile = sh_edge[so], sh_len[so], sh_first[so], sh_src[so], sh_tile[so]
    geom_ref = np.zeros(len(u), dtype=np.int64)
    geom_ref[sh_edge] = np.arange(len(sh_edge)) - np.searchsorted(sh_tile, sh_tile, side="left") + 1
    # All shape points in storage order, each shape oriented from its canonical source.
    sh_off = np.concatenate([[0], np.cumsum(sh_len)])
    k_in = np.arange(total_pts) - np.repeat(sh_off[:-1], sh_len)
    rev = np.repeat(flip[sh_edge], sh_len)
    pos = np.repeat(sh_first, sh_len) + np.where(rev, np.repeat(sh_len, sh_len) - 1 - k_in, k_in)
    px = np.round(sc[pos, 0] * 1e6).astype(np.int64)
    py = np.round(sc[pos, 1] * 1e6).astype(np.int64)
    del sc, pos
    # Deltas: first point of a shape from its source vertex, the rest from the previous point.
    first_pt = k_in == 0
    prevx = np.where(first_pt, np.repeat(gx[sh_src], sh_len), np.concatenate([[0], px[:-1]]))
    prevy = np.where(first_pt, np.repeat(gy[sh_src], sh_len), np.concatenate([[0], py[:-1]]))
    ddx, ddy = px - prevx, py - prevy
    sh_tile_start = np.searchsorted(sh_tile, np.arange(len(tiles_keys)), side="left")
    sh_tile_end = np.searchsorted(sh_tile, np.arange(len(tiles_keys)), side="right")

    # Directed edges, both ways, grouped by source.
    src = np.concatenate([ca, cb])
    dst = np.concatenate([cb, ca])
    dlen = np.concatenate([elen, elen])
    dref = np.concatenate([geom_ref, geom_ref])
    eorder = np.lexsort((dst, src))
    src, dst, dlen, dref = src[eorder], dst[eorder], dlen[eorder], dref[eorder]
    deg = np.bincount(src, minlength=len(gkey))
    estart = np.concatenate([[0], np.cumsum(deg)])

    index = []
    total_bytes = 0
    log(f"writing {len(tiles_keys):,} tiles")
    for t, k in enumerate(tiles_keys):
        s, e = tile_start[t], tile_end[t]
        x, y = gx[s:e], gy[s:e]
        dxy = np.empty(2 * (e - s), dtype=np.int64)
        dxy[0::2] = np.diff(x, prepend=0)
        dxy[1::2] = np.diff(y, prepend=0)
        es, ee = estart[s], estart[e]
        rec = np.empty(3 * (ee - es), dtype=np.uint64)
        rec[0::3] = zigzag(dst[es:ee] - src[es:ee])
        rec[1::3] = np.round(dlen[es:ee]).astype(np.uint64)
        rec[2::3] = dref[es:ee].astype(np.uint64)
        # Shapes: for each, (source id delta, point count), then its point deltas.
        a, b = sh_tile_start[t], sh_tile_end[t]
        ns = b - a
        if ns:
            lens = sh_len[a:b]
            srcs = sh_src[a:b]
            p0, p1 = sh_off[a], sh_off[b]
            head_pos = 2 * np.arange(ns) + 2 * (sh_off[a:b] - p0)
            vals = np.empty(2 * ns + 2 * (p1 - p0), dtype=np.uint64)
            vals[head_pos] = (srcs - np.concatenate([[s], srcs[:-1]])).astype(np.uint64)
            vals[head_pos + 1] = lens.astype(np.uint64)
            pt_pos = np.repeat(head_pos + 2, lens) + 2 * (np.arange(p1 - p0) - np.repeat(sh_off[a:b] - p0, lens))
            vals[pt_pos] = zigzag(ddx[p0:p1])
            vals[pt_pos + 1] = zigzag(ddy[p0:p1])
            gbytes = varints(vals)
        else:
            gbytes = np.zeros(0, dtype=np.uint8)
        head = varints(np.array([1, e - s, ee - es, ns], dtype=np.uint64))
        body = np.concatenate([np.frombuffer(b"UKW1", np.uint8), head, varints(zigzag(dxy)),
                               varints(deg[s:e]), varints(rec), gbytes])
        data = gzip.compress(body.tobytes(), compresslevel=9, mtime=0)
        (out_dir / f"{int(k)}.bin.gz").write_bytes(data)
        total_bytes += len(data)
        index.append([int(k), int(s), int(e - s)])

    (out_dir / "index.json").write_text(json.dumps({
        "version": 1,
        "grid": {"x0": X0, "y0": Y0, "dx": DX, "dy": DY, "nx": NX},
        "tiles": index,
        "vertices": int(len(gkey)),
        "edges": int(len(u)),
        "km": round(float(elen.sum()) / 1000),
        "osmDate": osm_date,
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap contributors, via Geofabrik (england, scotland, wales)",
        "licence": "ODbL 1.0",
    }, separators=(",", ":")))
    (out_dir / "LICENSE").write_text(
        "The walking network tiles in this folder are derived from OpenStreetMap data,\n"
        "(c) OpenStreetMap contributors, and are available under the Open Database\n"
        "Licence 1.0: https://opendatacommons.org/licenses/odbl/1-0/\n"
        "Source data: https://www.openstreetmap.org/copyright (downloaded from Geofabrik).\n"
    )
    log(f"done: {len(tiles_keys):,} tiles, {total_bytes / 1e6:.1f} MB, OSM data of {osm_date}, {time.time() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
