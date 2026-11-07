"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Router, WalkError, type WalkRoute } from "@/lib/walk/router";
import { resolve } from "@/lib/search";
import type { DistrictData } from "@/lib/types";

type Pt = [number, number];

let router: Promise<Router> | null = null;
function getRouter(): Promise<Router> {
  if (!router) {
    router = Router.open();
    router.catch(() => (router = null));
  }
  return router;
}

/** Walking at about 3 mph (4.8 km/h), a common planning figure. */
const METRES_PER_MINUTE = 80;

export function formatWalk(r: WalkRoute): { distance: string; time: string } {
  const km = r.metres / 1000;
  const miles = r.metres / 1609.344;
  const distance = km < 1 ? `${Math.round(r.metres / 10) * 10} m (${miles.toFixed(2)} mi)` : `${km.toFixed(1)} km (${miles.toFixed(1)} mi)`;
  const mins = Math.max(1, Math.round(r.metres / METRES_PER_MINUTE));
  const time = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
  return { distance, time };
}

interface Props {
  data: DistrictData | null;
  onRoute: (route: WalkRoute, from: string, to: string) => void;
}

/** From and To postcodes; works out the walking route on the device. */
export default function WalkPanel({ data, onRoute }: Props) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ route: WalkRoute; from: string; to: string } | null>(null);
  const run = useRef(0);

  async function locate(q: string, which: string): Promise<{ at: Pt; label: string }> {
    if (!q.trim()) throw new WalkError(`Type a ${which} postcode.`);
    const hit = await resolve(q, data!);
    if (hit.kind === "error") throw new WalkError(`${which}: ${hit.message}`);
    if (hit.kind === "ni") throw new WalkError(`${which}: Northern Ireland postcodes can't be located, because their positions aren't open data.`);
    if (hit.kind === "district") return { at: data!.d[hit.district].p, label: hit.label };
    return { at: hit.lngLat, label: hit.label };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !data) return;
    const id = ++run.current;
    setBusy(true);
    setResult(null);
    setMsg("Finding postcodes…");
    try {
      const [a, b] = await Promise.all([locate(from, "From"), locate(to, "To")]);
      setMsg("Working out the walking route…");
      const r = await getRouter();
      const route = await r.route(a.at, b.at, [a.label, b.label], (n) => id === run.current && setMsg(`Loading paths… (${n} map areas)`));
      if (id !== run.current) return;
      setMsg(null);
      setResult({ route, from: a.label, to: b.label });
      (document.activeElement as HTMLElement | null)?.blur();
    } catch (err) {
      if (id !== run.current) return;
      setMsg(err instanceof WalkError || (err instanceof Error && /walking|tile|network/i.test(err.message)) ? err.message : "Something went wrong working out the route.");
      if (!(err instanceof WalkError)) console.error(err);
    } finally {
      if (id === run.current) setBusy(false);
    }
  }

  // Draw the route once the result box is on screen, so the map can frame
  // the route in the space left below it.
  useEffect(() => {
    if (result) requestAnimationFrame(() => onRoute(result.route, result.from, result.to));
  }, [result, onRoute]);

  const f = result && formatWalk(result.route);
  return (
    <form className="walk" onSubmit={submit} aria-label="Walking distance between two postcodes">
      <input
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        placeholder="From"
        aria-label="From postcode"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={10}
      />
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="To"
        aria-label="To postcode"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={10}
      />
      <button type="submit" disabled={busy || !data}>
        {busy ? "…" : "Go"}
      </button>
      {msg && (
        <p className="walk-msg" role="status">
          {msg}
        </p>
      )}
      {f && result && (
        <div className="walk-result" role="status">
          <strong>{f.distance}</strong> <span>· about {f.time} on foot</span>
          <small>
            {result.from} → {result.to}. Shortest route on streets and paths; straight line {(result.route.straight / 1000).toFixed(1)} km.
            Paths © OpenStreetMap contributors.
          </small>
        </div>
      )}
    </form>
  );
}
