import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { timelineMarkdown } from "./build-reference-snapshot.mjs";

export async function execute({ run, workspace }) {
  const prepared = run.nodes["prepare-compression"]?.output;
  if (!prepared?.shouldCompress || prepared.route !== "compress") {
    throw new Error("Compression snapshot materialization requires an eligible compression plan.");
  }
  const entries = Array.isArray(prepared.effectiveEntries) ? prepared.effectiveEntries : [];
  const target = resolve(workspace, "reference-snapshot");
  await mkdir(target, { recursive: true });
  await writeFile(resolve(target, "timeline.md"), timelineMarkdown(entries), "utf8");
  await writeFile(resolve(target, "DOCUMENTS.md"), [
    "# 压缩规划资料",
    "",
    "本目录由代码根据资格节点已经读取并冻结的有效事件目录生成，不再次查询事件。摘要替代其覆盖的叶事件；只根据这里的有效目录提出压缩分组，不据此改写事实。",
    "",
    `- 当前有效条目数：${prepared.effectiveEntryCount}`,
    `- 本轮目标条目数：${prepared.targetEntryCount}`,
    "",
    "## 使用指导",
    "",
    "- `timeline.md`：本次压缩规划必须阅读的有效时间线。",
    "- 输出分组时只引用其中列出的记录 ID。",
    "- readPolicy: `required`",
    "- authority: `canonical`",
    "- appliesAt: `compression-planning`",
    "",
  ].join("\n"), "utf8");
  return { materialized: true, effectiveEntryCount: entries.length, targetEntryCount: prepared.targetEntryCount };
}
