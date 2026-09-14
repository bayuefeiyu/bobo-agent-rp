import { writeTaskDocumentSet } from "../lib/task-documents.mjs";

export async function execute({ run, workspace }) {
  const prepared = run.nodes["prepare-retrieval"]?.output;
  if (!prepared?.effectiveBudget) throw new Error("Retrieval task materialization requires an effective budget.");
  await writeTaskDocumentSet(workspace, "retrieval-task", {
    title: "本次叙事记忆检索执行参数",
    guidance: "自然语言查询由当前任务消息交付；补充文档在WORKSPACE-DOCUMENTS.md中另列。下面是代码结合持久设置、调用覆盖和运行时上限后得到的唯一有效预算。",
    documents: [
      { path: "effective-budget.md", title: "有效检索预算", description: "Agent与后续组装器共同使用的预算。", content: prepared.effectiveBudget },
    ],
  });
  return { materialized: true, effectiveBudget: prepared.effectiveBudget };
}
