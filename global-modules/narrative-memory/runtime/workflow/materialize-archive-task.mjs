import { writeTaskDocumentSet } from "../lib/task-documents.mjs";

export async function execute({ run, workspace }) {
  const prepared = run.nodes["prepare-archive"]?.output;
  if (!prepared?.shouldArchive || prepared.route !== "archive") throw new Error("Archive task materialization requires an eligible archive range.");
  const context = prepared.context || {};
  await writeTaskDocumentSet(workspace, "archive-task", {
    title: "本次叙事记忆归档资料",
    guidance: "这些资料由代码按已冻结范围组装。先读本页，再读待归档剧情；早期剧情仅供衔接，其他模块资料按其来源说明使用。不要把技术状态当成故事事实。",
    documents: [
      { path: "archive-story.md", title: "本次待归档剧情", description: "必须处理的连续剧情范围。", content: context["以下为本次归档的剧情"] },
      { path: "earlier-reference.md", title: "早期衔接参考", description: "仅用于衔接与消歧，不重复归档。", content: context["以下为早期剧情，作为参考"] },
      { path: "module-sources.md", title: "其他模块来源资料", description: "本范围内选定的其他模块资料。", content: context["以下为本次归档覆盖的其他模块资料"] },
      { path: "source-guidance.md", title: "来源归档说明", description: "各来源预定义的解释和归档边界。", content: context["以下为其他模块来源各自预定义的归档说明"] },
      { path: "summary-repairs.md", title: "摘要超限任务", description: "本轮归档时需要顺带处理的已判定超限摘要。", content: prepared.overLimitSummaryTasks || [] },
    ],
  });
  return { materialized: true, firstTurn: prepared.firstTurn, lastTurn: prepared.eligibleLastTurn };
}
