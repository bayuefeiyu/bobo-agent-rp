import { access } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "rp-data-contracts.mjs";
const start = dirname(fileURLToPath(import.meta.url));

function ancestorDirectories(path) {
  const result = [];
  for (let current = path; ; current = dirname(current)) {
    result.push(current);
    if (current === parse(current).root) return result;
  }
}

async function isRuntimeLibrary(path) {
  try {
    await access(resolve(path, marker));
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimeLibrary() {
  const candidates = [];
  if (process.env.PI_RP_RUNTIME_LIB) candidates.push(resolve(process.env.PI_RP_RUNTIME_LIB));
  for (const ancestor of ancestorDirectories(start)) {
    candidates.push(resolve(ancestor, ".pi", "lib"));
    candidates.push(resolve(ancestor, ".agents", "skills", "st-card-to-pi-rp", "assets", "pi-rp-runtime", ".pi", "lib"));
  }
  for (const candidate of [...new Set(candidates)]) {
    if (await isRuntimeLibrary(candidate)) return candidate;
  }
  throw new Error(`Could not locate the Pi RP runtime test library from ${start}. Set PI_RP_RUNTIME_LIB to its absolute path.`);
}

export const runtimeTestLibrary = await resolveRuntimeLibrary();

export async function importRuntimeTestModule(file) {
  return import(pathToFileURL(resolve(runtimeTestLibrary, file)).href);
}
