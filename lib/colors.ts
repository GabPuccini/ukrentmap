import type { ExpressionSpecification } from "maplibre-gl";
import type { RentKey } from "./types";

/** ColorBrewer RdYlGn, reversed: green is cheapest, red most expensive. */
export const RAMP_STANDARD = ["#1a9641", "#a6d96a", "#ffffbf", "#fdae61", "#d7191c"];
/** Viridis: perceptually uniform and readable with every common colour vision deficiency. */
export const RAMP_CVD = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
/** Districts with no published rent. Neutral, and not on either ramp. */
export const NO_DATA = "#a3a3a3";

export function ramp(cvd: boolean): string[] {
  return cvd ? RAMP_CVD : RAMP_STANDARD;
}

/** Interpolation stops must strictly increase; nudge ties apart by £1. */
function ascending(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) out.push(out.length && v <= out[out.length - 1] ? out[out.length - 1] + 1 : v);
  return out;
}

/**
 * Fill colour for the district layer. Colours sit at the 5th, 25th, 50th,
 * 75th and 95th percentile of the district values, so the ramp follows the
 * data's own distribution and a few very expensive areas cannot flatten the
 * rest. Anything beyond the end stops takes the end colour. Missing values
 * are grey, never guessed.
 */
export function fillColor(key: RentKey, stops: number[], cvd: boolean): ExpressionSpecification {
  const colours = ramp(cvd);
  const s = ascending(stops);
  const pairs = s.flatMap((v, i) => [v, colours[i]]);
  return [
    "case",
    ["has", key],
    ["interpolate-lab", ["linear"], ["get", key], ...pairs] as unknown as ExpressionSpecification,
    NO_DATA,
  ];
}

function hex(c: string): number[] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The same colour the map draws for a value, for swatches in the popup. */
export function colourFor(value: number | null | undefined, stops: number[], cvd: boolean): string {
  if (value == null) return NO_DATA;
  const colours = ramp(cvd);
  const s = ascending(stops);
  if (value <= s[0]) return colours[0];
  if (value >= s[s.length - 1]) return colours[colours.length - 1];
  let i = 0;
  while (value > s[i + 1]) i++;
  const t = (value - s[i]) / (s[i + 1] - s[i]);
  const a = hex(colours[i]);
  const b = hex(colours[i + 1]);
  const mix = a.map((v, j) => Math.round(v + (b[j] - v) * t));
  return `rgb(${mix.join(",")})`;
}

/** Black or white text, whichever reads better on a swatch. */
export function textOn(colour: string): string {
  const m = colour.match(/\d+/g);
  const [r, g, b] = colour.startsWith("#") ? hex(colour) : (m ?? ["0", "0", "0"]).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111" : "#fff";
}

/**
 * Broad ethnic groups, in fixed order: White, Asian, Black, Mixed, Other.
 * Categorical slots 1-5 of a palette checked for colour-vision separation
 * (scripts: dataviz validate_palette). They are not on either rent ramp, and
 * every segment is also labelled with its name and percentage.
 */
export const ETHNIC_COLOURS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
