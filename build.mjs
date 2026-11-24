import { copyFile, readFile } from "node:fs/promises";
import { build } from "esbuild-wasm";

const markedLicense = await readFile(new URL("./node_modules/marked/LICENSE", import.meta.url), "utf8");
const licenseNotice = markedLicense.trimEnd().replaceAll("*/", "* /");

await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "es2022",
  external: ["obsidian"],
  banner: { js: "/* Bundled dependency notice for Marked\n\n" + licenseNotice + "\n*/" },
  legalComments: "inline",
});

await Promise.all([
  copyFile("manifest.json", "dist/manifest.json"),
  copyFile("styles.css", "dist/styles.css"),
]);
