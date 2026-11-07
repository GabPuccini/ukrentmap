# UK Rent Map

Average private rent for every UK postcode district, as a colour-coded map: green cheapest, red most expensive. Tap a district for its
1/2/3/4+ bedroom rents, or search a postcode. Next.js + TypeScript + MapLibre GL JS, self-hosted PMTiles, installable as an offline PWA.

<img src="screenshots/phone-390-uk.png" width="300" alt="The map at 390px phone width"> <img src="screenshots/phone-390-manchester.png" width="300" alt="Popup for M14 in Manchester">

Live (once deployed): **https://gabpuccini.github.io/ukrentmap/**

```sh
npm install && npm run dev      # http://localhost:3000
```

The repository already contains the built data, so that is all you need. Python is only needed to refresh the data.

## What it shows

- Each postcode district (M14, SW1A, CF10…) is filled on a continuous green→yellow→red ramp by the **average monthly rent** of the area
  it belongs to, for the bedroom count you pick (1, 2, 3 or 4+; 2 by default).
- The colour stops sit at the **5th, 25th, 50th, 75th and 95th percentiles** of the district values for that bedroom count, so the
  ramp follows the real distribution and a handful of very expensive central London districts can't flatten the rest of the country.
  Values beyond the end stops take the end colour. The legend shows the real £ value at each stop.
- **Grey means no published figure.** It is never filled with a guess. That's the City of London and the Isles of Scilly (ONS publishes
  no rent for either) and Northern Ireland's shapes (see below).
- **Colour-blind safe** switches to viridis, which reads correctly for all common colour vision deficiencies. The choice is remembered.
- Labels: district codes fade in from zoom 8. MapLibre's collision detection drops any label that would overlap one already placed,
  and bigger districts are placed first.
- Popup: district code, area name (largest wards and council), the selected rent, a 1/2/3/4+ bed and all-homes breakdown, which rent
  area the figures belong to, any split across areas, and the source and month.
- Search: a full postcode (`SW1A 1AA`), a sector (`M14 5`) or a district (`CF10`). It flies there and opens the popup. Lookup runs
  on the device against the bundled postcode files. There is no geocoding service.
- Data month is in the header: **September 2026** for Great Britain, **July 2026** for Northern Ireland (the latest ONS has).

## Data sources

Everything is free and open. No API keys, no runtime calls to anyone else's servers.

| Data | Source | Edition used | Licence |
| --- | --- | --- | --- |
| Rents (mean monthly, by bedrooms) | [ONS Price Index of Private Rents, UK: monthly price statistics](https://www.ons.gov.uk/economy/inflationandpriceindices/datasets/priceindexofprivaterentsukmonthlypricestatistics) | Published 21 October 2026, data to September 2026 | OGL v3.0 |
| Postcode centroids + council and ward codes | [OS Code-Point Open](https://www.ordnancesurvey.co.uk/products/code-point-open) | November 2026 (Royal Mail update 16 Oct 2026) | OGL v3.0 |
| Scottish Broad Rental Market Areas | [Scottish Government spatial data](https://www.spatialdata.gov.scot/geonetwork/srv/eng/catalog.search#/metadata/ecf60902-9e71-41bc-b822-6a1f37934dc1) | SG_BroadRentalMarketAreas_2009 | OGL v3.0 |
| Coastline (for clipping) | [ONS Countries (December 2025) Boundaries UK BGC](https://geoportal.statistics.gov.uk/) | Dec 2025 | OGL v3.0 |
| Council and ward names | ONS Local Authority Districts (May 2026), Wards (May 2026) | May 2026 | OGL v3.0 |
| NI rent areas by postcode district | Northern Ireland Housing Executive, as compiled in [nick-bailey/Postcode-to-BRMA-lookup](https://github.com/nick-bailey/Postcode-to-BRMA-lookup) (OGL) | May 2024 | OGL v3.0 |
| Map fonts | Noto Sans glyphs from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) | | SIL OFL 1.1 |

Required attribution (shown in the app's key and in its About sheet):

> Contains OS data © Crown copyright and database right 2026. Contains Royal Mail data © Royal Mail copyright and database right 2026.
> Contains National Statistics data © Crown copyright and database right 2026. Source: Office for National Statistics licensed under the
> Open Government Licence v3.0. Contains public sector information from the Scottish Government licensed under the Open Government Licence v3.0.

### Why these sources, and what they can't do

- **There is no free official rent data at postcode level.** I looked for a free postcode-sector rent dataset and found none: VOA
  publishes nothing below local authority, and the property-portal data is commercial.
- **ONS/VOA Private Rental Market Statistics (PRMS) is discontinued.** Its last edition covered October 2022 to September 2023. ONS
  replaced it with the **Price Index of Private Rents (PIPR)**, which is monthly, current, covers the whole UK and splits by bedrooms.
  PIPR publishes an **average (mean)**, not a median. It reports local authorities in England and Wales and Broad Rental Market Areas
  (BRMAs, 18 of them) in Scotland and Northern Ireland. It already covers Wales and Scotland, so separate Welsh or Scottish Government
  rent statistics aren't needed (I couldn't find a recent Welsh Government private-rent release anyway).
- **A district inherits its area's rent.** A district takes the rent area (council, or Scottish BRMA) holding most of its live
  postcodes. All districts in an area therefore show the same figure. Where a district straddles a boundary the popup shows the split,
  e.g. TD15: Northumberland 94%, Scottish Borders 6%.
- **District shapes are derived, not official.** Royal Mail's boundaries aren't open data, and ONS publishes no postcode district
  polygons. The shapes are a Voronoi diagram of all 1,748,497 live Code-Point Open postcode centroids: each point owns the land nearer to
  it than to any other postcode. Only the Voronoi edges between postcodes of *different* districts are kept and polygonised, then clipped
  to the ONS coastline. They are close in built-up areas and approximate across empty moorland. 18 tiny districts, mostly PO box and
  large-user codes such as DH98, sit exactly on top of other postcodes and get no shape of their own; they still work in search.
- **Northern Ireland.** Code-Point Open covers Great Britain only. NI postcode locations exist in the ONS Postcode Directory, but under a
  Land & Property Services *End User Licence* that allows "internal business use only… all other uses are prohibited". Publishing them,
  or shapes derived from them, on a public site would break it, so this app doesn't use them at all. Instead, NIHE defines each NI rent
  area as a list of postcode districts, so a BT search shows the right area's ONS rents. NI is drawn as one grey area; tap it for all
  eight areas. ONS's latest NI month is July 2026; ONS estimates the two newer months, and those are not shown.
- PIPR is an average across new **and** existing tenancies, so it runs below advertised asking rents. Scottish figures are mainly for
  advertised new lets (an ONS note).

## Refreshing the data

ONS publishes PIPR monthly (next release 18 November 2026) and OS refreshes Code-Point Open quarterly.

```sh
# one-off setup: Python 3.11+ and tippecanoe
pip install -r scripts/requirements.txt
sudo apt-get install tippecanoe          # macOS: brew install tippecanoe

npm run data      # download everything into data-raw/, then rebuild public/data/ (about 2 minutes)
npm run build     # check it builds
git add public/data && git commit -m "Refresh data to <month>" && git push
```

`npm run data` is two steps you can run separately:

- `npm run data:fetch` (`scripts/fetch_data.py`): finds the newest PIPR spreadsheet on the ONS dataset page, gets the current Code-Point
  Open from the OS Downloads API (checksum verified), and pulls boundaries and names from the ONS Open Geography portal. It writes
  `data-raw/sources.json` recording what was fetched and when.
- `npm run data:build` (`scripts/build_data.py`): builds `districts.pmtiles` (with tippecanoe), `districts.json`, `labels.geojson`,
  `ni.geojson`, `meta.json` (data months, percentile stops, sources) and `pc/*.txt` (postcode search files), all in `public/data/`.

If ONS changes the spreadsheet layout or a geography service is renamed, the scripts stop with an error rather than producing a
partial map. The service names are constants at the top of `fetch_data.py`.

## Deploying (GitHub Pages)

The workflow in `.github/workflows/pages.yml` builds the site and publishes it on every push to `main`.

One-time setup, already done: repository public, **Settings → Pages → Build and deployment → Source: GitHub Actions**.

To deploy, merge the work branch into `main`: open a pull request from `ccr-1b9a9d2f-atr7m1` on GitHub and press **Merge**, or from a terminal:

```sh
git fetch origin
git checkout main
git merge origin/ccr-1b9a9d2f-atr7m1
git push origin main
```

Then watch **Actions → Deploy to GitHub Pages**. When it's green the app is at https://gabpuccini.github.io/ukrentmap/. To redeploy
without a change: **Actions → Deploy to GitHub Pages → Run workflow**.

To check a Pages build locally first:

```sh
npm run build:pages && npm run preview      # http://localhost:4173/ukrentmap/
```

### Install it on your phone

Same as Phthalo. Open https://gabpuccini.github.io/ukrentmap/ once and let it finish loading (that fills the offline cache: about
13 MB). Then:

- **iPhone (Safari):** Share → **Add to Home Screen** → Add.
- **Android (Chrome):** ⋮ → **Install app** (or Add to Home screen).

It opens full screen without browser bars and works in flight mode. Postcode files (21 MB in all) are cached per postcode area the
first time you search one, so offline search works for areas you've searched before; district search always works offline. After a
deploy, the app shows **"A new version is ready"** with a Reload button the next time it's opened.

## Privacy

- No accounts, no cookies, no analytics, no third-party requests: tiles, fonts and data all come from the site itself.
- Searches never leave the phone.
- `noindex` and `robots.txt` keep the site out of search engines.
- The URL is public, like Phthalo's: anyone who has it can open the map, which only shows public government data. If you ever want it
  locked to you alone, it would need a host with a login in front (e.g. Cloudflare Pages + Cloudflare Access, free for personal use).

## Testing

```sh
npm run typecheck
npm i -D playwright && npx playwright install chromium     # once
npm run build:pages && npm test
```

`npm test` (`scripts/smoke.mjs`) drives the built app in Chromium at **390 × 844** (iPhone size) and checks:
- the map renders, the header shows the data month, the legend has £ stops, and there's no horizontal scroll
- search: a postcode opens the right popup with the 1/2/3/4+ breakdown and source; district, NI and unknown postcodes are handled
- the bedroom selector and colour-blind toggle repaint the map and the open popup
- tapping a district opens its popup
- London labels are culled with **zero overlaps**
- the City of London shows "No data" in grey
- the manifest is installable and the service worker takes control
- the map reloads and searches **offline**
- there are no console errors

It saves screenshots to `screenshots/`.

## How it's built

```
app/                  Next.js App Router shell (static export, one page)
components/
  RentMap.tsx         MapLibre map, style, popups, hover, search wiring
  Controls.tsx        bedroom selector, colour-blind toggle, legend, attribution
  SearchBox.tsx  About.tsx  UpdateToast.tsx
lib/
  colors.ts           ramps and the percentile-stop fill expression
  search.ts           on-device postcode parsing and lookup
  popup.ts            popup content (built with DOM calls, never HTML strings)
public/
  data/               built data (committed): districts.pmtiles, districts.json, labels.geojson, ni.geojson, meta.json, pc/*.txt
  fonts/              glyphs for map labels
  icons/              app icons (scripts/make_icons.py)
  sw.js               service worker (stamped with a content hash at build)
  manifest.webmanifest  robots.txt
scripts/
  fetch_data.py  build_data.py  ni_outcode_brma.csv  requirements.txt
  postbuild.mjs       writes the precache list and version into out/sw.js
  copy-vendor.mjs     copies MapLibre's worker into public/vendor/ (MapLibre 6 needs setWorkerUrl under a bundler)
  serve-out.mjs       local static server with byte ranges, for preview and tests
  smoke.mjs           the phone-width browser test
```

- **Tiles.** `districts.pmtiles` is a single 9 MB file of vector tiles (zoom 4–12) made by tippecanoe with shared-border simplification,
  read through HTTP range requests by the `pmtiles` library. There's no tile server and no basemap: sea, district fills, borders and
  labels are the whole map.
- **Offline.** The service worker caches the app, fonts, tiles and district data on first load. It answers range requests for the
  tiles by slicing its cached copy. Its version is a hash of everything it caches, so any change to code or data makes a new version
  automatically.
- **Base path.** Locally the app is served from `/`; on Pages from `/ukrentmap/` (`NEXT_PUBLIC_BASE_PATH`, set by `build:pages` and
  the workflow).
