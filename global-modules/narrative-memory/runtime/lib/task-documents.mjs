import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function body(value) {
  if (typeof value === "string") return value.trim() || "无";
  return `\`\`\`json\n${JSON.stringify(value ?? null, null, 2)}\n\`\`\``;
}

export async function writeTaskDocumentSet(workspace, directory, { title, guidance, documents }) {
  const root = resolve(workspace, directory);
  await mkdir(root, { recursive: true });
  const index = [
    `# ${title}`,
    "",
    guidance,
    "",
    "## 使用指导",
    "",
    ...documents.flatMap(document => [
      `- \`${document.path}\`：${document.description}`,
    ]),
    "",
  ];
  for (const document of documents) {
    await writeFile(resolve(root, document.path), `# ${document.title}\n\n${body(document.content)}\n`, "utf8");
  }
  await writeFile(resolve(root, "DOCUMENTS.md"), index.join("\n"), "utf8");
  return { directory, documents: documents.map(document => document.path) };
}
