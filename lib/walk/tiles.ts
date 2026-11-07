import { BASE } from "../config";

/**
 * The walking network, as built by scripts/build_walk.py: one small binary
 * tile per ~5 x 5 km square, fetched from this site only when a route needs
 * it, then kept by the service worker for offline use.
 */

export interface WalkIndex {
  version: number;
  grid: { x0: number; y0: number; dx: number; dy: number; nx: number };
  /** [tile key, first vertex id, vertex count], sorted by key and so by first id */
  tiles: [number, number, number][];
  km: number;
  osmDate: string;
}

export interface Tile {
  key: number;
  /** global id of vertex 0 */
  base: number;
  lon: Float64Array;
  lat: Float64Array;
  /** edges of local vertex i are edgeStart[i] .. edgeStart[i + 1] - 1 */
  edgeStart: Uint32Array;
  target: Float64Array;
  metres: Float32Array;
  /** 1-based shape index in the tile of the edge's lower-id end; 0 = straight */
  shape: Uint32Array;
  /** shape k's points are shapeStart[k] .. shapeStart[k + 1] - 1 */
  shapeStart: Uint32Array;
  shapeLon: Float64Array;
  shapeLat: Float64Array;
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  uint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }
  int(): number {
    const n = this.uint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
}

function decode(key: number, base: number, buf: Uint8Array): Tile {
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "UKW1") throw new Error("not a walking tile");
  const r = new Reader(buf);
  r.pos = 4;
  r.uint(); // version
  const nV = r.uint();
  const nE = r.uint();
  const nG = r.uint();
  const lon = new Float64Array(nV);
  const lat = new Float64Array(nV);
  let x = 0;
  let y = 0;
  for (let i = 0; i < nV; i++) {
    x += r.int();
    y += r.int();
    lon[i] = x / 1e6;
    lat[i] = y / 1e6;
  }
  const edgeStart = new Uint32Array(nV + 1);
  for (let i = 0; i < nV; i++) edgeStart[i + 1] = edgeStart[i] + r.uint();
  const target = new Float64Array(nE);
  const metres = new Float32Array(nE);
  const shape = new Uint32Array(nE);
  for (let i = 0; i < nV; i++) {
    for (let j = edgeStart[i]; j < edgeStart[i + 1]; j++) {
      target[j] = base + i + r.int();
      metres[j] = r.uint();
      shape[j] = r.uint();
    }
  }
  const shapeStart = new Uint32Array(nG + 1);
  const sLon: number[] = [];
  const sLat: number[] = [];
  let src = base;
  for (let g = 0; g < nG; g++) {
    src += r.uint();
    const n = r.uint();
    let px = Math.round(lon[src - base] * 1e6);
    let py = Math.round(lat[src - base] * 1e6);
    for (let k = 0; k < n; k++) {
      px += r.int();
      py += r.int();
      sLon.push(px / 1e6);
      sLat.push(py / 1e6);
    }
    shapeStart[g + 1] = sLon.length;
  }
  return {
    key,
    base,
    lon,
    lat,
    edgeStart,
    target,
    metres,
    shape,
    shapeStart,
    shapeLon: Float64Array.from(sLon),
    shapeLat: Float64Array.from(sLat),
  };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Some servers already undo the gzip; the tile then starts with "UKW1".
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class WalkNetwork {
  private tiles = new Map<number, Promise<Tile>>();
  private bases: Float64Array;
  private loaded = 0;

  private constructor(readonly index: WalkIndex) {
    this.bases = Float64Array.from(index.tiles.map((t) => t[1]));
  }

  static async open(): Promise<WalkNetwork> {
    const r = await fetch(`${BASE}/data/walk/index.json`);
    if (!r.ok) throw new Error("Couldn't load the walking network. Check your connection.");
    return new WalkNetwork((await r.json()) as WalkIndex);
  }

  get tilesLoaded(): number {
    return this.loaded;
  }

  keyAt(lng: number, lat: number): number {
    const { x0, y0, dx, dy, nx } = this.index.grid;
    return Math.floor((lat - y0) / dy) * nx + Math.floor((lng - x0) / dx);
  }

  /** Index of the tile holding global vertex id, by binary search on first ids. */
  private tileIndexOf(id: number): number {
    let lo = 0;
    let hi = this.bases.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bases[mid] <= id) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private entry(key: number): [number, number, number] | undefined {
    const t = this.index.tiles;
    let lo = 0;
    let hi = t.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid][0] === key) return t[mid];
      if (t[mid][0] < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  has(key: number): boolean {
    return this.entry(key) !== undefined;
  }

  tile(key: number): Promise<Tile> {
    let p = this.tiles.get(key);
    if (!p) {
      const e = this.entry(key);
      if (!e) return Promise.reject(new Error(`no walking tile ${key}`));
      p = fetch(`${BASE}/data/walk/${key}.bin.gz`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`walking tile ${key}: HTTP ${r.status}`);
          this.loaded++;
          return decode(key, e[1], await gunzip(new Uint8Array(await r.arrayBuffer())));
        });
      p.catch(() => this.tiles.delete(key));
      this.tiles.set(key, p);
    }
    return p;
  }

  /** The tile holding a vertex, if already loaded (no await on the hot path). */
  private ready = new Map<number, Tile>();
  async tileOf(id: number): Promise<Tile> {
    const key = this.index.tiles[this.tileIndexOf(id)][0];
    const t = this.ready.get(key);
    if (t) return t;
    const loaded = await this.tile(key);
    this.ready.set(key, loaded);
    return loaded;
  }
  tileOfSync(id: number): Tile | undefined {
    return this.ready.get(this.index.tiles[this.tileIndexOf(id)][0]);
  }
  remember(t: Tile): void {
    this.ready.set(t.key, t);
  }
}
