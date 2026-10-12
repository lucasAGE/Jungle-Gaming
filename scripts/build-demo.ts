import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("../dist/demo/", import.meta.url);
await mkdir(directory, { recursive: true });
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/demo/browser.ts", import.meta.url))],
  outdir: fileURLToPath(directory),
  naming: "app.js", target: "browser", minify: false,
});
if (!result.success) throw new AggregateError(result.logs, "Presentation UI build failed");
await Promise.all(["index.html", "styles.css"].map((name) => copyFile(
  new URL(`../src/demo/${name}`, import.meta.url), new URL(name, directory),
)));
