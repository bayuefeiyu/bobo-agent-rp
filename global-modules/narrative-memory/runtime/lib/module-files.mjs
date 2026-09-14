import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadTemplates() {
  const registry = await json(resolve(moduleRoot, "templates", "registry.json"));
  const templates = new Map();
  for (const item of registry.templates || []) {
    if (!item.enabled) continue;
    const template = await json(resolve(moduleRoot, "templates", item.file));
    if (template.templateId !== item.templateId || template.templateVersion !== item.templateVersion || template.recordType !== item.recordType) throw new Error(`Template registry mismatch: ${item.templateId}.`);
    templates.set(item.templateId, template);
  }
  return { registry, templates };
}

export async function loadTimeAdapter() {
  return import(`${pathToFileURL(resolve(moduleRoot, "runtime", "time-adapter.mjs")).href}?v=${Date.now()}`);
}
