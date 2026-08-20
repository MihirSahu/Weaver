import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const extension = resolve(root, "extension");
const outdir = resolve(root, "dist");

await rm(outdir, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(outdir, "background"), { recursive: true }),
  mkdir(resolve(outdir, "content"), { recursive: true }),
  mkdir(resolve(outdir, "popup"), { recursive: true }),
  mkdir(resolve(outdir, "assets"), { recursive: true }),
]);

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

await Promise.all([
  build({ ...common, entryPoints: [resolve(extension, "src/background/service-worker.ts")], outfile: resolve(outdir, "background/service-worker.js") }),
  build({ ...common, entryPoints: [resolve(extension, "src/content/inject-weave-action.ts")], outfile: resolve(outdir, "content/inject-weave-action.js") }),
  build({ ...common, entryPoints: [resolve(extension, "src/popup/popup.ts")], outfile: resolve(outdir, "popup/popup.js") }),
  cp(resolve(extension, "manifest.json"), resolve(outdir, "manifest.json")),
  cp(resolve(extension, "src/popup/popup.html"), resolve(outdir, "popup/popup.html")),
  cp(resolve(extension, "src/popup/popup.css"), resolve(outdir, "popup/popup.css")),
  cp(resolve(extension, "assets/weaver-mark.svg"), resolve(outdir, "assets/weaver-mark.svg")),
]);

console.log(`Built Weaver extension at ${outdir}`);
