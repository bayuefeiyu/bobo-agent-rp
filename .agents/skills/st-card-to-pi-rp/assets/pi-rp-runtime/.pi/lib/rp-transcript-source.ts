// 转录来源：来源记录读取、来源策略、来源目录路径与派生目录刷新（S5 批次 6）。
//
// 一个"来源"由三件事定义：**它的记录**（来自会话消息）、**它的检索策略**（声明在卡片清单里）、
// **它的派生目录**（可重建，落在会话目录下）。三者必须始终对应同一个来源，因此放在同一模块。
//
// 这些函数只依赖显式参数（target/source/records），不读写宿主闭包状态，也不持有会话身份，
// 因此可以独立测试（见 rp-transcript-source.test.mjs）。
//
// 从 `../extensions/pi-rp-web.ts` 的闭包中搬出；逻辑与文案未改写，只去掉了闭包缩进。
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildCatalog } from "./rp-records.mjs";

// 纯类型导入：编译后不产生运行期引用，因此不与宿主形成循环依赖。
import type { ActiveBridge, RecordEnvelope, RetrievalPolicy, RpRun } from "./rp-host-types.ts";

export { readSourceRecords, refreshSourceCatalog, sourceCatalogPath, sourcePolicy };

async function readSourceRecords(target: ActiveBridge, source: string, run: RpRun): Promise<RecordEnvelope[]> {
  if (source === "messages") return target.messages.filter(record => record.sequence < run.submittedSequence);
  throw new Error(`Unknown RP transcript source: ${source}`);
}

function sourcePolicy(target: ActiveBridge, source: string): RetrievalPolicy {
  if (source === "messages") return target.messagePolicy;
  throw new Error(`Unknown RP transcript source: ${source}`);
}

function sourceCatalogPath(target: ActiveBridge, source: string) {
  if (!target.sessionDirectory) throw new Error("The active RP chat has no session directory.");
  if (source === "messages") return resolve(target.sessionDirectory, "catalog", "messages.json");
  throw new Error(`Unknown RP transcript source: ${source}`);
}

async function refreshSourceCatalog(target: ActiveBridge, source: string, records: RecordEnvelope[]) {
  if (!target.sessionDirectory) return buildCatalog(records);
  const path = sourceCatalogPath(target, source);
  await mkdir(resolve(path, ".."), { recursive: true });
  const catalog = buildCatalog(records);
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}
