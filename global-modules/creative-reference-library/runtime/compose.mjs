import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function execute({ run, node, workspace, services }) {
  const output = run.nodes.select?.output;
  const ids = node.metadata.mode === "score" ? await services.referenceLibrary.orderScores(output, run.nodes.prepare.output.candidates) : output?.ids;
  const budget = run.nodes.prepare?.output?.request?.budget;
  const result = output?.items ? await services.referenceLibrary.composeReferences(output.items, budget) : await services.referenceLibrary.compose(ids, budget);
  return exportReferences(workspace, result);
}
export async function exportReferences(workspace, result) {
  const directory = resolve(workspace, "references"); await mkdir(directory, { recursive: true });
  const documents = [];
  for (const [i, document] of result.documents.entries()) {
    const path = `reference-${i + 1}.md`; await writeFile(resolve(directory, path), `# ${document.title}\n\n${document.content}\n`, "utf8");
    documents.push({ id: `reference-${i + 1}`, path, title: document.title, description: "创作参考材料；使用与改编由调用方决定。" });
  }
  await writeFile(resolve(directory, "DOCUMENTS.md"), "# 创作参考资料\n\n仅供参考，不自动成为故事事实或约束。\n" + documents.map(d => `\n- [${d.title}](${d.path})`).join("") + (result.omitted ? "\n\n部分完整资料因预算限制省略。\n" : "\n"));
  await writeFile(resolve(directory, "documents.json"), JSON.stringify({ schemaVersion: 1, documents }, null, 2));
  if (result.partialCoverage) await appendFile(resolve(directory, "DOCUMENTS.md"), "\n\n当前向量索引仅覆盖部分资料；更新索引后可检索更多内容。\n");
  return { status: result.status, count: documents.length, omitted: result.omitted, ...(result.partialCoverage ? { partialCoverage: true } : {}) };
}
