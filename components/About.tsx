"use client";

import { useEffect, useState } from "react";
import { monthName } from "@/lib/format";
import type { Meta } from "@/lib/types";

/** Sources, licences, method and caveats. */
export default function About({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Ask the service worker which version is running.
  useEffect(() => {
    const controller = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
    if (!controller) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => setVersion(String(e.data));
    controller.postMessage("version", [channel.port2]);
  }, []);

  async function checkForUpdates() {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (!reg) return setStatus("The offline copy isn't installed in this browser, so there's nothing to update.");
    setStatus("Checking…");
    try {
      await reg.update();
    } catch {
      return setStatus("Couldn't check. Are you offline?");
    }
    if (reg.installing) setStatus("A new version is downloading. You'll be asked to reload when it's ready.");
    else if (reg.waiting) setStatus("A new version is ready: tap Reload at the top of the screen.");
    else setStatus("You have the latest version.");
  }

  const built = meta.built.slice(0, 10);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="About this map" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2>About this map</h2>
        <p>
          Each postcode district is coloured by the average monthly private rent of the area it sits in, green cheapest and red most
          expensive. Rents are for <b>{monthName(meta.rentMonth)}</b> in England, Wales and Scotland
          {meta.rentMonthNI ? (
            <>
              {" "}
              and <b>{monthName(meta.rentMonthNI)}</b> in Northern Ireland
            </>
          ) : null}
          , from the ONS release of {meta.piprPublished}.
        </p>

        <h3>Where the numbers come from</h3>
        <ul>
          <li>
            <b>Rents:</b> ONS Price Index of Private Rents (PIPR), the successor to the discontinued Private Rental Market Statistics. It is
            an <b>average (mean)</b> across new and existing tenancies, not a median. ONS publishes it for local authorities in England and
            Wales and for Broad Rental Market Areas in Scotland and Northern Ireland. There is no free official rent data for areas smaller
            than these.
          </li>
          <li>
            <b>Districts:</b> each district takes the rent area holding most of its postcodes, so every district in Manchester shows
            Manchester&apos;s figure. A district that crosses a boundary says so in its popup.
          </li>
          <li>
            <b>Grey:</b> no published figure (the City of London and the Isles of Scilly). Shown grey rather than guessed.
          </li>
          <li>
            <b>Colours:</b> stops sit at the {meta.percentiles.map((p) => `${p}th`).join(", ")} percentiles of the district values, so a few
            very expensive areas don&apos;t flatten everything else.
          </li>
        </ul>

        <h3>Who lives here</h3>
        <p>
          Each district&apos;s popup shows the ethnic groups of its residents. They come from the census for England and Wales (2021,
          ONS) and Scotland (2022, National Records of Scotland). The census publishes counts for small areas of about 125 households.
          Each small area is shared between postcode districts by how many of its home postcodes fall in each, then added up per
          district. Districts with fewer than 100 residents show no percentages. There are no figures for Northern Ireland, because its
          postcode data isn&apos;t open.
        </p>

        <h3>Walking distance</h3>
        <p>
          The walking-person button finds the shortest walking route between two postcodes, on streets, footpaths, parks, towpaths and
          footbridges from OpenStreetMap. Motorways and private ways are left out. The route is worked out on your phone, from map
          tiles fetched from this site only for the area the route needs; nothing about your search is sent anywhere. Times assume 3 mph
          (4.8 km/h). Northern Ireland postcodes can&apos;t be used, because their positions aren&apos;t open data.
        </p>

        <h3>District shapes</h3>
        <p>
          Royal Mail&apos;s district boundaries aren&apos;t open data. These shapes are a Voronoi diagram of all{" "}
          {meta.counts.postcodes.toLocaleString("en-GB")} live postcode centroids in OS Code-Point Open, merged by district and clipped to the
          ONS coastline. They are close in towns and approximate in empty country.
        </p>

        <h3>Northern Ireland</h3>
        <p>
          NI postcode positions are licensed by Land &amp; Property Services for internal business use only, so they can&apos;t be
          published on a public site. NI is drawn as one grey area. Tap it, or search a BT postcode, to see the ONS rent for its area. NIHE
          defines those areas by postcode district.
        </p>

        <h3>Privacy</h3>
        <p>
          No accounts, cookies, analytics or tracking. Everything, including postcode search, runs on your device from files bundled with
          the app. It works offline once loaded.
        </p>

        <h3>Sources and licences</h3>
        <ul className="sources">
          {meta.sources.map((s) => (
            <li key={s.name}>
              <a href={s.page} target="_blank" rel="noreferrer">
                {s.name}
              </a>
              {s.edition ? `, edition ${s.edition}` : ""}
            </li>
          ))}
          <li>
            <a href="https://www.ons.gov.uk/datasets/TS021" target="_blank" rel="noreferrer">
              ONS Census 2021, TS021 Ethnic group
            </a>
            , England and Wales
          </li>
          <li>
            <a href="https://www.scotlandscensus.gov.uk/documents/2022-output-area-data/" target="_blank" rel="noreferrer">
              Scotland&apos;s Census 2022, UV201 Ethnic group
            </a>
            , National Records of Scotland
          </li>
          <li>
            Walking paths:{" "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              © OpenStreetMap contributors
            </a>
            , Open Database Licence (UK extract from openstreetmap.fr)
          </li>
          <li>Northern Ireland BRMA postcode districts: Northern Ireland Housing Executive</li>
          <li>Map fonts: Noto Sans, SIL Open Font License</li>
        </ul>
        <p className="small">
          Contains OS data © Crown copyright and database right 2026. Contains Royal Mail data © Royal Mail copyright and database right
          2026. Contains National Statistics data © Crown copyright and database right 2026. Source: Office for National Statistics
          licensed under the{" "}
          <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noreferrer">
            Open Government Licence v3.0
          </a>
          . Contains public sector information from the Scottish Government and National Records of Scotland (Scotland&apos;s
          Census 2022) licensed under the Open Government Licence v3.0.
        </p>
        <p className="small">
          Data built {built}. Downloaded {meta.fetched.slice(0, 10)}.{version ? ` App version ${version}.` : ""}{" "}
          <button className="link check-updates" onClick={checkForUpdates}>
            Check for updates
          </button>
        </p>
        {status && (
          <p className="small update-status" role="status">
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
