import { BASE } from "./config";
import type { DistrictData } from "./types";

/**
 * Postcode search, entirely on the device. Postcode positions come from the
 * bundled Code-Point Open files in public/data/pc/, one per postcode area
 * (the letters at the start), fetched from this site on first use and then
 * kept by the service worker for offline use. Nothing is sent anywhere else.
 */

type Shard = Map<string, Map<string, [number, number]>>; // district -> inward code -> [lng, lat]

const shards = new Map<string, Promise<Shard>>();

function parseShard(text: string): Shard {
  const shard: Shard = new Map();
  let current: Map<string, [number, number]> | null = null;
  let bx = 0;
  let by = 0;
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const [code, xs, ys] = line.split(" ");
    const x = Number(xs);
    const y = Number(ys);
    if (code.charCodeAt(0) >= 65) {
      // a district header: "M14 -22284 534489"
      current = new Map();
      shard.set(code, current);
      bx = x;
      by = y;
    } else if (current) {
      // a postcode: "5AB 12 -5", offsets from the header in 1e-4 degrees
      current.set(code, [(bx + x) / 1e4, (by + y) / 1e4]);
    }
  }
  return shard;
}

function loadShard(area: string): Promise<Shard> {
  let p = shards.get(area);
  if (!p) {
    p = fetch(`${BASE}/data/pc/${area}.txt`).then(async (r) => {
      if (!r.ok) throw new Error(`no postcode file for ${area}`);
      return parseShard(await r.text());
    });
    p.catch(() => shards.delete(area));
    shards.set(area, p);
  }
  return p;
}

export type Hit =
  | { kind: "postcode" | "sector"; label: string; district: string; lngLat: [number, number] }
  | { kind: "district"; label: string; district: string }
  | { kind: "ni"; label: string; district: string; area: string }
  | { kind: "error"; message: string };

const DISTRICT = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
const FULL = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;

export function normalise(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export async function resolve(query: string, data: DistrictData): Promise<Hit> {
  const s = normalise(query);
  if (!s) return { kind: "error", message: "Type a postcode, such as M14 5AB, or a district such as CF10." };

  let out: string;
  let inward = "";
  const compact = s.replace(/ /g, "");
  const full = FULL.exec(compact);
  if (s.includes(" ")) {
    [out, inward] = s.split(" ");
  } else if (full && !data.d[compact] && !data.ni[compact]) {
    [, out, inward] = full;
  } else if (!data.d[s] && !data.ni[s] && /[0-9]$/.test(s) && data.d[s.slice(0, -1)]) {
    out = s.slice(0, -1); // "M145" -> sector M14 5
    inward = s.slice(-1);
  } else {
    out = s;
  }

  if (!DISTRICT.test(out)) return { kind: "error", message: `"${query.trim()}" doesn't look like a UK postcode.` };

  if (out.startsWith("BT")) {
    const area = data.ni[out];
    if (!area) return { kind: "error", message: `${out} isn't a Northern Ireland postcode district I have a rent area for.` };
    return { kind: "ni", label: inward ? `${out} ${inward}` : out, district: out, area };
  }

  const d = data.d[out];
  if (!d) return { kind: "error", message: `${out} isn't a live postcode district in Code-Point Open.` };
  if (!inward) return { kind: "district", label: out, district: out };

  const area = out.match(/^[A-Z]+/)![0];
  let shard: Shard;
  try {
    shard = await loadShard(area);
  } catch {
    return { kind: "error", message: "Couldn't load the postcode list. Check your connection and try again." };
  }
  const codes = shard.get(out);

  if (/^[0-9]$/.test(inward)) {
    const pts = [...(codes ?? new Map()).entries()].filter(([k]) => k[0] === inward).map(([, v]) => v);
    if (!pts.length) return { kind: "error", message: `No live postcodes in sector ${out} ${inward}.` };
    const lng = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return { kind: "sector", label: `${out} ${inward}`, district: out, lngLat: [lng, lat] };
  }

  if (!/^[0-9][A-Z]{2}$/.test(inward)) return { kind: "error", message: `"${query.trim()}" doesn't look like a UK postcode.` };
  const at = codes?.get(inward);
  if (!at) {
    return {
      kind: "error",
      message: `${out} ${inward} isn't a live postcode with a location in Code-Point Open. Showing nothing rather than guessing.`,
    };
  }
  return { kind: "postcode", label: `${out} ${inward}`, district: out, lngLat: at };
}
