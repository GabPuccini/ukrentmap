#!/usr/bin/env python3
"""Download every raw input the map is built from into data-raw/.

Nothing here needs an API key. Every source is published under the Open
Government Licence v3.0. Run from the repository root:

    python3 scripts/fetch_data.py

Each download is written to its own folder under data-raw/, and
data-raw/sources.json records exactly what was fetched, from where and when,
so build_data.py can print it into the app's metadata.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"

UA = "ukrentmap-data-fetch/1.0 (+https://github.com/GabPuccini/ukrentmap)"

# ONS Price Index of Private Rents, monthly price statistics (dataset page).
PIPR_PAGE = (
    "https://www.ons.gov.uk/economy/inflationandpriceindices/datasets/"
    "priceindexofprivaterentsukmonthlypricestatistics"
)
# OS Downloads API: Code-Point Open product downloads (no key required).
CPO_API = "https://api.os.uk/downloads/v1/products/CodePointOpen/downloads"
# Scottish Government Broad Rental Market Areas (Rent Service Scotland).
SCOT_BRMA_ZIP = "https://maps.gov.scot/ATOM/shapefiles/SG_BroadRentalMarketAreas_2009.zip"
# ONS Open Geography portal feature services.
ONS_FS = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services"
COUNTRIES_LAYER = "Countries_December_2025_Boundaries_UK_BGC"
LAD_LAYER = "Local_Authority_Districts_May_2026_Boundaries_UK_BUC"
WARD_LAYER = "WD_MAY_2026_UK_NC"


def get(url: str, *, attempts: int = 4) -> bytes:
    last: Exception | None = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except Exception as e:  # network hiccup: back off and retry
            last = e
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def save(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    print(f"  wrote {path.relative_to(ROOT)} ({len(data) / 1e6:.1f} MB)")


def fetch_pipr() -> dict:
    print("ONS Price Index of Private Rents")
    page = get(PIPR_PAGE).decode("utf-8", "replace")
    links = re.findall(r'href="(/file\?uri=[^"]+\.xlsx)"', page)
    if not links:
        raise RuntimeError("no .xlsx link found on the PIPR dataset page")
    href = links[0]  # the page lists the current edition first
    edition = re.search(r"/(\d{1,2}[a-z]+\d{4})/", href)
    url = "https://www.ons.gov.uk" + href
    save(RAW / "pipr" / "pipr.xlsx", get(url))
    return {
        "name": "ONS Price Index of Private Rents, UK: monthly price statistics",
        "page": PIPR_PAGE,
        "url": url,
        "edition": edition.group(1) if edition else None,
    }


def fetch_codepoint() -> dict:
    print("OS Code-Point Open")
    downloads = json.loads(get(CPO_API))
    csv = next(d for d in downloads if d["format"] == "CSV" and d["area"] == "GB")
    data = get(csv["url"])
    md5 = hashlib.md5(data).hexdigest()
    if md5 != csv["md5"]:
        raise RuntimeError(f"Code-Point Open checksum mismatch: {md5} != {csv['md5']}")
    save(RAW / "codepoint" / "codepo_gb.zip", data)
    return {
        "name": "OS Code-Point Open (GB)",
        "page": "https://www.ordnancesurvey.co.uk/products/code-point-open",
        "url": csv["url"],
        "md5": md5,
    }


def fetch_scot_brma() -> dict:
    print("Scottish Government Broad Rental Market Areas")
    save(RAW / "scot_brma" / "brma.zip", get(SCOT_BRMA_ZIP))
    return {
        "name": "Scottish Government Broad Rental Market Areas",
        "page": "https://www.spatialdata.gov.scot/geonetwork/srv/eng/catalog.search#/metadata/ecf60902-9e71-41bc-b822-6a1f37934dc1",
        "url": SCOT_BRMA_ZIP,
    }


def arcgis_query(layer: str, params: dict) -> list[dict]:
    """Page through an ArcGIS FeatureServer query and return every feature."""
    base = f"{ONS_FS}/{layer}/FeatureServer/0/query"
    out: list[dict] = []
    offset = 0
    while True:
        q = {"where": "1=1", "outFields": "*", "f": "json", "resultOffset": offset, **params}
        page = json.loads(get(base + "?" + urllib.parse.urlencode(q)))
        if "error" in page:
            raise RuntimeError(f"{layer}: {page['error']}")
        feats = page.get("features", [])
        out.extend(feats)
        if not page.get("exceededTransferLimit") or not feats:
            return out
        offset += len(feats)


def fetch_ons_geography() -> list[dict]:
    print("ONS Open Geography")
    # Country outlines, generalised (20 m) and clipped to the coastline.
    base = f"{ONS_FS}/{COUNTRIES_LAYER}/FeatureServer/0/query"
    q = {"where": "1=1", "outFields": "CTRY25CD,CTRY25NM", "outSR": "27700", "f": "geojson"}
    save(RAW / "ons" / "countries_bgc_27700.geojson", get(base + "?" + urllib.parse.urlencode(q)))

    lads = arcgis_query(LAD_LAYER, {"outFields": "LAD26CD,LAD26NM", "returnGeometry": "false"})
    save(RAW / "ons" / "lad_names.json", json.dumps([f["attributes"] for f in lads]).encode())

    wards = arcgis_query(WARD_LAYER, {"outFields": "WD26CD,WD26NM", "returnGeometry": "false"})
    save(RAW / "ons" / "ward_names.json", json.dumps([f["attributes"] for f in wards]).encode())

    page = "https://geoportal.statistics.gov.uk/"
    return [
        {"name": "ONS Countries (December 2025) Boundaries UK BGC", "page": page, "layer": COUNTRIES_LAYER},
        {"name": "ONS Local Authority Districts (May 2026) names", "page": page, "layer": LAD_LAYER},
        {"name": "ONS Wards (May 2026) names and codes", "page": page, "layer": WARD_LAYER},
    ]


def main() -> int:
    RAW.mkdir(exist_ok=True)
    sources = [fetch_pipr(), fetch_codepoint(), fetch_scot_brma(), *fetch_ons_geography()]
    meta = {"fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "sources": sources}
    (RAW / "sources.json").write_text(json.dumps(meta, indent=2))
    print("done: data-raw/sources.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
