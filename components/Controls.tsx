"use client";

import { NO_DATA, ramp } from "@/lib/colors";
import { pounds } from "@/lib/format";
import { BED_KEYS, BED_LABEL, type Beds } from "@/lib/types";

interface Props {
  beds: Beds;
  onBeds: (b: Beds) => void;
  cvd: boolean;
  onCvd: () => void;
  stops: number[];
  percentiles: number[];
  onAbout: () => void;
}

/** Bedroom selector, colour-blind toggle and the legend, with real £ values at each stop. */
export default function Controls({ beds, onBeds, cvd, onCvd, stops, percentiles, onAbout }: Props) {
  const colours = ramp(cvd);
  const gradient = `linear-gradient(to right, ${colours.map((c, i) => `${c} ${(i / (colours.length - 1)) * 100}%`).join(", ")})`;
  return (
    <section className="panel" aria-label="Map key">
      <div className="row">
        <div className="seg" role="group" aria-label="Bedrooms">
          {BED_KEYS.map((b) => (
            <button key={b} aria-pressed={b === beds} onClick={() => onBeds(b)}>
              {BED_LABEL[b].replace(" bed", "")}
              <span className="seg-unit"> bed</span>
            </button>
          ))}
        </div>
        <button className="cvd" aria-pressed={cvd} onClick={onCvd} title="Switch to a colour-blind safe palette (viridis)">
          <span className="cvd-dot" style={{ background: cvd ? "#21918c" : "transparent" }} aria-hidden />
          Colour-blind safe
        </button>
      </div>
      <div className="legend">
        <div className="legend-title">
          Average monthly rent, {BED_LABEL[beds]} <span className="legend-sub">colour stops at the {percentiles.map((p) => `${p}th`).join(", ")} percentiles</span>
        </div>
        <div className="legend-bar" style={{ background: gradient }} />
        <div className="legend-ticks">
          {stops.map((v, i) => (
            <span key={i}>
              {i === 0 ? "≤" : i === stops.length - 1 ? "≥" : ""}
              {pounds(v)}
            </span>
          ))}
        </div>
        <div className="legend-nodata">
          <span className="sw" style={{ background: NO_DATA }} /> No data published
        </div>
      </div>
      <p className="attrib">
        Contains OS, Royal Mail &amp; ONS data © Crown copyright 2026 ·{" "}
        <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noreferrer">
          OGL v3.0
        </a>{" "}
        ·{" "}
        <button className="link" onClick={onAbout}>
          Sources
        </button>
      </p>
    </section>
  );
}
