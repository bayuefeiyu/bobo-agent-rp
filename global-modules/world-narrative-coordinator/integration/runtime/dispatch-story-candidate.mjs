import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TARGETS = {
  local: { workflow: "local-scene-narrative/create-story-candidate", channel: "local-scene-narrative" },
  world: { workflow: "world-scope-narrative/create-story-candidate", channel: "world-scope-narrative" },
};

export async function execute({ node, workspace, calls }) {
  const key = node.metadata.storyKind;
  const target = TARGETS[key];
  if (!target) throw new Error(`Unknown storyKind ${key}.`);
  const plan = JSON.parse(await readFile(resolve(workspace, "handoff", "post-director", "delegations", "plan.json"), "utf8"));
  const assignment = plan[key];
  const root = resolve(workspace, "candidate-set");
  await mkdir(root, { recursive: true });
  if (!assignment?.enabled) {
    await writeFile(resolve(root, "status.json"), `${JSON.stringify({ status: "not-scheduled", storyKind: key }, null, 2)}\n`, "utf8");
    return { scheduled: false, storyKind: key };
  }
  const documents = { "turn-context": "trigger/turn-context" };
  if (assignment.publicationId) {
    await calls.invoke({
      workflow: "world-narrative-coordinator/materialize-guidance",
      arguments: { publicationId: assignment.publicationId, channel: target.channel },
      outputPaths: { guidance: "director-guidance.md" },
    });
    documents.guidance = "director-guidance.md";
  }
  const child = await calls.invoke({ workflow: target.workflow, arguments: { assignment }, documents, outputPaths: { candidate: "candidate-set/candidate" } });
  await writeFile(resolve(root, "status.json"), `${JSON.stringify({ status: "candidate-ready", storyKind: key, childCallId: child.callId || null }, null, 2)}\n`, "utf8");
  return { scheduled: true, storyKind: key, childCallId: child.callId || null };
}
