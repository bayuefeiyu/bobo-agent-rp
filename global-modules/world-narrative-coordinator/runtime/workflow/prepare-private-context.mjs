import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { json, queryAll, safeFileId } from "../lib/data.mjs";

const PRIVATE_TYPES = ["director.incubation", "director.actor-plan", "director.story-plan", "director.world-trajectory", "director.watch", "director.player-signal", "director.guidance", "director.publication", "director.turn-brief", "director.bootstrap-state"];

export async function execute({ workspace, data }) {
  const root = resolve(workspace, "private-context");
  await mkdir(resolve(root, "records"), { recursive: true });
  const privateItems = await queryAll(data, { moduleId: "world-narrative-coordinator", collectionId: "private-state", recordTypes: PRIVATE_TYPES, view: "director", includeInactive: true });
  const deepItems = await queryAll(data, { moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordTypes: ["director.deep-report", "director.deep-state"], view: "daily-director", includeInactive: true });
  const settings = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "settings", id: "director-settings-current", view: "runtime" });
  const documents = [];
  for (const item of [...privateItems, ...deepItems]) {
    const path = `records/${safeFileId(item.id)}.json`;
    await writeFile(resolve(root, path), json({ id: item.id, recordType: item.recordType, revision: item.revision, value: item.value }), "utf8");
    documents.push({ id: item.id, recordType: item.recordType, path });
  }
  await writeFile(resolve(root, "settings.json"), json(settings), "utf8");
  const brief = privateItems.find(item => item.id === "turn-brief-current");
  const publications = privateItems.filter(item => item.recordType === "director.publication");
  const deepState = deepItems.find(item => item.id === "deep-state-current");
  const deepReport = deepItems.find(item => item.id === "deep-report-current");
  await writeFile(resolve(root, "CURRENT.md"), [
    "# 当前导演交接",
    "",
    "本文件只汇总上一轮已经确定的交接与运行状态；本轮新问题由当前导演自行分析。",
    "",
    `- 上轮交接：${brief?.value?.data?.summary || brief?.value?.summary || "无"}`,
    `- 发布频道：${publications.map(item => item.value?.data?.channel || item.value?.channel).filter(Boolean).join("、") || "无"}`,
    `- 深度导演状态：${deepState?.value?.data?.status || deepState?.value?.status || "unknown"}`,
    `- 当前深度报告依据轮次：${deepReport?.value?.data?.basisTurn ?? deepReport?.value?.basisTurn ?? 0}`,
    "",
  ].join("\n"), "utf8");
  await writeFile(resolve(root, "DOCUMENTS.md"), [
    "# 导演私有资料目录",
    "",
    "目录完整列出本次快照内的全部记录，不按预算隐藏或截断。先读 CURRENT.md，再按任务选读记录。",
    "",
    "- `CURRENT.md`：上一轮交接、频道发布状态与深度报告元数据。",
    "- `settings.json`：导演运行设置。",
    ...documents.map(item => `- \`${item.path}\`：${item.recordType} / ${item.id}`),
    "",
  ].join("\n"), "utf8");
  return { directory: "private-context", recordCount: documents.length };
}
