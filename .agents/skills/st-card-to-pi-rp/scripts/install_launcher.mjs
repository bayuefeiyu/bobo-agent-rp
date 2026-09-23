import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/pi-rp-launcher");
const target = resolve(process.argv[2] || "play", "launcher");
const update = process.argv.includes("--update");
for (const file of ["server.mjs", "index.html", "validate-runtime-package.mjs"]) {
  const destination = join(target, file);
  if (!update && await stat(destination).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error))) throw new Error(`Launcher already exists: ${destination}. Use --update to replace only launcher code.`);
}
await mkdir(target, { recursive: true });
for (const file of ["server.mjs", "index.html", "validate-runtime-package.mjs"]) await copyFile(join(source, file), join(target, file));
console.log(`Launcher installed at ${target}. Recent-card state was left intact.`);
