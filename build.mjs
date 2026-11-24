import { copyFile } from "node:fs/promises";
import { build } from "esbuild-wasm";

await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "es2022",
  external: ["obsidian"],
  legalComments: "inline",
});

await Promise.all([
  copyFile("manifest.json", "dist/manifest.json"),
  copyFile("styles.css", "dist/styles.css"),
]);
