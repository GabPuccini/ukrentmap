"use client";

import type { GeoJSONSource, LngLatBoundsLike, Map as MLMap, Popup, StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { fillColor, NO_DATA } from "@/lib/colors";
import { BASE, LABEL_ZOOM, MAX_BOUNDS, MAX_ZOOM, MIN_ZOOM, UK_BOUNDS, asset } from "@/lib/config";
import { monthName, pounds } from "@/lib/format";
import { districtPopup, niPopup } from "@/lib/popup";
import { resolve } from "@/lib/search";
import { BED_LABEL, RENT_INDEX, type Beds, type DistrictData, type EthnicityData, type Meta } from "@/lib/types";
import About from "./About";
import Controls from "./Controls";
import SearchBox from "./SearchBox";
import UpdateToast from "./UpdateToast";
import WalkPanel from "./WalkPanel";
import type { WalkRoute } from "@/lib/walk/router";

declare global {
  interface Window {
    __map?: MLMap;
  }
}

const PREF_CVD = "ukrentmap.cvd";
const PREF_BEDS = "ukrentmap.beds";

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or storage blocked: the preference just isn't remembered */
  }
}

function buildStyle(meta: Meta, beds: Beds, cvd: boolean): StyleSpecification {
  return {
    version: 8,
    glyphs: asset("/fonts/{fontstack}/{range}.pbf"),
    sources: {
      districts: { type: "vector", url: "pmtiles://" + asset("/data/districts.pmtiles") },
      labels: { type: "geojson", data: asset("/data/labels.geojson") },
      ni: { type: "geojson", data: asset("/data/ni.geojson") },
      // One point for the NI label: a polygon label would repeat in every tile.
      "ni-point": { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-6.72, 54.6] } } },
      walk: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": "#d4e3ea" } },
      { id: "ni-fill", type: "fill", source: "ni", paint: { "fill-color": NO_DATA } },
      { id: "ni-line", type: "line", source: "ni", paint: { "line-color": "#6f7a80", "line-width": 0.6 } },
      {
        id: "district-fill",
        type: "fill",
        source: "districts",
        "source-layer": "districts",
        paint: { "fill-color": fillColor(beds, meta.scale[beds], cvd) },
      },
      {
        id: "district-line",
        type: "line",
        source: "districts",
        "source-layer": "districts",
        paint: {
          "line-color": "rgba(30,30,30,0.32)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.1, 8, 0.35, 11, 0.8, 13, 1.3],
        },
      },
      {
        id: "district-hover",
        type: "line",
        source: "districts",
        "source-layer": "districts",
        filter: ["==", ["get", "c"], ""],
        paint: { "line-color": "#111", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.4, 12, 3] },
      },
      {
        id: "ni-label",
        type: "symbol",
        source: "ni-point",
        maxzoom: 9,
        layout: {
          "text-field": "Northern Ireland\ntap for rents",
          "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 8, 13],
        },
        paint: { "text-color": "#333", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1.2 },
      },
      {
        id: "labels",
        type: "symbol",
        source: "labels",
        minzoom: LABEL_ZOOM,
        layout: {
          "text-field": ["get", "c"],
          "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], LABEL_ZOOM, 10, 12, 14],
          // Bigger districts claim their space first; anything that would
          // collide with a label already placed is dropped, never overlapped.
          "symbol-sort-key": ["*", -1, ["get", "k"]],
          "text-padding": 4,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#161616",
          "text-halo-color": "rgba(255,255,255,0.92)",
          "text-halo-width": 1.4,
          "text-opacity": ["interpolate", ["linear"], ["zoom"], LABEL_ZOOM, 0, LABEL_ZOOM + 1, 1],
        },
      },
      // Walking route: a dark line with a white casing reads on every rent colour.
      {
        id: "walk-casing",
        type: "line",
        source: "walk",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 14, 9] },
      },
      {
        id: "walk-line",
        type: "line",
        source: "walk",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#1b1464", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 5] },
      },
      {
        id: "walk-ends",
        type: "circle",
        source: "walk",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 9, "circle-color": "#1b1464", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      },
      {
        id: "walk-ends-label",
        type: "symbol",
        source: "walk",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 11,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      },
    ],
  };
}

/**
 * Where a popup should sit. On a phone the header and the key cover the top
 * and bottom of the map, so the point is moved to just above the key and the
 * popup opens upwards into the space below the header.
 */
function popupLayout(map: MLMap): { narrow: boolean; offsetY: number; maxHeight: number } {
  const box = map.getContainer().getBoundingClientRect();
  const narrow = box.width < 720;
  const headerBottom = document.querySelector(".top")?.getBoundingClientRect().bottom ?? box.top;
  const panelTop = document.querySelector(".panel")?.getBoundingClientRect().top ?? box.bottom;
  const targetY = panelTop - 14 - box.top;
  return {
    narrow,
    offsetY: narrow ? targetY - box.height / 2 : 0,
    maxHeight: narrow ? Math.max(170, targetY - (headerBottom - box.top) - 28) : 460,
  };
}

export default function RentMap() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const mlRef = useRef<typeof import("maplibre-gl") | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<DistrictData | null>(null);
  /** census ethnicity: null while loading, false if it failed */
  const [eth, setEth] = useState<EthnicityData | null | false>(null);
  const [beds, setBeds] = useState<Beds>("r2");
  const [cvd, setCvd] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [walkOpen, setWalkOpen] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const state = useRef({ beds, cvd, meta, data, eth });
  state.current = { beds, cvd, meta, data, eth };
  const niBounds = useRef<LngLatBoundsLike | null>(null);
  /** what the open popup shows, so it can be redrawn when the bedroom count or colours change */
  const popupContent = useRef<{ kind: "d"; code: string } | { kind: "ni"; district: string | null; label: string | null } | null>(null);

  // Preferences.
  useEffect(() => {
    if (readPref(PREF_CVD) === "1") setCvd(true);
    const b = readPref(PREF_BEDS);
    if (b === "r1" || b === "r2" || b === "r3" || b === "r4") setBeds(b);
  }, []);

  // Data.
  useEffect(() => {
    Promise.all([
      fetch(`${BASE}/data/meta.json`).then((r) => r.json() as Promise<Meta>),
      fetch(`${BASE}/data/districts.json`).then((r) => r.json() as Promise<DistrictData>),
    ])
      .then(([m, d]) => {
        setMeta(m);
        setData(d);
      })
      .catch(() => setFailed("Couldn't load the map data. Check your connection and reload."));
    // Census figures are only needed for popups, so they load in the background.
    fetch(`${BASE}/data/ethnicity.json`)
      .then((r) => (r.ok ? (r.json() as Promise<EthnicityData>) : Promise.reject(r.status)))
      .then(setEth)
      .catch(() => setEth(false));
  }, []);

  const closePopup = useCallback(() => {
    popupRef.current?.remove();
    popupRef.current = null;
    popupContent.current = null;
    mapRef.current?.setFilter("district-hover", ["==", ["get", "c"], ""]);
  }, []);

  const renderPopupContent = useCallback((): HTMLElement | null => {
    const { meta: m, data: d, beds: b, cvd: c, eth: e } = state.current;
    const pc = popupContent.current;
    if (!m || !d || !pc) return null;
    return pc.kind === "d" ? districtPopup(pc.code, d, m, b, c, e) : niPopup(pc.district, pc.label, d, m, b, c);
  }, []);

  const showPopup = useCallback(
    (lngLat: [number, number], content: NonNullable<typeof popupContent.current>, pan = false) => {
      const map = mapRef.current;
      const ml = mlRef.current;
      if (!map || !ml) return;
      popupRef.current?.remove();
      popupContent.current = content;
      const layout = popupLayout(map);
      if (pan && layout.narrow) {
        map.easeTo({ center: lngLat, offset: [0, layout.offsetY], duration: 350 });
        map.once("moveend", () => {
          if (popupContent.current === content) showPopup(lngLat, content, false);
        });
        map.setFilter("district-hover", ["==", ["get", "c"], content.kind === "d" ? content.code : ""]);
        return;
      }
      const body = renderPopupContent();
      if (!body) return;
      const popup = new ml.Popup({
        maxWidth: "300px",
        focusAfterOpen: false,
        className: "rent-popup",
        anchor: layout.narrow ? "bottom" : undefined,
      })
        .setLngLat(lngLat)
        .setDOMContent(body)
        .addTo(map);
      popup.getElement().style.setProperty("--pp-max", `${layout.maxHeight}px`);
      popup.on("close", () => {
        if (popupRef.current === popup) {
          popupRef.current = null;
          popupContent.current = null;
          map.setFilter("district-hover", ["==", ["get", "c"], ""]);
        }
      });
      popupRef.current = popup;
      map.setFilter("district-hover", ["==", ["get", "c"], content.kind === "d" ? content.code : ""]);
    },
    [renderPopupContent],
  );

  // Map.
  useEffect(() => {
    if (!meta || !data || !container.current || mapRef.current) return;
    let cancelled = false;
    (async () => {
      const ml = await import("maplibre-gl");
      const { Protocol } = await import("pmtiles");
      if (cancelled || !container.current) return;
      mlRef.current = ml;
      ml.setWorkerUrl(asset("/vendor/maplibre-gl-worker.mjs"));
      const protocol = new Protocol();
      ml.addProtocol("pmtiles", protocol.tile);

      const { beds: b, cvd: c } = state.current;
      const map = new ml.Map({
        container: container.current,
        style: buildStyle(meta, b, c),
        bounds: UK_BOUNDS,
        fitBoundsOptions: { padding: { top: 130, bottom: 210, left: 12, right: 12 } },
        maxBounds: MAX_BOUNDS,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        renderWorldCopies: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: false,
        cooperativeGestures: false,
      });
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;
      window.__map = map;

      map.on("load", () => {
        const ni = (map.getSource("ni") as GeoJSONSource | undefined);
        ni?.getData().then((gj) => {
          const b = new ml.LngLatBounds();
          const walk = (c: unknown): void => {
            if (Array.isArray(c) && typeof c[0] === "number") b.extend(c as [number, number]);
            else if (Array.isArray(c)) c.forEach(walk);
          };
          for (const f of (gj as GeoJSON.FeatureCollection).features) walk((f.geometry as GeoJSON.Polygon).coordinates);
          niBounds.current = b;
        });
        map.once("idle", () => {
          setReady(true);
          document.documentElement.dataset.ready = "1";
        });
      });
      map.on("error", (e) => console.warn("map:", e.error?.message ?? e));

      map.on("click", (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["district-fill", "ni-fill"] })[0];
        if (!hit) return closePopup();
        if (hit.layer.id === "ni-fill") return showPopup([e.lngLat.lng, e.lngLat.lat], { kind: "ni", district: null, label: null }, true);
        showPopup([e.lngLat.lng, e.lngLat.lat], { kind: "d", code: String(hit.properties.c) }, true);
      });

      // Hover, for mouse and pen. Touch uses tap.
      const hover = window.matchMedia("(hover: hover)").matches;
      if (hover) {
        map.on("mousemove", "district-fill", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const code = String(f.properties.c);
          const { beds: bb, data: dd } = state.current;
          const d = dd?.d[code];
          const area = d ? dd?.a[d.ra] : undefined;
          const v = area?.r[RENT_INDEX[bb]] ?? null;
          map.getCanvas().style.cursor = "pointer";
          if (!popupRef.current) map.setFilter("district-hover", ["==", ["get", "c"], code]);
          setTip({ x: e.point.x, y: e.point.y, text: `${code}${d?.w[0] ? " · " + d.w[0] : ""} · ${v == null ? "no data" : pounds(v)} ${BED_LABEL[bb]}` });
        });
        map.on("mouseleave", "district-fill", () => {
          map.getCanvas().style.cursor = "";
          if (!popupRef.current) map.setFilter("district-hover", ["==", ["get", "c"], ""]);
          setTip(null);
        });
      }
    })().catch((e) => {
      console.error(e);
      setFailed("The map couldn't start on this device (it needs WebGL).");
    });
    return () => {
      cancelled = true;
    };
  }, [meta, data, closePopup, showPopup]);

  // Bedroom count and colour ramp.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !meta || !map.getLayer("district-fill")) return;
    map.setPaintProperty("district-fill", "fill-color", fillColor(beds, meta.scale[beds], cvd));
    if (popupRef.current) {
      const body = renderPopupContent();
      if (body) popupRef.current.setDOMContent(body);
    }
  }, [beds, cvd, eth, meta, ready, renderPopupContent]);

  const chooseBeds = (b: Beds) => {
    setBeds(b);
    writePref(PREF_BEDS, b);
  };
  const toggleCvd = () => {
    setCvd((v) => {
      writePref(PREF_CVD, v ? "0" : "1");
      return !v;
    });
  };

  const search = useCallback(
    async (q: string): Promise<string | null> => {
      const map = mapRef.current;
      const d = state.current.data;
      if (!map || !d) return "The map is still loading.";
      const hit = await resolve(q, d);
      if (hit.kind === "error") return hit.message;
      closePopup();
      const { offsetY } = popupLayout(map);
      const go = (center: [number, number], zoom: number, content: NonNullable<typeof popupContent.current>) => {
        map.flyTo({ center, zoom, offset: [0, offsetY], duration: 1600 });
        map.once("moveend", () => showPopup(center, content));
      };
      if (hit.kind === "ni") {
        go([-6.72, 54.6], 6.6, { kind: "ni", district: hit.district, label: hit.label });
        return null;
      }
      const info = d.d[hit.district];
      if (hit.kind === "district") {
        const cam = info.b ? map.cameraForBounds([[info.b[0], info.b[1]], [info.b[2], info.b[3]]], { padding: 30 }) : null;
        go(info.p, Math.min(11, Math.max(8.5, (cam?.zoom ?? 12) - 0.6)), { kind: "d", code: hit.district });
        return null;
      }
      go(hit.lngLat, Math.max(map.getZoom(), hit.kind === "postcode" ? 13 : 12), { kind: "d", code: hit.district });
      return null;
    },
    [closePopup, showPopup],
  );

  const showRoute = useCallback(
    (route: WalkRoute, from: string, to: string) => {
      const map = mapRef.current;
      const ml = mlRef.current;
      if (!map || !ml) return;
      closePopup();
      const end = (at: [number, number], label: string, name: string): GeoJSON.Feature => ({
        type: "Feature",
        properties: { label, name },
        geometry: { type: "Point", coordinates: at },
      });
      (map.getSource("walk") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.coords } },
          end(route.coords[0], "A", from),
          end(route.coords[route.coords.length - 1], "B", to),
        ],
      });
      const bounds = new ml.LngLatBounds();
      route.coords.forEach((c) => bounds.extend(c));
      const box = map.getContainer().getBoundingClientRect();
      const top = (document.querySelector(".top")?.getBoundingClientRect().bottom ?? 0) - box.top + 20;
      const bottom = box.bottom - (document.querySelector(".panel")?.getBoundingClientRect().top ?? box.bottom) + 20;
      map.fitBounds(bounds, { padding: { top, bottom, left: 30, right: 30 }, maxZoom: 16, duration: 900 });
    },
    [closePopup],
  );

  const toggleWalk = () => {
    if (walkOpen) {
      (mapRef.current?.getSource("walk") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
    }
    setWalkOpen(!walkOpen);
  };

  const scale = meta?.scale[beds];

  return (
    <main className="app">
      <div ref={container} className="map" aria-label="Map of average private rents by postcode district" />
      <header className="top">
        <div className="title">
          <h1>UK Rent Map</h1>
          <p>
            Private rents{meta ? ` · ${monthName(meta.rentMonth, true)}` : ""}
            {meta?.rentMonthNI && meta.rentMonthNI !== meta.rentMonth ? ` (NI ${monthName(meta.rentMonthNI, true)})` : ""}
          </p>
        </div>
        <div className="top-buttons">
          <button
            className="icon-btn walk-btn"
            onClick={toggleWalk}
            aria-pressed={walkOpen}
            aria-label={walkOpen ? "Close walking distance" : "Walking distance between two postcodes"}
            title="Walking distance"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <circle cx="13.5" cy="3.8" r="2.1" fill="currentColor" />
              <path
                d="M10.6 21.2l1.6-6.1 2.7 2.6v3.5M12.2 15.1l.9-5.3M13.1 9.8l-2.9 1.6-1.1 3.1M13.1 9.8l1.6 2.6 3 .9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button className="icon-btn" onClick={() => setAboutOpen(true)} aria-label="About this map, sources and licences">
            i
          </button>
        </div>
        {walkOpen ? <WalkPanel data={data} onRoute={showRoute} /> : <SearchBox onSearch={search} disabled={!ready} />}
      </header>
      {scale && <Controls beds={beds} onBeds={chooseBeds} cvd={cvd} onCvd={toggleCvd} stops={scale} percentiles={meta!.percentiles} onAbout={() => setAboutOpen(true)} />}
      {tip && (
        <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.text}
        </div>
      )}
      {!ready && !failed && <div className="loading">Loading map…</div>}
      {failed && <div className="loading error">{failed}</div>}
      {aboutOpen && meta && <About meta={meta} onClose={() => setAboutOpen(false)} />}
      <UpdateToast />
    </main>
  );
}
