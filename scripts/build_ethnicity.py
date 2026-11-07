#!/usr/bin/env python3
"""Ethnic group of the people living in each postcode district.

    python3 scripts/build_ethnicity.py      (or: npm run data:ethnicity)

Writes public/data/ethnicity.json. Census figures only change once a decade,
so this is separate from the weekly rent refresh and only needs running again
if you want to pick up new postcode districts.

Sources (all Open Government Licence v3.0):
  England and Wales  ONS Census 2021, TS021 Ethnic group, by output area
                     (Nomis bulk download)
  Scotland           Scotland's Census 2022, UV201 Ethnic group, by output area
                     (National Records of Scotland)
  Postcode -> area   ONS Postcode Directory (August 2026), live GB postcodes
                     only. The Northern Ireland rows are never requested: their
                     licence does not allow publishing (see README).

Method
  Census output areas hold about 125 households each. Every live postcode
  belongs to one output area, so each output area's residents are shared out
  between postcode districts in proportion to how many of its residential
  postcodes fall in each district, then summed per district. Percentages are
  of usual residents. Scottish figures are from 2022, the rest from 2021.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw" / "census"
OUT = ROOT / "public" / "data" / "ethnicity.json"
UA = "ukrentmap-data-fetch/1.0 (+https://github.com/GabPuccini/ukrentmap)"

EW_URL = "https://www.nomisweb.co.uk/output/census/2021/census2021-ts021.zip"
SCOT_PAGE = "https://www.scotlandscensus.gov.uk/documents/2022-output-area-data/"
SCOT_URL = (
    "https://www.scotlandscensus.gov.uk/media/zz85kfinmf97whklasd98gfkadft5hj4f_Topic2H_20241120_1747/"
    "Census-2022-Output-Area-v1.zip"
)
ONSPD = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "ONS_Postcode_Directory_(August_2026)_(Hosted_Table)/FeatureServer/0/query"
)

# Broad groups, in display order. Each source's columns map onto these.
GROUPS = ["white", "asian", "black", "mixed", "other"]
MIN_RESIDENTS = 100  # below this, percentages are too noisy to show


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def get(url: str, attempts: int = 4) -> bytes:
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except Exception as e:
            if i == attempts - 1:
                raise RuntimeError(f"failed to fetch {url}: {e}") from e
            time.sleep(2 ** (i + 1))
    raise AssertionError


def cached(path: Path, url: str) -> bytes:
    if not path.exists():
        log(f"downloading {url}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(get(url))
    return path.read_bytes()


# --------------------------------------------------------------------- sources


def england_wales() -> tuple[pd.DataFrame, dict[str, str]]:
    """Output area counts: total, five broad groups, and detailed groups."""
    z = zipfile.ZipFile(io.BytesIO(cached(RAW / "ew_ts021.zip", EW_URL)))
    df = pd.read_csv(z.open("census2021-ts021-oa.csv"))
    prefix = "Ethnic group: "
    out = pd.DataFrame({"oa": df["geography code"], "total": df[prefix + "Total: All usual residents"]})
    broad = {
        "Asian, Asian British or Asian Welsh": "asian",
        "Black, Black British, Black Welsh, Caribbean or African": "black",
        "Mixed or Multiple ethnic groups": "mixed",
        "White": "white",
        "Other ethnic group": "other",
    }
    labels: dict[str, str] = {}
    for col in df.columns:
        if not col.startswith(prefix) or "Total" in col:
            continue
        parts = col[len(prefix):].split(": ")
        group = broad[parts[0]]
        if len(parts) == 1:
            out[group] = df[col]
        else:
            key = f"{group}:{parts[1]}"
            out[key] = df[col]
            labels[key] = parts[1].replace("Other Mixed or Multiple ethnic groups", "Other mixed or multiple")
    return out, labels


def scotland() -> tuple[pd.DataFrame, dict[str, str]]:
    z = zipfile.ZipFile(io.BytesIO(cached(RAW / "scot_oa.zip", SCOT_URL)))
    raw = z.read("UV201 - Ethnic group.csv").decode("utf-8-sig")
    lines = raw.splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith(',"All People"'))
    rows = [l for l in lines[start:] if l.startswith('"S00') or l.startswith(',"All')]
    df = pd.read_csv(io.StringIO("\n".join(rows)), na_values=["-"]).fillna(0)
    df = df.rename(columns={df.columns[0]: "oa"})
    out = pd.DataFrame({"oa": df["oa"], "total": df["All People"]})
    out["white"] = df["White: Total"]
    out["mixed"] = df["Mixed or multiple ethnic group"]
    out["asian"] = df["Asian, Asian Scottish or Asian British: Total"]
    out["black"] = df["African: Total"] + df["Caribbean or Black: Total"]
    out["other"] = df["Other ethnic groups: Total"]
    labels: dict[str, str] = {}
    detail = {
        "White: White Scottish": "white",
        "White: Other White British": "white",
        "White: White Irish": "white",
        "White: Gypsy/ Traveller": "white",
        "White: White Polish": "white",
        "Other White": "white",
    }
    for col in df.columns:
        for head, group in [
            ("Asian, Asian Scottish or Asian British: ", "asian"),
            ("African: ", "black"),
            ("Caribbean or Black: ", "black"),
            ("Other ethnic groups: ", "other"),
        ]:
            if col.startswith(head) and not col.endswith("Total"):
                detail[col] = group
    for col, group in detail.items():
        name = col.split(": ")[-1].split(",")[0].replace("Gypsy/ Traveller", "Gypsy or Traveller")
        key = f"{group}:{name}"
        out[key] = out.get(key, 0) + df[col]
        labels[key] = name
    return out, labels


def postcode_areas() -> pd.DataFrame:
    """Live GB postcodes with their census output area (no Northern Ireland rows)."""
    path = RAW / "pcd_oa.csv"
    if path.exists():
        return pd.read_csv(path, dtype=str)
    log("downloading the postcode to output area lookup (GB only)")
    where = "ctry26cd IN ('E92000001','W92000004','S92000003') AND doterm IS NULL"
    rows, offset = [], 0
    while True:
        q = {
            "where": where, "outFields": "pcds,oa21cd,usrtypind", "returnGeometry": "false",
            "orderByFields": "ObjectId", "resultType": "standard", "resultOffset": offset,
            "resultRecordCount": 32000, "f": "json",
        }
        page = json.loads(get(ONSPD + "?" + urllib.parse.urlencode(q)))
        if "error" in page:
            raise RuntimeError(page["error"])
        feats = page.get("features", [])
        rows.extend(f["attributes"] for f in feats)
        offset += len(feats)
        if not page.get("exceededTransferLimit") or not feats:
            break
    df = pd.DataFrame(rows).astype(str)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    log(f"{len(df):,} postcodes")
    return df


# ------------------------------------------------------------------------ build


def main() -> int:
    ew, ew_labels = england_wales()
    sc, sc_labels = scotland()
    log(f"output areas: {len(ew):,} England and Wales, {len(sc):,} Scotland")

    pc = postcode_areas()
    pc["district"] = pc.pcds.str.split(" ").str[0]
    # Residents live at residential (small user) postcodes; large-user
    # postcodes are businesses. Fall back to all postcodes for the rare output
    # area that has only large-user ones.
    res = pc[pc.usrtypind == "0"]
    weights = res.groupby(["oa21cd", "district"]).size().rename("n").reset_index()
    orphan = set(pc.oa21cd) - set(weights.oa21cd)
    if orphan:
        extra = pc[pc.oa21cd.isin(orphan)].groupby(["oa21cd", "district"]).size().rename("n").reset_index()
        weights = pd.concat([weights, extra])
    weights["w"] = weights.n / weights.groupby("oa21cd").n.transform("sum")

    result: dict[str, dict] = {}
    coverage = {}
    for name, counts, labels, year in [("ew", ew, ew_labels, 2021), ("s", sc, sc_labels, 2022)]:
        cols = [c for c in counts.columns if c != "oa"]
        m = weights.merge(counts, left_on="oa21cd", right_on="oa", how="inner")
        for c in cols:
            m[c] = m[c] * m.w
        agg = m.groupby("district")[cols].sum()
        covered = counts[counts.oa.isin(set(weights.oa21cd))].total.sum()
        coverage[name] = {"residents": int(counts.total.sum()), "matched": int(round(covered))}
        log(f"{name}: {coverage[name]['matched']:,} of {coverage[name]['residents']:,} residents matched to districts")
        details = [c for c in cols if ":" in c]
        for district, row in agg.iterrows():
            total = float(row.total)
            entry: dict = {"y": year, "t": int(round(total))}
            if total >= MIN_RESIDENTS:
                entry["g"] = [round(100 * row[g] / total, 1) for g in GROUPS]
                det = sorted(((labels[c], c.split(":")[0], round(100 * row[c] / total, 1)) for c in details), key=lambda x: -x[2])
                entry["d"] = [[lab, GROUPS.index(grp), pct] for lab, grp, pct in det if pct >= 0.5]
            if district in result:  # a district straddling the Scottish border
                if result[district]["t"] >= entry["t"]:
                    continue
            result[district] = entry

    for key, cov in coverage.items():
        if cov["matched"] < 0.98 * cov["residents"]:
            raise RuntimeError(f"only {cov['matched']:,} of {cov['residents']:,} residents matched for {key}")
    if len(result) < 2700:
        raise RuntimeError(f"only {len(result)} districts with census figures")

    meta = {
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "groups": ["White", "Asian", "Black, African or Caribbean", "Mixed or multiple", "Other, including Arab"],
        "minResidents": MIN_RESIDENTS,
        "coverage": coverage,
        "sources": [
            {"name": "ONS Census 2021: TS021 Ethnic group (England and Wales), output areas", "page": "https://www.ons.gov.uk/datasets/TS021", "url": EW_URL},
            {"name": "Scotland's Census 2022: UV201 Ethnic group, output areas (National Records of Scotland)", "page": SCOT_PAGE, "url": SCOT_URL},
            {"name": "ONS Postcode Directory (August 2026), GB postcodes", "page": "https://geoportal.statistics.gov.uk/"},
        ],
    }
    OUT.write_text(json.dumps({"meta": meta, "d": result}, separators=(",", ":")))
    log(f"wrote {OUT.relative_to(ROOT)}: {len(result):,} districts, {OUT.stat().st_size / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
