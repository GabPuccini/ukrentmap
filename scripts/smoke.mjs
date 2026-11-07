// Drive the real built app in Chromium at phone width (390 x 844) and check
// that it works: map renders, legend has £ stops, search finds a postcode and
// opens its popup, bedroom selector and colour-blind toggle repaint, labels
// collide rather than overlap, no horizontal scroll, and it reloads offline.
//
//   npm run build:pages && npm test
//
// Needs Playwright:  npm i -D playwright && npx playwright install chromium
// Screenshots go to screenshots/.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 4173;
const SHOTS = new URL("../screenshots/", import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });

const server = spawn(process.execPath, [new URL("./serve-out.mjs", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve, reject) => {
  server.stdout.on("data", (b) => {
    const m = /(http:\/\/\S+)/.exec(String(b));
    if (m) resolve(m[1]);
  });
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const waitIdle = () =>
  page.evaluate(
    () =>
      new Promise((r) => {
        const m = window.__map;
        if (m.loaded() && !m.isMoving()) setTimeout(r, 300);
        m.once("idle", () => setTimeout(r, 300));
      }),
  );

try {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForSelector("html[data-ready='1']", { timeout: 60_000 });
  await waitIdle();
  check(true, "map loaded and rendered");

  const header = await page.textContent(".title p");
  check(/Sep 2026/.test(header ?? ""), `header shows data month: "${header}"`);

  const ticks = await page.$$eval(".legend-ticks span", (els) => els.map((e) => e.textContent));
  check(ticks.length === 5 && ticks.every((t) => /£\d/.test(t)), `legend £ stops: ${ticks.join(" | ")}`);

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  check(scrollW <= 390, `no horizontal scroll (scrollWidth ${scrollW})`);

  const fill = await page.evaluate(() => JSON.stringify(window.__map.getPaintProperty("district-fill", "fill-color")));
  check(fill.includes("r2") && fill.includes("#1a9641"), "2-bed green-to-red ramp painted");
  const tiles = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ["district-fill"] }).length);
  check(tiles > 500, `district polygons rendered (${tiles})`);
  await page.screenshot({ path: SHOTS + "phone-390-uk.png" });

  // Search for a full postcode: Buckingham Palace.
  await page.fill(".search input", "SW1A 1AA");
  await page.click(".search button");
  await page.waitForSelector(".rent-popup .pp-code", { timeout: 20_000 });
  await waitIdle();
  const pop = await page.textContent(".rent-popup");
  check(/SW1A/.test(pop) && /Westminster/.test(pop) && /£[\d,]+/.test(pop), "postcode search flies there and opens its popup");
  check(/1 bed.*2 bed.*3 bed.*4\+ bed/s.test(pop), "popup has 1/2/3/4+ bed breakdown");
  check(/Price Index of Private Rents, September 2026/.test(pop), "popup names source and month");
  await page.screenshot({ path: SHOTS + "phone-390-popup.png" });

  // Labels are collision-culled: at London zoom far fewer than exist are drawn, and none overlap.
  const labels = await page.evaluate(() => {
    const m = window.__map;
    const shown = m.queryRenderedFeatures({ layers: ["labels"] });
    const all = m.querySourceFeatures("labels").length;
    return { shown: shown.length, all, zoom: m.getZoom() };
  });
  check(labels.zoom >= 8 && labels.shown > 0 && labels.shown < labels.all, `labels culled (${labels.shown} drawn of ${labels.all} at z${labels.zoom.toFixed(1)})`);

  // Bedroom selector repaints and changes the legend.
  await page.click(".seg button:nth-child(3)");
  const ticks3 = await page.$$eval(".legend-ticks span", (els) => els.map((e) => e.textContent));
  const fill3 = await page.evaluate(() => JSON.stringify(window.__map.getPaintProperty("district-fill", "fill-color")));
  check(fill3.includes('"r3"') && ticks3.join() !== ticks.join(), `3-bed selected: ${ticks3.join(" | ")}`);
  const pop3 = await page.textContent(".rent-popup .pp-big");
  check(/3 bed/.test(pop3 ?? ""), "open popup follows the bedroom selector");

  // Colour-blind toggle.
  await page.click(".cvd");
  const fillCvd = await page.evaluate(() => JSON.stringify(window.__map.getPaintProperty("district-fill", "fill-color")));
  check(fillCvd.includes("#440154") && !fillCvd.includes("#1a9641"), "colour-blind toggle switches to viridis");
  await waitIdle();
  await page.screenshot({ path: SHOTS + "phone-390-viridis.png" });
  await page.click(".cvd");
  await page.click(".seg button:nth-child(2)");

  // District search and labels at city zoom.
  await page.fill(".search input", "M14");
  await page.click(".search button");
  await page.waitForFunction(() => document.querySelector(".rent-popup .pp-code")?.textContent === "M14", null, { timeout: 20_000 });
  await waitIdle();
  const popM = await page.textContent(".rent-popup");
  check(/Manchester/.test(popM) && /£1,239/.test(popM), "M14 shows Manchester 2-bed £1,239");
  await page.screenshot({ path: SHOTS + "phone-390-manchester.png" });

  // Who lives here: census ethnic groups for the district itself.
  await page.waitForSelector(".rent-popup .eth-bar", { timeout: 20_000 });
  const eth = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rent-popup .pp-eth > .eth-list tr")].map((r) => r.textContent);
    const total = rows.reduce((a, r) => a + parseFloat(r.match(/([\d.]+)%/)[1]), 0);
    return { rows, total, text: document.querySelector(".rent-popup .pp-eth").textContent };
  });
  check(eth.rows.length === 5 && Math.abs(eth.total - 100) < 1.5 && /Census 2021/.test(eth.text), `M14 ethnicity: ${eth.rows.join(" | ")}`);
  await page.click(".rent-popup .eth-more summary");
  await page.evaluate(() => {
    const c = document.querySelector(".rent-popup .pp");
    c.scrollTop = c.querySelector(".pp-eth").offsetTop - 8;
  });
  await page.screenshot({ path: SHOTS + "phone-390-ethnicity.png" });

  await page.fill(".search input", "EH1 1YZ");
  await page.click(".search button");
  await page.waitForFunction(() => document.querySelector(".rent-popup .pp-code")?.textContent === "EH1", null, { timeout: 20_000 });
  const popEH = await page.textContent(".rent-popup .pp-eth");
  check(/Scotland's Census 2022/.test(popEH) && /White/.test(popEH), "EH1 shows Scotland's Census 2022 figures");

  // Labels at city zoom, no popup: they fade in and are culled, never piled up.
  await page.click(".rent-popup .maplibregl-popup-close-button");
  await page.evaluate(() => window.__map.jumpTo({ center: [-0.12, 51.51], zoom: 10.2 }));
  await waitIdle();
  const london = await page.evaluate(() => {
    const m = window.__map;
    const boxes = m.queryRenderedFeatures({ layers: ["labels"] }).map((f) => {
      const p = m.project(f.geometry.coordinates);
      const w = String(f.properties.c).length * 7.5;
      return [p.x - w / 2, p.y - 7, p.x + w / 2, p.y + 7];
    });
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlaps++;
      }
    return { drawn: boxes.length, overlaps };
  });
  check(london.drawn > 10 && london.overlaps === 0, `London labels: ${london.drawn} drawn, ${london.overlaps} overlapping`);
  await page.screenshot({ path: SHOTS + "phone-390-london-labels.png" });

  // Northern Ireland: rent area by postcode district, no NI postcode data.
  await page.fill(".search input", "BT9 5AB");
  await page.click(".search button");
  await page.waitForFunction(() => /BT9/.test(document.querySelector(".rent-popup .pp-code")?.textContent ?? ""), null, { timeout: 20_000 });
  const popNI = await page.textContent(".rent-popup");
  check(/Belfast/.test(popNI) && /July 2026/.test(popNI), "BT postcode shows Belfast BRMA, July 2026");
  check(/Not available for Northern Ireland/.test(popNI), "NI popup explains there are no ethnicity figures");

  // Bad input.
  await page.fill(".search input", "ZZ99 9ZZ");
  await page.click(".search button");
  const msg = await page.textContent(".search-msg");
  check(/isn't|doesn't/.test(msg ?? ""), `unknown postcode explained: "${msg}"`);

  // Tap a district.
  await page.evaluate(() => window.__map.jumpTo({ center: [-3.179, 51.481], zoom: 12 }));
  await waitIdle();
  await page.touchscreen.tap(195, 430);
  await page.waitForSelector(".rent-popup .pp-code", { timeout: 10_000 });
  const tapped = await page.textContent(".rent-popup .pp-code");
  check(/^CF\d/.test(tapped ?? ""), `tap opens popup (${tapped})`);

  // Grey for no data: the City of London.
  await page.fill(".search input", "EC2V");
  await page.click(".search button");
  await page.waitForFunction(() => document.querySelector(".rent-popup .pp-code")?.textContent === "EC2V", null, { timeout: 20_000 });
  const popEC = await page.textContent(".rent-popup");
  check(/No data/.test(popEC) && /grey rather than guessed/.test(popEC), "City of London shows No data, grey");

  // Walking distance between two postcodes, worked out on the device.
  const walk = async (from, to) => {
    await page.fill(".walk input >> nth=0", from);
    await page.fill(".walk input >> nth=1", to);
    await page.click(".walk button");
    await page.waitForFunction(() => document.querySelector(".walk-result") || document.querySelector(".walk-msg:not(:empty)")?.textContent?.match(/can't|No |too far|no walk/i), null, { timeout: 90_000 });
    const text = (await page.textContent(".walk-result").catch(() => null)) ?? (await page.textContent(".walk-msg"));
    const km = parseFloat(/([\d.]+) km/.exec(text ?? "")?.[1] ?? (/(\d+) m \(/.exec(text ?? "") ? String(Number(/(\d+) m \(/.exec(text)[1]) / 1000) : "NaN"));
    return { text, km };
  };
  await page.click(".walk-btn");
  const w1 = await walk("SW1A 1AA", "SW1A 0AA");
  check(w1.km > 1.0 && w1.km < 2.6 && /min on foot/.test(w1.text), `walk Buckingham Palace -> Parliament: ${w1.text?.split("→")[0]}`);
  const route = await page.evaluate(async () => (await window.__map.getSource("walk").getData()).features);
  check(route.length === 3 && route[0].geometry.coordinates.length > 10, `route and A/B markers drawn (${route[0]?.geometry.coordinates.length} points)`);
  await waitIdle();
  await page.screenshot({ path: SHOTS + "phone-390-walk.png" });
  const w2 = await walk("M14 7EE", "M1 1AD");
  check(w2.km > 3 && w2.km < 7, `walk Fallowfield -> Manchester centre, across tiles: ${w2.text?.split("→")[0]}`);
  const w3 = await walk("M14 7EE", "BT9 5AB");
  check(/Northern Ireland/.test(w3.text ?? ""), `walk to a BT postcode explains NI: "${w3.text}"`);
  const w4 = await walk("M14 7EE", "EH1 1YZ");
  check(/too far/.test(w4.text ?? ""), "Manchester to Edinburgh is refused as too far to walk");
  await page.click(".walk-btn");
  const cleared = await page.evaluate(async () => (await window.__map.getSource("walk").getData()).features.length);
  check(cleared === 0 && !!(await page.$(".search")), "closing walk mode clears the route and brings search back");

  // Installability and offline.
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector("link[rel=manifest]").href)).json());
  check(manifest.display === "standalone" && manifest.icons.length >= 2, "manifest: standalone with icons");
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { active: !!reg.active, scope: reg.scope };
  });
  check(sw.active, `service worker active, scope ${sw.scope}`);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("html[data-ready='1']", { timeout: 60_000 });
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), "page controlled by the service worker");

  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("html[data-ready='1']", { timeout: 60_000 });
  await waitIdle();
  const offlineTiles = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ["district-fill"] }).length);
  check(offlineTiles > 500, `offline reload renders the map (${offlineTiles} districts)`);
  await page.fill(".search input", "SW1A 1AA");
  await page.click(".search button");
  await page.waitForSelector(".rent-popup .pp-code", { timeout: 20_000 });
  check(true, "offline search for a postcode used before works");
  await page.click(".walk-btn");
  const wOff = await walk("SW1A 1AA", "SW1A 0AA");
  check(Math.abs(wOff.km - w1.km) < 0.05, `offline walk on tiles used before: ${wOff.text?.split("→")[0]}`);
  await page.click(".walk-btn");
  await context.setOffline(false);

  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.slice(0, 3).join(" / ") : ""}`);

  // Updates: serve a copy of the build, "deploy" a new version into it, and
  // check the installed app offers it and switches to it.
  const copy = await mkdtemp(join(tmpdir(), "ukrentmap-update-"));
  await cp(new URL("../out/", import.meta.url).pathname, copy, { recursive: true });
  const server2 = spawn(process.execPath, [new URL("./serve-out.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PORT + 1), OUT_DIR: copy },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
  const url2 = base.replace(String(PORT), String(PORT + 1));
  const deploy = async (tag) => {
    const sw = join(copy, "sw.js");
    await writeFile(sw, (await readFile(sw, "utf8")).replace(/const VERSION = "([^"]+)"/, `const VERSION = "$1-${tag}"`));
  };
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const p2 = await ctx2.newPage();
    await p2.goto(url2);
    await p2.waitForSelector("html[data-ready='1']", { timeout: 60_000 });
    await p2.evaluate(() => navigator.serviceWorker.ready);
    await p2.reload();
    await p2.waitForSelector("html[data-ready='1']");

    await deploy("a");
    await p2.reload();
    await p2.waitForSelector("html[data-ready='1']");
    const toast = await p2.waitForSelector(".toast", { timeout: 30_000 }).then(() => true, () => false);
    check(toast, "after a deploy, reopening the app shows \"A new version is ready\"");
    if (toast) {
      await p2.click(".toast button");
      await p2.waitForSelector("html[data-ready='1']", { timeout: 30_000 });
      await p2.click("button[aria-label^=\"About\"]");
      const v = await p2.waitForFunction(() => /App version (\S+)\./.exec(document.querySelector(".sheet")?.textContent ?? "")?.[1], null, { timeout: 10_000 }).then((h) => h.jsonValue());
      check(/-a$/.test(v), `Reload switches to the new version (${v})`);

      await deploy("b");
      await p2.click(".check-updates");
      const toast2 = await p2.waitForSelector(".toast", { timeout: 30_000 }).then(() => true, () => false);
      const st = await p2.textContent(".update-status");
      check(toast2, `"Check for updates" finds a new version: "${st}"`);
      await p2.click(".sheet-close");
      await p2.click(".toast button");
      await p2.waitForSelector("html[data-ready='1']", { timeout: 30_000 });
      await p2.click("button[aria-label^=\"About\"]");
      await p2.click(".check-updates");
      await p2.waitForFunction(() => /latest/.test(document.querySelector(".update-status")?.textContent ?? ""), null, { timeout: 15_000 });
      check(true, '"Check for updates" says "You have the latest version" when it does');
    }
  } finally {
    await ctx2.close();
    server2.kill();
    await rm(copy, { recursive: true, force: true });
  }
} catch (e) {
  failures++;
  console.error("FAIL", e);
  await page.screenshot({ path: SHOTS + "failure.png" }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
