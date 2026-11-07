import { WalkNetwork, type Tile } from "./tiles";

/**
 * Shortest walking route between two points, found on the device.
 *
 * Each point is snapped to the nearest walkable way. An A* search then runs
 * over the network, with the straight-line distance to the destination as
 * its estimate (a route can never be shorter than that, so the answer is the
 * true shortest path). Tiles load as the search reaches them.
 */

export interface WalkRoute {
  /** total walk, including the short legs from each postcode to the nearest path */
  metres: number;
  straight: number;
  coords: [number, number][];
  tiles: number;
}

export class WalkError extends Error {}

type Pt = [number, number];
const EARTH = 6_371_008.8;
const RAD = Math.PI / 180;
/** Beyond this straight-line distance, it's not a walk. */
export const MAX_STRAIGHT_M = 40_000;
const SNAP_RADIUS_M = 1500;
const MAX_TILES = 260;

export function distance(a: Pt, b: Pt): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

function coord(t: Tile, id: number): Pt {
  const i = id - t.base;
  return [t.lon[i], t.lat[i]];
}

/** A min-heap of (priority, id). */
class Heap {
  private p: number[] = [];
  private v: number[] = [];
  get size() {
    return this.p.length;
  }
  push(pri: number, val: number) {
    const p = this.p;
    const v = this.v;
    let i = p.length;
    p.push(pri);
    v.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pri) break;
      p[i] = p[up];
      v[i] = v[up];
      i = up;
    }
    p[i] = pri;
    v[i] = val;
  }
  pop(): [number, number] {
    const p = this.p;
    const v = this.v;
    const top: [number, number] = [p[0], v[0]];
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (p.length) {
      let i = 0;
      const n = p.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && p[r] < p[l] ? r : l;
        if (p[c] >= lp) break;
        p[i] = p[c];
        v[i] = v[c];
        i = c;
      }
      p[i] = lp;
      v[i] = lv;
    }
    return top;
  }
}

interface Snap {
  /** canonical edge ends: s < t */
  s: number;
  t: number;
  /** metres along the edge from s, and from t, to the snap point */
  fromS: number;
  fromT: number;
  point: Pt;
  /** straight metres from the postcode to the snap point */
  off: number;
  /** the edge's points from s to t, and where the snap point falls in them */
  line: Pt[];
  seg: number;
}

export class Router {
  private constructor(private net: WalkNetwork) {}

  static async open(): Promise<Router> {
    return new Router(await WalkNetwork.open());
  }

  /** The points of edge (from -> to), in that direction. */
  private async edgeLine(from: number, j: number, tFrom: Tile): Promise<Pt[]> {
    const to = tFrom.target[j];
    const ref = tFrom.shape[j];
    const tTo = await this.net.tileOf(to);
    const a = coord(tFrom, from);
    const b = coord(tTo, to);
    if (!ref) return [a, b];
    const low = from < to ? tFrom : tTo;
    const mid: Pt[] = [];
    for (let k = low.shapeStart[ref - 1]; k < low.shapeStart[ref]; k++) mid.push([low.shapeLon[k], low.shapeLat[k]]);
    if (from > to) mid.reverse();
    return [a, ...mid, b];
  }

  private async snap(p: Pt, label: string): Promise<Snap> {
    const { dx, dy } = this.net.index.grid;
    const keys = new Set<number>();
    for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) keys.add(this.net.keyAt(p[0] + ox * dx, p[1] + oy * dy));
    const tiles = await Promise.all([...keys].filter((k) => this.net.has(k)).map((k) => this.net.tile(k)));
    tiles.forEach((t) => this.net.remember(t));
    if (!tiles.length) throw new WalkError(`There are no walkable paths near ${label}.`);

    // Local flat projection around p, in metres.
    const kx = Math.cos(p[1] * RAD) * EARTH * RAD;
    const ky = EARTH * RAD;
    let best: Snap | null = null;
    let bestD = Infinity;
    for (const t of tiles) {
      for (let i = 0; i < t.lon.length; i++) {
        const s = t.base + i;
        // Quick reject: both ends far away and the edge short.
        for (let j = t.edgeStart[i]; j < t.edgeStart[i + 1]; j++) {
          const to = t.target[j];
          if (to < s) continue; // each edge once, from its lower end
          const tt = this.net.tileOfSync(to);
          if (!tt) continue;
          const ax = (t.lon[i] - p[0]) * kx;
          const ay = (t.lat[i] - p[1]) * ky;
          const bx = (tt.lon[to - tt.base] - p[0]) * kx;
          const by = (tt.lat[to - tt.base] - p[1]) * ky;
          const reach = t.metres[j] + bestD;
          if (Math.min(Math.hypot(ax, ay), Math.hypot(bx, by)) > reach) continue;
          const line = await this.edgeLine(s, j, t);
          let along = 0;
          let total = 0;
          const segLen: number[] = [];
          for (let k = 0; k + 1 < line.length; k++) {
            const l = Math.hypot((line[k + 1][0] - line[k][0]) * kx, (line[k + 1][1] - line[k][1]) * ky);
            segLen.push(l);
            total += l;
          }
          let found = -1;
          let foundT = 0;
          let foundD = Infinity;
          let acc = 0;
          for (let k = 0; k + 1 < line.length; k++) {
            const x1 = (line[k][0] - p[0]) * kx;
            const y1 = (line[k][1] - p[1]) * ky;
            const x2 = (line[k + 1][0] - p[0]) * kx;
            const y2 = (line[k + 1][1] - p[1]) * ky;
            const vx = x2 - x1;
            const vy = y2 - y1;
            const len2 = vx * vx + vy * vy;
            const u = len2 > 0 ? Math.max(0, Math.min(1, -(x1 * vx + y1 * vy) / len2)) : 0;
            const d = Math.hypot(x1 + u * vx, y1 + u * vy);
            if (d < foundD) {
              foundD = d;
              found = k;
              foundT = u;
              along = acc + u * segLen[k];
            }
            acc += segLen[k];
          }
          if (foundD < bestD) {
            bestD = foundD;
            const frac = total > 0 ? along / total : 0;
            const a = line[found];
            const b = line[found + 1];
            best = {
              s,
              t: to,
              fromS: t.metres[j] * frac,
              fromT: t.metres[j] * (1 - frac),
              point: [a[0] + (b[0] - a[0]) * foundT, a[1] + (b[1] - a[1]) * foundT],
              off: foundD,
              line,
              seg: found,
            };
          }
        }
      }
    }
    if (!best || bestD > SNAP_RADIUS_M) throw new WalkError(`There are no walkable paths within ${SNAP_RADIUS_M / 1000} km of ${label}.`);
    return best;
  }

  async route(a: Pt, b: Pt, labels: [string, string], progress?: (tiles: number) => void): Promise<WalkRoute> {
    const straight = distance(a, b);
    if (straight > MAX_STRAIGHT_M) {
      throw new WalkError(
        `These are ${(straight / 1000).toFixed(1)} km apart in a straight line. That's too far for a walking route here (limit ${MAX_STRAIGHT_M / 1000} km).`,
      );
    }
    const [sa, sb] = await Promise.all([this.snap(a, labels[0]), this.snap(b, labels[1])]);
    const goal = sb.point;
    const h = (t: Tile, id: number) => distance(coord(t, id), goal) * 0.999;

    const g = new Map<number, number>();
    const prev = new Map<number, number>(); // vertex -> previous vertex
    const via = new Map<number, number>(); // vertex -> edge index in previous vertex's tile
    const heap = new Heap();
    const GOAL = -1;
    let goalCost = Infinity;
    let goalFrom = NaN; // vertex the goal was reached from, or NaN for "along the same edge"

    const ta = await this.net.tileOf(sa.s);
    const tb = await this.net.tileOf(sa.t);
    for (const [id, cost, tile] of [[sa.s, sa.fromS, ta], [sa.t, sa.fromT, tb]] as const) {
      g.set(id, cost);
      heap.push(cost + h(tile, id), id);
    }
    if (sa.s === sb.s && sa.t === sb.t) {
      goalCost = Math.abs(sa.fromS - sb.fromS);
      heap.push(goalCost, GOAL);
    }
    const remain = new Map<number, number>([
      [sb.s, sb.fromS],
      [sb.t, sb.fromT],
    ]);
    const limit = straight * 3 + 5000;
    let pops = 0;

    for (;;) {
      if (!heap.size) throw new WalkError("No walking route links these postcodes (one may be on an island or a private road).");
      const [f, id] = heap.pop();
      if (id === GOAL) break;
      const gi = g.get(id)!;
      if (f - h(this.net.tileOfSync(id)!, id) > gi + 1e-6) continue; // stale entry
      if (gi > limit) throw new WalkError("No walking route found within a reasonable distance of the straight line.");
      const r = remain.get(id);
      if (r !== undefined && gi + r < goalCost) {
        goalCost = gi + r;
        goalFrom = id;
        heap.push(goalCost, GOAL);
      }
      const t = await this.net.tileOf(id);
      const i = id - t.base;
      for (let j = t.edgeStart[i]; j < t.edgeStart[i + 1]; j++) {
        const w = t.target[j];
        const ng = gi + t.metres[j];
        if (ng < (g.get(w) ?? Infinity)) {
          let tw = this.net.tileOfSync(w);
          if (!tw) {
            if (this.net.tilesLoaded > MAX_TILES) throw new WalkError("This route needs too much map data to work out here.");
            tw = await this.net.tileOf(w);
            progress?.(this.net.tilesLoaded);
          }
          g.set(w, ng);
          prev.set(w, id);
          via.set(w, j);
          heap.push(ng + h(tw, w), w);
        }
      }
      if (++pops % 4000 === 0) await new Promise((res) => setTimeout(res, 0)); // keep the page responsive
    }

    // ------------------------------------------------------------ the line
    const coords: Pt[] = [a, sa.point];
    if (Number.isNaN(goalFrom)) {
      // Both on the same edge: follow its shape between the two snap points.
      const forward = sa.fromS <= sb.fromS;
      const mid = forward ? sa.line.slice(sa.seg + 1, sb.seg + 1) : sa.line.slice(sb.seg + 1, sa.seg + 1).reverse();
      coords.push(...mid, sb.point);
    } else {
      const chain: number[] = [goalFrom];
      while (prev.has(chain[chain.length - 1])) chain.push(prev.get(chain[chain.length - 1])!);
      chain.reverse();
      const first = chain[0];
      // From the start snap point along its edge to the first vertex.
      const toS = first === sa.s;
      const startPart = toS ? sa.line.slice(0, sa.seg + 1).reverse() : sa.line.slice(sa.seg + 1);
      coords.push(...startPart);
      for (let k = 1; k < chain.length; k++) {
        const from = chain[k - 1];
        const tf = await this.net.tileOf(from);
        const line = await this.edgeLine(from, via.get(chain[k])!, tf);
        coords.push(...line.slice(1));
      }
      const last = chain[chain.length - 1];
      const endPart = last === sb.s ? sb.line.slice(1, sb.seg + 1) : sb.line.slice(sb.seg + 1, -1).reverse();
      coords.push(...endPart, sb.point);
    }
    coords.push(b);
    return { metres: goalCost + sa.off + sb.off, straight, coords, tiles: this.net.tilesLoaded };
  }
}
