#!/usr/bin/env python3
"""Build the map's data files from the raw downloads in data-raw/.

    python3 scripts/fetch_data.py   # once, or to refresh
    python3 scripts/build_data.py

Writes into public/data/:

  districts.pmtiles   postcode district polygons with rents (vector tiles)
  districts.json      per-district popup and search details
  labels.geojson      one label point per district
  ni.geojson          Northern Ireland outline (drawn grey, see README)
  meta.json           data months, colour-scale percentiles, sources
  pc/<AREA>.txt       every live GB postcode, for offline search

How a district gets its rent
  Every live postcode in Code-Point Open carries the code of its local
  authority. In Scotland, ONS publishes rents by Broad Rental Market Area
  (BRMA) instead, so each Scottish postcode is placed in its BRMA with the
  Scottish Government boundary file. A district takes the area holding most of
  its postcodes and inherits that area's average rent; the split is kept for
  the popup.

How a district gets its shape
  Royal Mail's district boundaries are not open data. The shapes here are a
  Voronoi diagram of every live postcode centroid: each point owns the land
  closer to it than to any other postcode. Only Voronoi edges between
  postcodes of different districts are kept, those edges are polygonised into
  faces, and the faces are clipped to the ONS coastline.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import subprocess
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
import shapefile  # pyshp
import shapely
import shapely.geometry
import shapely.ops
from pyproj import Transformer
from scipy.spatial import Voronoi
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
WORK = RAW / "build"
OUT = ROOT / "public" / "data"

BEDS = ["r0", "r1", "r2", "r3", "r4"]  # all properties, 1, 2, 3, 4+ bedrooms
PIPR_COLS = {
    "r0": "Rental price",
    "r1": "Rental price one bed",
    "r2": "Rental price two bed",
    "r3": "Rental price three bed",
    "r4": "Rental price four or more bed",
}
PERCENTILES = [5, 25, 50, 75, 95]

TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


# --------------------------------------------------------------------------- rents


def load_pipr(path: Path) -> tuple[dict, str]:
    """Return {area key: {name, month, r0..r4}} and the publication date text."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    published = ""
    for row in wb["Cover sheet"].iter_rows(values_only=True):
        m = re.search(r"originally published at .*? on (\d{1,2} \w+ \d{4})", str(row[0] or ""))
        if m:
            published = m.group(1)
    ws = wb["Table 1"]
    rows = ws.iter_rows(values_only=True)
    next(rows), next(rows)
    header = list(next(rows))
    idx = {name: header.index(name) for name in ["Time period", "Area code", "Area name", *PIPR_COLS.values()]}

    def num(v):
        return int(round(float(v))) if isinstance(v, (int, float)) else None

    best: dict[str, dict] = {}
    for row in rows:
        period = row[idx["Time period"]]
        if not hasattr(period, "strftime"):
            continue
        rents = {k: num(row[idx[col]]) for k, col in PIPR_COLS.items()}
        if rents["r0"] is None:
            continue  # nothing published for this area this month
        code, name = row[idx["Area code"]], row[idx["Area name"]]
        # Northern Ireland BRMAs have no GSS code in the file ("[z]").
        key = code if code and code != "[z]" else "NI:" + name.replace(" BRMA", "")
        month = period.strftime("%Y-%m")
        if key not in best or month > best[key]["month"]:
            best[key] = {"name": name, "month": month, **rents}
    return best, published


# ---------------------------------------------------------------------- postcodes


def load_codepoint(path: Path) -> pd.DataFrame:
    cols = ["pc", "pq", "e", "n", "cy", "rh", "lh", "cc", "dc", "wc"]
    z = zipfile.ZipFile(path)
    frames = [
        pd.read_csv(z.open(n), header=None, names=cols, dtype=str, usecols=["pc", "pq", "e", "n", "cy", "dc", "wc"])
        for n in z.namelist()
        if n.startswith("Data/CSV/") and n.endswith(".csv")
    ]
    df = pd.concat(frames, ignore_index=True)
    df = df[df.pq != "90"].copy()  # 90 = no grid reference
    df["e"] = df.e.astype(np.int64)
    df["n"] = df.n.astype(np.int64)
    df = df[(df.e > 0) & (df.n > 0)]
    df["pcn"] = df.pc.str.replace(" ", "", regex=False).str.upper()
    df["out"] = df.pcn.str[:-3]
    df["inw"] = df.pcn.str[-3:]
    df["area"] = df.out.str.extract(r"^([A-Z]+)", expand=False)
    return df.reset_index(drop=True)


def load_scot_brma(path: Path) -> tuple[list, list[str]]:
    z = zipfile.ZipFile(path)
    names = {Path(n).suffix.lower(): n for n in z.namelist() if Path(n).stem == "SG_BroadRentalMarketAreas_2009"}
    r = shapefile.Reader(
        shp=z.open(names[".shp"]), shx=z.open(names[".shx"]), dbf=z.open(names[".dbf"])
    )
    geoms, codes = [], []
    for sr in r.shapeRecords():
        geoms.append(shapely.make_valid(shape(sr.shape.__geo_interface__)))
        codes.append(sr.record["BRMA"])
    return geoms, codes


def assign_points(points: np.ndarray, polys: list, codes: list[str]) -> np.ndarray:
    """Point-in-polygon, with nearest polygon for points just off the coastline."""
    pts = shapely.points(points)
    tree = shapely.STRtree(polys)
    out = np.full(len(points), None, dtype=object)
    pi, ti = tree.query(pts, predicate="intersects")
    out[pi] = np.asarray(codes, dtype=object)[ti]
    missing = np.flatnonzero(pd.isna(out))
    if len(missing):
        ni = tree.query_nearest(pts[missing], return_distance=False)
        # query_nearest returns (input, tree) pairs; keep first match per input
        seen = {}
        for a, b in zip(ni[0], ni[1]):
            seen.setdefault(a, b)
        for a, b in seen.items():
            out[missing[a]] = codes[b]
    return out


# ----------------------------------------------------------------------- geometry


def district_polygons(df: pd.DataFrame, land) -> dict[str, object]:
    """Voronoi of postcode centroids, dissolved by district, clipped to land."""
    # One site per distinct grid reference; shared points go to the most
    # common district at that spot.
    sites = (
        df.groupby(["e", "n", "out"]).size().reset_index(name="c")
        .sort_values(["e", "n", "c", "out"], ascending=[True, True, False, True])
        .drop_duplicates(["e", "n"])
    )
    xy = sites[["e", "n"]].to_numpy(dtype=np.float64)
    dist = sites["out"].to_numpy(dtype=object)
    log(f"voronoi over {len(xy):,} sites")

    # A frame of far-away sea sites makes every real cell finite.
    x0, y0 = xy.min(axis=0) - 150_000
    x1, y1 = xy.max(axis=0) + 150_000
    step = 20_000
    fx = np.arange(x0, x1 + step, step)
    fy = np.arange(y0, y1 + step, step)
    frame = np.vstack(
        [np.c_[fx, np.full_like(fx, y0)], np.c_[fx, np.full_like(fx, y1)],
         np.c_[np.full_like(fy, x0), fy], np.c_[np.full_like(fy, x1), fy]]
    )
    allxy = np.vstack([xy, frame])
    labels = np.concatenate([dist, np.full(len(frame), "~sea", dtype=object)])

    vor = Voronoi(allxy)
    rp = vor.ridge_points
    rv = np.asarray(vor.ridge_vertices)
    keep = (labels[rp[:, 0]] != labels[rp[:, 1]]) & (rv >= 0).all(axis=1)
    segs = vor.vertices[rv[keep]]
    log(f"{keep.sum():,} border edges of {len(rp):,}")
    lines = shapely.linestrings(segs)
    faces = shapely.get_parts(shapely.polygonize(lines))
    log(f"{len(faces):,} faces")

    # Label each face with the district of the postcode sites inside it.
    tree = shapely.STRtree(faces)
    si, fi = tree.query(shapely.points(xy), predicate="within")
    face_dist: dict[int, Counter] = defaultdict(Counter)
    for s, f in zip(si, fi):
        face_dist[f][dist[s]] += 1
    by_dist: dict[str, list] = defaultdict(list)
    for f, c in face_dist.items():
        by_dist[c.most_common(1)[0][0]].append(faces[f])

    # Clip to land, using a grid of land pieces so each intersection is small.
    log("clipping to coastline")
    lx0, ly0, lx1, ly1 = land.bounds
    pieces = []
    g = 25_000
    for x in np.arange(lx0, lx1, g):
        for y in np.arange(ly0, ly1, g):
            p = shapely.intersection(land, box(x, y, x + g, y + g))
            if not p.is_empty:
                pieces.append(p)
    ptree = shapely.STRtree(pieces)
    out = {}
    for d, fs in by_dist.items():
        geom = shapely.union_all(fs) if len(fs) > 1 else fs[0]
        cand = ptree.query(geom, predicate="intersects")
        if len(cand) == 0:
            continue
        clipped = shapely.union_all([shapely.intersection(geom, pieces[i]) for i in cand])
        clipped = shapely.make_valid(clipped)
        polys = [p for p in shapely.get_parts(clipped) if p.geom_type == "Polygon" and p.area > 50]
        if polys:
            out[d] = shapely.multipolygons(polys) if len(polys) > 1 else polys[0]
    return out


def to_wgs84(geom):
    return shapely.transform(geom, lambda c: np.column_stack(TO_WGS84.transform(c[:, 0], c[:, 1])))


def round_coords(obj, nd=5):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [round_coords(v, nd) for v in obj]
    return obj


# --------------------------------------------------------------------------- main


def main() -> int:
    sources = json.loads((RAW / "sources.json").read_text())
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    log("reading ONS rents")
    rents, published = load_pipr(RAW / "pipr" / "pipr.xlsx")
    log(f"{len(rents)} rent areas, published {published}")

    log("reading Code-Point Open")
    df = load_codepoint(RAW / "codepoint" / "codepo_gb.zip")
    log(f"{len(df):,} live postcodes with coordinates in {df.out.nunique():,} districts")

    lad_names = {r["LAD26CD"]: r["LAD26NM"] for r in json.loads((RAW / "ons" / "lad_names.json").read_text())}
    ward_names = {r["WD26CD"]: r["WD26NM"] for r in json.loads((RAW / "ons" / "ward_names.json").read_text())}

    log("placing Scottish postcodes in Broad Rental Market Areas")
    brma_geoms, brma_codes = load_scot_brma(RAW / "scot_brma" / "brma.zip")
    df["ra"] = df.dc
    scot = df.cy == "S92000003"
    df.loc[scot, "ra"] = assign_points(df.loc[scot, ["e", "n"]].to_numpy(), brma_geoms, brma_codes)

    # ------------------------------------------------------------- districts
    log("summarising districts")

    def ranked(col: str) -> dict[str, list[tuple[str, int]]]:
        """{district: [(value, count), ...]} most common first."""
        c = df.groupby(["out", col]).size().reset_index(name="c")
        c = c.sort_values(["out", "c", col], ascending=[True, False, True])
        out: dict[str, list] = defaultdict(list)
        for d, v, n in c.itertuples(index=False):
            out[d].append((v, n))
        return out

    ra_r, la_r, wc_r, cy_r = ranked("ra"), ranked("dc"), ranked("wc"), ranked("cy")
    districts: dict[str, dict] = {}
    for d, k in df.groupby("out").size().items():
        wards: list[str] = []
        for code, c in wc_r[d]:
            name = ward_names.get(code)
            if name and name not in wards and (not wards or c / k >= 0.15):
                wards.append(name)
            if len(wards) == 3:
                break
        la = la_r[d][0][0]
        info = {
            "k": int(k),
            "cy": cy_r[d][0][0][0],  # E, W or S
            "la": lad_names.get(la, la),
            "w": wards,
            "ra": ra_r[d][0][0],
        }
        if len(ra_r[d]) > 1:
            info["sh"] = [
                [rents.get(code, {}).get("name") or lad_names.get(code, code), round(100 * c / k)]
                for code, c in ra_r[d][:3]
            ]
        districts[d] = info

    # Northern Ireland: NIHE defines each BRMA as a list of postcode districts,
    # so a BT district maps straight to its ONS rent area with no NI postcode
    # data at all (see README: the LPS licence does not allow publishing it).
    ni_table = pd.read_csv(ROOT / "scripts" / "ni_outcode_brma.csv", dtype=str)
    ni_districts = {o: "NI:" + a for o, a in zip(ni_table.outcode, ni_table.pipr_area)}
    missing_ni = sorted(set(ni_districts.values()) - set(rents))
    if missing_ni:
        raise RuntimeError(f"NI rent areas not found in PIPR: {missing_ni}")

    # ------------------------------------------------------------- geometry
    countries = json.loads((RAW / "ons" / "countries_bgc_27700.geojson").read_text())
    gb_parts, ni_geom = [], None
    for f in countries["features"]:
        geom = shapely.make_valid(shape(f["geometry"]))
        if f["properties"]["CTRY25CD"].startswith("N"):
            ni_geom = geom
        else:
            gb_parts.append(geom)
    land = shapely.union_all(gb_parts)
    polys = district_polygons(df, land)
    log(f"{len(polys):,} district polygons")

    # ------------------------------------------------------------- outputs
    log("writing GeoJSON for tippecanoe and label points")
    feats, labels = [], []
    for d, info in districts.items():
        r = rents.get(info["ra"], {})
        props = {"c": d, **{b: r[b] for b in BEDS if r.get(b) is not None}}
        geom = polys.get(d)
        if geom is not None:
            biggest = max(shapely.get_parts(geom), key=lambda p: p.area)
            lp = shapely.ops.polylabel(biggest, tolerance=20)
            w = to_wgs84(geom)
            feats.append({"type": "Feature", "properties": props, "geometry": round_coords(shapely.geometry.mapping(w))})
            info["b"] = [round(v, 4) for v in w.bounds]
        else:
            g = df[df.out == d]
            lp = shapely.Point(g.e.mean(), g.n.mean())
        lng, lat = TO_WGS84.transform(lp.x, lp.y)
        info["p"] = [round(lng, 5), round(lat, 5)]
        labels.append({
            "type": "Feature",
            "properties": {"c": d, "k": info["k"]},
            "geometry": {"type": "Point", "coordinates": info["p"]},
        })

    gj = WORK / "districts.geojson"
    gj.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    (OUT / "labels.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": labels}, separators=(",", ":")))
    if ni_geom is not None:
        ni = to_wgs84(shapely.simplify(ni_geom, 50))
        (OUT / "ni.geojson").write_text(json.dumps({
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {}, "geometry": round_coords(shapely.geometry.mapping(ni), 4)}],
        }, separators=(",", ":")))

    log("tiling with tippecanoe")
    tiles = OUT / "districts.pmtiles"
    subprocess.run([
        "tippecanoe", "-o", str(tiles), "--force", "--quiet",
        "-l", "districts", "-n", "UK postcode districts",
        "-Z4", "-z12",
        "--detect-shared-borders", "--no-tiny-polygon-reduction",
        "--no-feature-limit", "--no-tile-size-limit",
        "--simplification=4",
        str(gj),
    ], check=True)
    log(f"districts.pmtiles {tiles.stat().st_size / 1e6:.1f} MB")

    # Colour scale: percentiles over districts, per bedroom type.
    scale = {}
    for b in BEDS:
        vals = [rents[i["ra"]][b] for i in districts.values() if i["ra"] in rents and rents[i["ra"]].get(b) is not None]
        scale[b] = [int(round(v)) for v in np.percentile(vals, PERCENTILES)]

    areas = {}
    used = {i["ra"] for i in districts.values()}
    for key, r in rents.items():
        if key in used or key.startswith("NI:"):
            areas[key] = {"n": r["name"], "m": r["month"], "r": [r.get(b) for b in BEDS]}
    for key in used - set(areas):
        areas[key] = {"n": lad_names.get(key, key), "m": None, "r": [None] * 5}

    (OUT / "districts.json").write_text(
        json.dumps({"d": districts, "a": areas, "ni": ni_districts}, separators=(",", ":"))
    )

    months = sorted({a["m"] for k, a in areas.items() if a["m"] and not k.startswith("NI:")})
    ni_months = sorted({a["m"] for k, a in areas.items() if a["m"] and k.startswith("NI:")})
    nodata = sorted(d for d, i in districts.items() if i["ra"] not in rents)
    meta = {
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "rentMonth": months[-1] if months else None,
        "rentMonthNI": ni_months[-1] if ni_months else None,
        "piprPublished": published,
        "percentiles": PERCENTILES,
        "scale": scale,
        "counts": {"postcodes": int(len(df)), "districts": len(districts), "polygons": len(polys), "noData": len(nodata)},
        "noDataDistricts": nodata,
        "sources": sources["sources"],
        "fetched": sources["fetched"],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))

    # ------------------------------------------------------------- search
    log("writing postcode search files")
    pc_dir = OUT / "pc"
    if pc_dir.exists():
        shutil.rmtree(pc_dir)
    pc_dir.mkdir()
    lng, lat = TO_WGS84.transform(df.e.to_numpy(), df.n.to_numpy())
    df["x"] = np.round(lng * 1e4).astype(np.int64)
    df["y"] = np.round(lat * 1e4).astype(np.int64)
    for area, g in df.sort_values("pcn").groupby("area"):
        lines = ["#ukrentmap postcodes v1: district base lng*1e4 lat*1e4, then inward dx dy"]
        for d, gd in g.groupby("out", sort=True):
            bx, by = int(gd.x.iloc[0]), int(gd.y.iloc[0])
            lines.append(f"{d} {bx} {by}")
            lines.extend(f"{i} {x - bx} {y - by}" for i, x, y in zip(gd.inw, gd.x, gd.y))
        (pc_dir / f"{area}.txt").write_text("\n".join(lines) + "\n")
    size = sum(p.stat().st_size for p in pc_dir.iterdir()) / 1e6
    log(f"{len(list(pc_dir.iterdir()))} postcode files, {size:.1f} MB")

    log(f"done: rents {meta['rentMonth']}, {len(nodata)} districts without data: {', '.join(nodata[:20])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
