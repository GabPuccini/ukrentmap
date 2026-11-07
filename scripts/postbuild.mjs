// After `next build`: stamp the service worker in out/ with the list of
// files to cache and a version hash of their contents. Because the hash
// covers every cached file, any change to the app or the data gives a new
// worker, so an installed copy always notices a release. Nothing to remember.
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const OUT = new URL("../out/", import.meta.url).pathname;

// Cached on demand instead of up front: 120 files, about 21 MB.
// The maplibre-gl*.mjs copies Turbopack emits under _next/static/media are
// never loaded: the app points MapLibre at public/vendor/ instead.
const SKIP = [/^_next\/static\/media\/maplibre-gl/, /^data\/pc\//, /^sw\.js$/, /\.map$/, /^robots\.txt$/, /^\.nojekyll$/, /^404/, /^_not-found/, /\.txt$/];

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = (await walk(OUT))
  .map((p) => relative(OUT, p).split(sep).join("/"))
  .filter((p) => !SKIP.some((re) => re.test(p)))
  .sort();

const hash = createHash("sha256");
for (const f of files) {
  hash.update(f);
  hash.update(await readFile(join(OUT, f)));
}
const version = hash.digest("hex").slice(0, 12);

// index.html is cached as the scope URL itself, "./"; every other path is relative to the scope.
const urls = files.map((f) => (f === "index.html" ? "./" : "./" + f.replace(/\/index\.html$/, "/")));

const swPath = join(OUT, "sw.js");
const sw = await readFile(swPath, "utf8");
if (!sw.includes("__VERSION__") || !sw.includes("__PRECACHE__")) throw new Error("out/sw.js has no placeholders to stamp");
await writeFile(swPath, sw.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(urls, null, 0)));

let bytes = 0;
for (const f of files) bytes += (await stat(join(OUT, f))).size;
console.log(`service worker ${version}: ${urls.length} files, ${(bytes / 1e6).toFixed(1)} MB precached`);
