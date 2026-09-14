import { writeTaskDocumentSet } from "../lib/task-documents.mjs";

export async function execute({ run, workspace }) {
  const prepared = run.nodes["prepare-maintenance"]?.output;
  if (!prepared?.request || !Array.isArray(prepared.targets)) throw new Error("Maintenance task materialization requires a validated request and targets.");
  await writeTaskDocumentSet(workspace, "maintenance-task", {
    title: "本次叙事记忆维护资料",
    guidance: "本页列出的请求与目标是本次维护的明确起点。Agent可以按既定记忆维护职责灵活判断必要的关联影响，但不得把完整记忆库当作默认重写范围。所有修改仍需使用当前revision。",
    documents: [
      { path: "request.md", title: "维护请求", description: "用户明确指定的维护任务。", content: prepared.request },
      { path: "targets.md", title: "目标记录", description: "代码按ID取得的完整目标记录及revision。", content: prepared.targets },
    ],
  });
  return { materialized: true, targetIds: prepared.targets.map(target => target.id), taskType: prepared.request.taskType };
}
