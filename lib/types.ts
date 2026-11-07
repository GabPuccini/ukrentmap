/** Rent field names used in the tiles and data files: all homes, then 1, 2, 3, 4+ bedrooms. */
export type RentKey = "r0" | "r1" | "r2" | "r3" | "r4";
/** The bedroom counts the selector offers. */
export type Beds = "r1" | "r2" | "r3" | "r4";

export const BED_KEYS: Beds[] = ["r1", "r2", "r3", "r4"];
export const BED_LABEL: Record<RentKey, string> = {
  r0: "All homes",
  r1: "1 bed",
  r2: "2 bed",
  r3: "3 bed",
  r4: "4+ bed",
};
/** Index of each key in RentArea.r */
export const RENT_INDEX: Record<RentKey, number> = { r0: 0, r1: 1, r2: 2, r3: 3, r4: 4 };

export interface District {
  /** live postcodes in the district */
  k: number;
  /** country: England, Wales or Scotland */
  cy: "E" | "W" | "S";
  /** local authority holding most of its postcodes */
  la: string;
  /** largest electoral wards, by postcode count */
  w: string[];
  /** rent area key: LA code (E/W), BRMA code (Scotland) */
  ra: string;
  /** split across rent areas, [name, percent of postcodes], when more than one */
  sh?: [string, number][];
  /** label point [lng, lat] */
  p: [number, number];
  /** bounding box [w, s, e, n], absent for districts with no land polygon */
  b?: [number, number, number, number];
}

export interface RentArea {
  /** name as published by ONS */
  n: string;
  /** data month, YYYY-MM, or null when ONS publishes no figure */
  m: string | null;
  /** [all homes, 1 bed, 2 bed, 3 bed, 4+ bed] average monthly rent in £ */
  r: (number | null)[];
}

export interface DistrictData {
  d: Record<string, District>;
  a: Record<string, RentArea>;
  /** Northern Ireland postcode district -> rent area key */
  ni: Record<string, string>;
}

export interface Source {
  name: string;
  page: string;
  url?: string;
  edition?: string | null;
  layer?: string;
}

export interface Meta {
  built: string;
  rentMonth: string;
  rentMonthNI: string | null;
  piprPublished: string;
  percentiles: number[];
  scale: Record<RentKey, number[]>;
  counts: { postcodes: number; districts: number; polygons: number; noData: number };
  noDataDistricts: string[];
  sources: Source[];
  fetched: string;
}

/** Census ethnic group of the residents of one postcode district. */
export interface EthnicityEntry {
  /** census year: 2021 for England and Wales, 2022 for Scotland */
  y: number;
  /** usual residents */
  t: number;
  /** percent in each broad group, in EthnicityData.meta.groups order; absent when too few residents */
  g?: number[];
  /** detailed groups of at least 0.5%: [label, broad group index, percent], largest first */
  d?: [string, number, number][];
}

export interface EthnicityData {
  meta: {
    built: string;
    groups: string[];
    minResidents: number;
    sources: Source[];
  };
  d: Record<string, EthnicityEntry>;
}
