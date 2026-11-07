// Serve the static build in out/ exactly as GitHub Pages will: under the
// base path, with byte-range support for the PMTiles file.
//
//   npm run build:pages && npm run preview   ->  http://localhost:4173/ukrentmap/
//   npm run build && npm run preview         ->  http://localhost:4173/
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

// OUT_DIR serves another copy of the build (the update test uses one).
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) + "/" : new URL("../out/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4173);
// Detect the base path the build was made with from the exported index.html.
const html = await import("node:fs/promises").then((fs) => fs.readFile(join(OUT, "index.html"), "utf8"));
const BASE = (/href="(\/[^"/]+)\/_next\//.exec(html) ?? [])[1] ?? "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".pbf": "application/x-protobuf",
  ".pmtiles": "application/octet-stream",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (BASE && !path.startsWith(BASE + "/")) {
      res.writeHead(path === BASE ? 301 : 404, path === BASE ? { Location: BASE + "/" } : {});
      return res.end();
    }
    path = path.slice(BASE.length);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(OUT, path));
    if (!file.startsWith(OUT)) {
      res.writeHead(403);
      return res.end();
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const headers = {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      ETag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
    };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": info.size });
    createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(PORT, () => console.log(`serving out/ at http://localhost:${PORT}${BASE}/`));
