import { mkdir,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function execute({ workspace,services }) {
  const result = await services.narrativeHistory.retrieve();
  const directory = resolve(workspace,"history-recall"); await mkdir(directory,{ recursive:true });
  const documents = ["# 历史正文摘录","","以下历史原文由向量召回及重排筛选得到，不保证与当前场景相关，仅供参考；请结合本轮语境判断是否采用，无需强行引用或融入正文。摘录按原轮次及轮内位置排列，但可能跨越多轮、缺少中间情节；请以标注轮次判断先后，不要把相邻摘录视为连续事件。","","它们可用于核对动作、对白和叙述细节；历史中的状态不自动等于当前状态，对白和猜测不自动等于客观事实。","",...result.excerpts.flatMap((item,index) => [`## ${index+1}. 第 ${item.turn} 轮`,"",item.content,""])];
  await writeFile(resolve(directory,"excerpts.md"),documents.join("\n"),"utf8");
  await writeFile(resolve(directory,"DOCUMENTS.md"),result.excerpts.length ? "# 历史正文材料\n\n- path: `excerpts.md`\n- readPolicy: `required`\n- authority: `canonical`\n- appliesAt: `planning-writing-checking`\n- description: 向量召回及重排筛选的历史原文，不保证与当前场景相关，仅供参考；以标注轮次判断先后，摘录之间不一定连续。\n" : "# 历史正文材料\n\n本轮没有可交付的历史原文摘录。\n","utf8");
  return { status:result.status,results:result.excerpts.length,errorCode:result.errorCode };
}
