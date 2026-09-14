import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const TARGETS = {
  local: { moduleId: "local-scene-narrative", workflow: "local-scene-narrative/publish-reviewed-story", adapterId: "local-scene-narrative-story", title: "【近场叙事已发布故事】" },
  world: { moduleId: "world-scope-narrative", workflow: "world-scope-narrative/publish-reviewed-story", adapterId: "world-scope-narrative-story", title: "【广域叙事已发布故事】" },
};

async function exists(path) { try { await access(path); return true; } catch { return false; } }

export async function execute({ node, workspace, calls }) {
  const key = node.metadata.storyKind;
  const target = TARGETS[key];
  if (!target) throw new Error(`Unknown storyKind ${key}.`);
  const relativePackage = `handoff/review-candidates/reviewed-${key}`;
  const root = resolve(workspace, relativePackage);
  if (!(await exists(resolve(root, "approval.json")))) return { published: false, reason: "not-approved" };
  const publish = await calls.invoke({ workflow: target.workflow, arguments: {}, documents: { package: relativePackage }, outputPaths: {} });
  const metadata = JSON.parse(await readFile(resolve(root, "metadata.json"), "utf8"));
  const control = JSON.parse(await readFile(resolve(root, "control.json"), "utf8"));
  const story = (await readFile(resolve(root, "story.md"), "utf8")).trim();
  await calls.invoke({
    workflow: "narrative-memory/narrative-memory-source-capture",
    arguments: { request: { captures: [{ captureId: `memory-source-${control.candidateId}`, sourceModuleId: target.moduleId, adapterId: target.adapterId, title: `${target.title}${metadata.summary}`, historyMode: "per-turn", format: "json", captureStatus: "succeeded", content: { sourceTurn: control.sourceTurn, timeRange: metadata.timeRange, locations: metadata.locations, characters: metadata.characters, importantEntities: metadata.importantEntities, story }, sourceReferences: [] }] } },
    outputPaths: {},
  });
  return { published: true, storyKind: key, publishCallId: publish.callId || null };
}
