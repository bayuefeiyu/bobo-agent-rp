import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rank = guidance => {
  const value = guidance.value?.data || guidance.value || {};
  if (value.kind === "correction" && value.strength === "guardrail") return 0;
  if (value.strength === "guardrail") return 1;
  if (value.strength === "priority") return 2;
  if (value.kind === "context") return 3;
  return 4;
};

export async function execute({ run, workspace, data }) {
  const publicationId = typeof run.arguments?.publicationId === "string" ? run.arguments.publicationId.trim() : "";
  const channel = typeof run.arguments?.channel === "string" ? run.arguments.channel.trim() : "";
  if (!publicationId || !channel) throw new Error("publicationId and channel are required.");
  const publicationRecord = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "private-state", id: publicationId, view: "director" });
  if (!publicationRecord || publicationRecord.recordType !== "director.publication") throw new Error(`Publication ${publicationId} does not exist.`);
  const publication = publicationRecord.value?.data || publicationRecord.value || { items: [] };
  if (publication.channel !== channel) throw new Error(`Publication ${publicationId} belongs to channel ${publication.channel}, not ${channel}.`);
  const selected = [];
  for (let order = 0; order < (publication.items || []).length; order += 1) {
    const entry = publication.items[order];
    const record = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "private-state", id: entry.guidanceId, view: "director" });
    if (!record || record.recordType !== "director.guidance") throw new Error(`Publication ${publicationId} references missing guidance ${entry.guidanceId}.`);
    const value = record.value?.data || record.value || {};
    if (value.status !== "active") throw new Error(`Publication ${publicationId} references inactive guidance ${entry.guidanceId}.`);
    if (!Array.isArray(value.channels) || !value.channels.includes(channel)) throw new Error(`Guidance ${entry.guidanceId} is not allowed on channel ${channel}.`);
    selected.push({ ...record, value, note: entry.note || null, order });
  }
  selected.sort((left, right) => rank(left) - rank(right) || left.order - right.order);
  const sections = selected.map(item => {
    const label = `${item.value.kind}/${item.value.strength}${item.value.contextNature ? `/${item.value.contextNature}` : ""}`;
    return [`## ${item.value.title}`, "", `类型：${label}`, "", item.value.content, item.note ? `\n补充说明：${item.note}` : ""].join("\n").trim();
  });
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "guidance.md"), [
    `# 世界叙事统筹指导：${channel}`,
    "",
    "这些内容是导演对当前创作的披露、建议与约束，不是新的正文，也不自动成为世界事实。",
    "",
    ...(sections.length ? sections : ["本轮没有需要额外提供的导演指导。"]),
    "",
  ].join("\n"), "utf8");
  return { channel, guidanceCount: selected.length };
}
