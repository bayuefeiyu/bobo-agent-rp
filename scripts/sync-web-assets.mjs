import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const destinations = [".agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/vendor", ".agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/packages"];
let drift = false;
for (const packageName of ["rp-web-client", "rp-web-contract", "rp-web-server"]) {
  const source = resolve(root, "packages", packageName);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".test.mjs") || entry.name.endsWith(".md") || /\.d\.[cm]?ts$/.test(entry.name)) continue;
    if (packageName === "rp-web-server" && entry.name !== "static-host.mjs") continue;
    const body = await readFile(resolve(source, entry.name));
    for (const destination of destinations) {
      if (packageName === "rp-web-server" && destination.endsWith("vendor")) continue;
      const directory = resolve(root, destination, packageName), target = resolve(directory, entry.name);
      if (process.argv.includes("--check")) {
        if (!(await readFile(target).catch(() => Buffer.alloc(0))).equals(body)) { console.error(`Generated Web asset differs: ${target}`); drift = true; }
      } else { await mkdir(directory, { recursive: true }); await writeFile(target, body); }
    }
  }
}
if (drift) process.exitCode = 1;
