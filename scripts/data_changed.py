#!/usr/bin/env python3
"""Has ONS or OS published new data since the live map was built?

Compares what fetch_data.py just downloaded (data-raw/sources.json) with what
the published map was built from (public/data/meta.json):

  rents      the ONS spreadsheet's edition, which is part of its URL
  postcodes  the Code-Point Open checksum, which changes each quarterly edition

Prints the answer. Under GitHub Actions it also writes `changed=true|false`
and a one-line `summary` to $GITHUB_OUTPUT for the refresh workflow.

    python3 scripts/data_changed.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIPR = "ONS Price Index of Private Rents"
CPO = "OS Code-Point Open"


def pick(sources: list[dict], prefix: str) -> dict:
    return next((s for s in sources if s.get("name", "").startswith(prefix)), {})


def main() -> int:
    new = json.loads((ROOT / "data-raw" / "sources.json").read_text())["sources"]
    meta_path = ROOT / "public" / "data" / "meta.json"
    old = json.loads(meta_path.read_text())["sources"] if meta_path.exists() else []

    changes = []
    if pick(new, PIPR).get("url") != pick(old, PIPR).get("url"):
        changes.append(f"rents edition {pick(new, PIPR).get('edition')}")
    if pick(new, CPO).get("md5") != pick(old, CPO).get("md5"):
        changes.append("new Code-Point Open edition")

    changed = bool(changes)
    summary = ", ".join(changes) if changed else "no new data"
    print(f"changed={str(changed).lower()}: {summary}")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"changed={str(changed).lower()}\n")
            f.write(f"summary={summary}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
