// MapLibre GL JS 6 runs its tile parsing in a separate worker script. It
// looks for that file next to its own module, which a bundler moves, so copy
// the worker into public/vendor/ and point MapLibre at it (setWorkerUrl).
// Runs automatically before `npm run dev` and `npm run build`.
import { copyFile, mkdir } from "node:fs/promises";

const src = new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);
const dir = new URL("../public/vendor/", import.meta.url);
await mkdir(dir, { recursive: true });
await copyFile(src, new URL("maplibre-gl-worker.mjs", dir));
