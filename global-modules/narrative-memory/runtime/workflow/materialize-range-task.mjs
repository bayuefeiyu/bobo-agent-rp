import { writeTaskDocumentSet } from "../lib/task-documents.mjs";

export async function execute({ run, workspace }) {
  const prepared = run.nodes["prepare-range"]?.output;
  if (!prepared?.shouldArchive) throw new Error("Range task materialization requires a validated range.");
  const context = prepared.context || {};
  await writeTaskDocumentSet(workspace, "range-task", {
    title: "本次叙事记忆范围处理资料",
    guidance: "这些资料由代码按用户指定的完整回合范围冻结。先读本页，再处理范围内剧情；早期剧情仅供衔接，其他模块资料按其来源使用。",
    documents: [
      { path: "request.md", title: "任务要求", description: "任务类型及用户补充要求。", content: { operation: prepared.operation, focus: prepared.userInstruction || null, firstTurn: prepared.firstTurn, lastTurn: prepared.eligibleLastTurn } },
      { path: "range-story.md", title: "本次处理剧情", description: "必须复核或补充的剧情范围。", content: context["以下为本次处理的剧情"] },
      { path: "earlier-reference.md", title: "早期衔接参考", description: "仅用于衔接与消歧。", content: context["以下为早期剧情，作为参考"] },
      { path: "module-sources.md", title: "其他模块来源资料", description: "本范围内选定的其他模块资料。", content: context["以下为本次处理范围的其他模块资料"] },
      { path: "summary-repairs.md", title: "摘要超限任务", description: "本轮需要一并处理的超限摘要。", content: prepared.overLimitSummaryTasks || [] },
    ],
  });
  return { materialized: true, operation: prepared.operation, firstTurn: prepared.firstTurn, lastTurn: prepared.eligibleLastTurn };
}
