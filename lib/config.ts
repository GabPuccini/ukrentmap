/** Path prefix the site is served from: "" locally, "/ukrentmap" on GitHub Pages. */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Absolute URL for a file in public/. MapLibre needs absolute URLs. */
export function asset(path: string): string {
  return `${window.location.origin}${BASE}${path}`;
}

/** Great Britain and Northern Ireland, Scilly to Shetland. */
export const UK_BOUNDS: [[number, number], [number, number]] = [
  [-8.7, 49.85],
  [1.8, 60.9],
];
/** How far the map may be panned. Generous enough to frame the UK on any screen, never the world. */
export const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-26, 45],
  [16, 64],
];
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 13.5;
/** District code labels start here and fade in over one zoom level. */
export const LABEL_ZOOM = 8;
