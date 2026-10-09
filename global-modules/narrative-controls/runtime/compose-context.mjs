import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function copyDocuments(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Static context cannot contain symbolic links.");
    if (entry.isDirectory()) await copyDocuments(resolve(source, entry.name), resolve(target, entry.name));
    else if (entry.isFile()) await writeFile(resolve(target, entry.name), await readFile(resolve(source, entry.name), "utf8"), { encoding: "utf8", flag: "wx" });
    else throw new Error("Static context must contain regular documents.");
  }
}

export async function execute({ run, workspace, module, data, services }) {
  const { composePromptRequirements, loadPromptControls, readControlFile, selectedPromptTexts } = services.promptControls;
  if (module?.id !== "narrative-controls") throw new Error("Narrative controls module is unavailable.");
  if (typeof run.documents?.["static-context"] !== "string") throw new Error("static-context document input is required.");
  const controls = await loadPromptControls(module.directory, module.resourceCatalog);
  const record = await data.get({ moduleId: module.id, collectionId: "settings", id: "narrative-preferences", view: "processor" });
  if (!record) throw new Error("Narrative preferences are not initialized.");
  const settings = record.value.settings;
  const texts = await selectedPromptTexts(module.directory, controls, settings);
  const requirements = services.cardText.render(composePromptRequirements(controls, settings, texts), "selected creative requirements");
  const source = resolve(workspace, "inputs/static-context");
  const output = resolve(workspace, "context");
  await copyDocuments(source, output);
  if (requirements) {
    const index = await readControlFile(source, "DOCUMENTS.md");
    await writeFile(resolve(output, "creative-requirements.md"), requirements, { encoding: "utf8", flag: "wx" });
    await writeFile(resolve(output, "DOCUMENTS.md"), `${index.trimEnd()}\n\n## 创作要求 (creative-requirements)\n\n- path: \`creative-requirements.md\`\n- summary: 本次正文的创作准则。\n- categories: \`narrative-guidance\`\n- readPolicy: \`required\`\n- authority: \`binding\`\n- appliesAt: \`planning\`, \`writing\`, \`checking\`\n- priority: 0\n- selectionGroup: none\n- perspective: \`general\`\n`, "utf8");
  }
  return { documentsPrepared: true };
}
