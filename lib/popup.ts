import { colourFor, textOn } from "./colors";
import { COUNTRY, monthName, pounds } from "./format";
import { BED_KEYS, BED_LABEL, RENT_INDEX, type Beds, type DistrictData, type Meta, type RentArea } from "./types";

type Child = Node | string | null | undefined | false;

function el(tag: string, cls?: string, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c) e.append(c);
  return e;
}

function add(parent: HTMLElement, ...children: Child[]): void {
  for (const c of children) if (c) parent.append(c);
}

function rentTable(area: RentArea | undefined, beds: Beds): HTMLElement {
  const table = el("table", "pp-beds");
  const body = el("tbody");
  for (const key of [...BED_KEYS, "r0" as const]) {
    const v = area?.r[RENT_INDEX[key]] ?? null;
    const row = el("tr", key === beds ? "on" : key === "r0" ? "all" : undefined, el("th", undefined, BED_LABEL[key]), el("td", undefined, pounds(v)));
    body.append(row);
  }
  table.append(body);
  return table;
}

function headline(area: RentArea | undefined, beds: Beds, meta: Meta, cvd: boolean, reason: string): HTMLElement {
  const v = area?.r[RENT_INDEX[beds]] ?? null;
  const bg = colourFor(v, meta.scale[beds], cvd);
  const big = el("div", "pp-big");
  big.style.background = bg;
  big.style.color = textOn(bg);
  if (v == null) {
    big.append(el("strong", undefined, "No data"));
    return el("div", undefined, big, el("p", "pp-note", reason));
  }
  big.append(el("strong", undefined, pounds(v)), el("span", undefined, ` a month, average ${BED_LABEL[beds]}`));
  return big;
}

function source(area: RentArea | undefined, meta: Meta): HTMLElement {
  const month = monthName(area?.m ?? meta.rentMonth);
  return el(
    "p",
    "pp-src",
    `Source: ONS Price Index of Private Rents, ${month} (published ${meta.piprPublished}). `,
    "Mean rent over new and existing tenancies in the whole rent area.",
  );
}

export function districtPopup(code: string, data: DistrictData, meta: Meta, beds: Beds, cvd: boolean): HTMLElement {
  const d = data.d[code];
  const root = el("div", "pp");
  if (!d) {
    root.append(el("div", "pp-head", el("span", "pp-code", code)), el("p", "pp-note", "No details for this district."));
    return root;
  }
  const area = data.a[d.ra];
  const isBrma = d.ra.startsWith("S33");
  const areaName = area?.n ?? d.la;

  add(
    root,
    el("div", "pp-head", el("span", "pp-code", code), el("span", "pp-country", COUNTRY[d.cy])),
    d.w.length ? el("div", "pp-name", d.w.join(", ")) : null,
    el("div", "pp-la", d.la),
    headline(area, beds, meta, cvd, `ONS publishes no rent figure for ${areaName}. Shown grey rather than guessed.`),
    area?.m ? rentTable(area, beds) : null,
    el(
      "p",
      "pp-area",
      "Figures for ",
      el("b", undefined, areaName),
      isBrma
        ? " (Broad Rental Market Area: ONS publishes Scottish rents for these areas, not councils)."
        : " (local authority), shared by every district in it.",
    ),
    d.sh
      ? el("p", "pp-split", "Spans " + d.sh.map(([n, p]) => `${n} ${p}%`).join(", ") + "; uses the largest.")
      : null,
    source(area, meta),
  );
  return root;
}

const NI_NOTE =
  "Northern Ireland postcode positions are licensed by Land & Property Services for internal use only, so they can't be published on a public site. NI is drawn as one grey area, and a BT postcode shows the rent area it belongs to.";

export function niPopup(district: string | null, label: string | null, data: DistrictData, meta: Meta, beds: Beds, cvd: boolean): HTMLElement {
  const root = el("div", "pp");
  const month = monthName(meta.rentMonthNI);
  if (district) {
    const key = data.ni[district];
    const area = data.a[key];
    add(
    root,
      el("div", "pp-head", el("span", "pp-code", label ?? district), el("span", "pp-country", "Northern Ireland")),
      el("div", "pp-la", `${area?.n ?? key.replace("NI:", "")}`),
      headline(area, beds, meta, cvd, "ONS publishes no rent figure for this area."),
      area?.m ? rentTable(area, beds) : null,
      el("p", "pp-area", `Figures for the whole ${area?.n ?? "rent area"}, which NIHE defines as a set of postcode districts. ${district} is one of them.`),
      el("p", "pp-note", NI_NOTE),
      el("p", "pp-src", `Source: ONS Price Index of Private Rents, ${month}, the latest Northern Ireland month ONS publishes (published ${meta.piprPublished}).`),
    );
    return root;
  }
  const list = el("table", "pp-beds pp-ni");
  const body = el("tbody");
  const areas = Object.entries(data.a).filter(([k]) => k.startsWith("NI:"));
  areas.sort((a, b) => (b[1].r[RENT_INDEX[beds]] ?? 0) - (a[1].r[RENT_INDEX[beds]] ?? 0));
  for (const [, a] of areas) {
    const v = a.r[RENT_INDEX[beds]];
    const sw = el("span", "sw");
    sw.style.background = colourFor(v, meta.scale[beds], cvd);
    body.append(el("tr", undefined, el("th", undefined, sw, a.n.replace(" BRMA", "").replace(" Northern Ireland", "")), el("td", undefined, pounds(v))));
  }
  list.append(body);
  add(
    root,
    el("div", "pp-head", el("span", "pp-code", "Northern Ireland")),
    el("div", "pp-la", `Average ${BED_LABEL[beds]} rent by Broad Rental Market Area, ${month}`),
    list,
    el("p", "pp-note", NI_NOTE + " Search a BT postcode to find its area."),
    el("p", "pp-src", `Source: ONS Price Index of Private Rents (published ${meta.piprPublished}). Postcode district lists: NIHE.`),
  );
  return root;
}
