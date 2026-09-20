import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function safeChild(root, path, label) {
  const base = resolve(root);
  const target = resolve(base, path);
  const relation = relative(base, target);
  if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error(`${label} escapes the resource module.`);
  return target;
}

function list(values) {
  return values?.length ? values.map(value => `  - ${value}`).join("\n") : "  - none";
}

export async function execute({ run, workspace, module, services }) {
  if (!module?.resourceCatalog || module.id !== "card-context-library") throw new Error("The card context library resource catalog is unavailable.");
  const requested = run.payload?.call?.arguments?.categories;
  if (!Array.isArray(requested) || !requested.length || requested.some(value => typeof value !== "string")) throw new Error("categories must be a non-empty string array.");
  const categories = [...new Set(requested)];
  const unknown = categories.filter(category => !module.resourceCatalog.categories[category]);
  if (unknown.length) throw new Error(`Unknown card context categories: ${unknown.join(", ")}.`);
  const selected = module.resourceCatalog.documents
    .filter(document => document.categories.some(category => categories.includes(category)))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const outputRoot = resolve(workspace, "context");
  await mkdir(outputRoot, { recursive: true });
  for (const document of selected) {
    const source = safeChild(module.directory, document.path, `Resource document ${document.id}`);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Resource document ${document.id} must be a real file.`);
    const targetRelative = document.path.replace(/^documents\//, "");
    const target = safeChild(outputRoot, targetRelative, `Snapshot document ${document.id}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, services.cardText.render(await readFile(source, "utf8"), source), { encoding: "utf8", flag: "wx" });
  }
  const selectedGroups = Object.fromEntries(Object.entries(module.resourceCatalog.selectionGroups)
    .filter(([groupId]) => selected.some(document => document.selectionGroup === groupId)));
  const index = [
    "# Card context document index",
    "",
    `Requested categories: ${categories.join(", ")}`,
    `Delivered documents: ${selected.length}`,
    "",
    ...Object.entries(selectedGroups).flatMap(([groupId, group]) => [
      `## Selection group: ${group.title} (${groupId})`,
      "",
      `- mode: \`${group.mode}\``,
      `- instruction: ${group.instruction}`,
      `- fallback: ${group.fallback ? `\`${group.fallback}\`` : "none"}`,
      "",
    ]),
    ...selected.flatMap(document => [
      `## ${document.title} (${document.id})`,
      "",
      `- path: \`${document.path.replace(/^documents\//, "")}\``,
      `- summary: ${document.summary}`,
      `- categories: ${document.categories.map(value => `\`${value}\``).join(", ")}`,
      `- subcategory: ${document.subcategory ? `\`${document.subcategory}\`` : "none"}`,
      `- readPolicy: \`${document.readPolicy}\``,
      `- authority: \`${document.authority}\``,
      `- appliesAt: ${document.appliesAt.map(value => `\`${value}\``).join(", ") || "none"}`,
      `- priority: ${document.priority}`,
      `- selectionGroup: ${document.selectionGroup ? `\`${document.selectionGroup}\`` : "none"}`,
      `- perspective: \`${document.perspective}\``,
      "- readWhen:",
      list(document.readWhen),
      "- aliases:",
      list(document.aliases),
      "- related:",
      list(document.related),
      "",
    ]),
  ].join("\n");
  await writeFile(resolve(outputRoot, "DOCUMENTS.md"), `${services.cardText.render(index, "card context index")}\n`, { encoding: "utf8", flag: "wx" });
  return { categories, documents: selected.map(document => document.id) };
}
