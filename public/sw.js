/* UK Rent Map service worker.
 *
 * The app shell, map tiles, fonts and district data are cached on install,
 * so the app opens and works offline from the home screen. Postcode search
 * files and walking-route tiles are cached the first time each one is used.
 *
 * scripts/postbuild.mjs replaces the two placeholders below at build time:
 * VERSION is a hash of every cached file, so any change to the app or data
 * produces a new worker, and the app offers a reload.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;

const CORE = `core-${VERSION}`;
// Postcode files and walking tiles: cached the first time each is used.
const ONDEMAND = `ondemand-${VERSION}`;
const scope = new URL(self.registration.scope);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CORE).then((cache) => cache.addAll(PRECACHE)));
  // A first install takes control at once; an update waits to be asked.
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
  // The About sheet asks which version is running.
  if (event.data === "version") event.ports[0]?.postMessage(VERSION);
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CORE && key !== ONDEMAND) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// The PMTiles file is read with HTTP range requests. Serve them by slicing the
// cached copy, which is kept in memory once read.
let tilesBuffer = null;
async function rangeFromCache(request) {
  const cache = await caches.open(CORE);
  const cached = await cache.match(request.url, { ignoreSearch: true });
  if (!cached) return fetch(request);
  if (!tilesBuffer || tilesBuffer.url !== request.url) {
    tilesBuffer = { url: request.url, buf: await cached.arrayBuffer(), etag: cached.headers.get("ETag") };
  }
  const { buf, etag } = tilesBuffer;
  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") || "");
  if (!m) return new Response(buf, { headers: { "Content-Type": "application/octet-stream" } });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (start >= buf.byteLength) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.byteLength}` } });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
  };
  if (etag) headers.ETag = etag;
  return new Response(buf.slice(start, end + 1), { status: 206, headers });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.status === 200) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (request.headers.has("range")) {
    event.respondWith(rangeFromCache(request));
  } else if (request.mode === "navigate") {
    // One page app: always answer navigations with the cached shell.
    event.respondWith(
      caches.open(CORE).then((c) => c.match(scope.href).then((hit) => hit || fetch(request))),
    );
  } else if (url.pathname.startsWith(scope.pathname + "data/pc/") || url.pathname.startsWith(scope.pathname + "data/walk/")) {
    event.respondWith(cacheFirst(request, ONDEMAND));
  } else {
    event.respondWith(cacheFirst(request, CORE));
  }
});
