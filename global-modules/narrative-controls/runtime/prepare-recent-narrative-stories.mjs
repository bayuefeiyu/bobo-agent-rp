import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SOURCES = [
  { id: "local-scene-narrative", title: "近场叙事", workflow: "local-scene-narrative/export-recent-stories", output: "local" },
  { id: "world-scope-narrative", title: "广域叙事", workflow: "world-scope-narrative/export-recent-stories", output: "world" },
];

export async function execute({ run, workflow, featureModules, workspace, calls }) {
  const root = resolve(workspace, "recent-narrative-stories");
  await mkdir(root, { recursive: true });
  const loaded = new Set(featureModules || []);
  const throughTurn = Math.max(0, Number(run.turn || 0) - 1);
  const recentCompleteTurns = Number(workflow?.turnContext?.recentCompleteTurns || 5);
  const entries = [];
  for (const source of SOURCES) {
    if (!loaded.has(source.id)) continue;
    await calls.invoke({ workflow: source.workflow, arguments: { throughTurn, recentCompleteTurns }, documents: {}, outputPaths: { stories: `recent-narrative-stories/${source.output}` } });
    entries.push({ ...source, path: source.output });
  }
  await writeFile(resolve(root, "DOCUMENTS.md"), [
    "# Recent published non-main stories",
    "",
    "These windows use the foreground workflow's recentCompleteTurns setting. Read each nested DOCUMENTS.md; the summary directory is for selection, and full stories are available as source material.",
    "",
    ...entries.flatMap(entry => [`## ${entry.title}`, "", `- path: \`${entry.path}\``, "- readPolicy: `conditional`", "- authority: `canonical`", "- appliesAt: `analysis-planning-writing`", ""]),
    ...(entries.length ? [] : ["No compatible narrative module is loaded.", ""]),
  ].join("\n"), "utf8");
  return { sources: entries.map(entry => entry.id), throughTurn, recentCompleteTurns };
}
