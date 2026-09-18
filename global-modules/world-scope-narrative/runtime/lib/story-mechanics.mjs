// Canonical source. Keep installed module copies synchronized with scripts/sync_story_mechanics.mjs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { latestBusinessRecord, queryAll } from "./data.mjs";
import { submitCommitted, validateStoryMetadata } from "./story-contract.mjs";

export function createStoryMechanics(options) {
  const { moduleId, recordType, contextTitle, contextGuidance, recentTitle, seriesIndexDescription, recentIndexDescription, controlDefaults = {} } = options;
  const collectionId = "story-publications";
  const baseQuery = view => ({ moduleId, collectionId, recordTypes: [recordType], view });

  async function validateCandidate({ run, workspace }) {
    const input = resolve(workspace, "handoff", "write", "candidate");
    const story = (await readFile(resolve(input, "story.md"), "utf8")).trim();
    const metadata = JSON.parse(await readFile(resolve(input, "metadata.json"), "utf8"));
    if (!story) throw new Error("Candidate story is empty.");
    validateStoryMetadata(metadata, moduleId, "candidate metadata");
    const assignment = run.arguments?.assignment || {};
    for (const key of ["candidateId", "storyId", "seriesId", "sourceTurn", "notAfter"]) if (assignment[key] === undefined || assignment[key] === null || assignment[key] === "") throw new Error(`Assignment ${key} is required.`);
    const control = { candidateId: assignment.candidateId, storyId: assignment.storyId, seriesId: assignment.seriesId, sourceTurn: assignment.sourceTurn, originStoryId: assignment.originStoryId || null, action: assignment.action, notAfter: assignment.notAfter };
    for (const [field, fallback] of Object.entries(controlDefaults)) control[field] = assignment[field] ?? fallback;
    const output = resolve(workspace, "candidate");
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "story.md"), `${story}\n`, "utf8");
    await writeFile(resolve(output, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(resolve(output, "control.json"), `${JSON.stringify(control, null, 2)}\n`, "utf8");
    return { valid: true, candidateId: assignment.candidateId };
  }

  async function publishStory({ workspace, data }) {
    const root = resolve(workspace, "inputs", "package");
    const story = (await readFile(resolve(root, "story.md"), "utf8")).trim();
    const metadata = JSON.parse(await readFile(resolve(root, "metadata.json"), "utf8"));
    const control = JSON.parse(await readFile(resolve(root, "control.json"), "utf8"));
    const approval = JSON.parse(await readFile(resolve(root, "approval.json"), "utf8"));
    if (!story || metadata.module !== moduleId || !["accept-original", "replace"].includes(approval.decision) || !approval.authority || !approval.runId) throw new Error("Reviewed story package is invalid.");
    const duplicate = await data.query({ ...baseQuery("publish"), where: { candidateId: { eq: control.candidateId } }, limit: 1 });
    if (duplicate.items?.length) return { committed: false, idempotent: true, storyId: duplicate.items[0].id };
    const previous = await latestBusinessRecord(data, { ...baseQuery("publish"), where: { seriesId: { eq: control.seriesId } } });
    const sequence = Number(previous?.value?.sequence || 0) + 1;
    const record = { storyId: control.storyId, seriesId: control.seriesId, sequence, sourceTurn: control.sourceTurn, timeRange: metadata.timeRange, locations: [...new Set(metadata.locations)], characters: [...new Set(metadata.characters)], importantEntities: metadata.importantEntities, summary: metadata.summary.trim(), content: story, originStoryId: control.originStoryId || null, candidateId: control.candidateId, approval: { authority: approval.authority, runId: approval.runId, decision: approval.decision } };
    const operationId = `publish-${control.candidateId}`;
    const receipt = await submitCommitted(data, { protocolVersion: 1, batchId: operationId, status: "pending", commitPolicy: "atomic", operations: [{ operationId, moduleId, collectionId, recordType, action: "create", targetId: control.storyId, data: record }] });
    return { committed: true, storyId: control.storyId, sequence, receipt };
  }

  async function exportRecentStories({ run, workspace, data }) {
    const through = Number(run.arguments?.throughTurn);
    const count = Number(run.arguments?.recentCompleteTurns);
    if (!Number.isSafeInteger(through) || !Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error("throughTurn and recentCompleteTurns are required.");
    const from = Math.max(0, through - count + 1);
    // A range is two bounds, but one index condition carries exactly one operator. Narrow on the
    // lower bound through the index and apply the upper bound to the returned records, walking every
    // page so a later page inside the window is never missed. `sourceTurn` is also the sort field,
    // which keeps pages contiguous over the index this filter uses.
    const matches = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await data.query({ ...baseQuery("creative-index"), where: { sourceTurn: { gte: from } }, sort: [{ field: "sourceTurn", order: "asc" }], cursor, limit: 200, maxCharacters: 500000 });
      for (const item of page.items || []) {
        const sourceTurn = Number(item.value?.sourceTurn);
        if (Number.isSafeInteger(sourceTurn) && sourceTurn >= from && sourceTurn <= through) matches.push(item);
      }
      cursor = page.nextCursor || null;
      if (cursor && seenCursors.has(cursor)) throw new Error("Recent-story pagination repeated a cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    const root = resolve(workspace, "stories");
    await mkdir(resolve(root, "full"), { recursive: true });
    const entries = [];
    for (const item of matches) {
      const full = await data.get({ moduleId, collectionId, id: item.id, view: "creative-full" });
      const path = `full/${item.id}.json`;
      await writeFile(resolve(root, path), `${JSON.stringify(full, null, 2)}\n`, "utf8");
      entries.push({ ...item, document: path });
    }
    await writeFile(resolve(root, "story-index.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await writeFile(resolve(root, "DOCUMENTS.md"), [`# ${recentTitle}`, "", "Read story-index.json first. Open full documents only when relevant. Full documents intentionally omit summaries.", "", "- index: `story-index.json`", ...entries.map(item => `- ${item.id}: \`${item.document}\``), ""].join("\n"), "utf8");
    return { count: entries.length, fromTurn: from, throughTurn: through };
  }

  async function prepareStoryContext({ run, module, workspace, data }) {
    const assignment = run.arguments?.assignment || {};
    const directory = resolve(workspace, "story-context");
    await mkdir(directory, { recursive: true });
    const documents = [];
    for (const entry of module.resourceCatalog?.documents || []) {
      const content = await readFile(resolve(module.directory, entry.path), "utf8");
      const path = `creative/${entry.id}.md`;
      await mkdir(resolve(directory, "creative"), { recursive: true });
      await writeFile(resolve(directory, path), content, "utf8");
      documents.push({ id: entry.id, path, description: entry.summary || entry.title });
    }
    const query = baseQuery("creative-index");
    if (assignment.seriesId) query.where = { seriesId: { eq: assignment.seriesId } };
    const indexItems = assignment.seriesId ? await queryAll(data, query) : (await data.query({ ...query, sort: [{ field: "storySequence", order: "desc" }], limit: 100, maxCharacters: 500000 })).items || [];
    await writeFile(resolve(directory, "story-index.json"), `${JSON.stringify(indexItems, null, 2)}\n`, "utf8");
    documents.push({ id: "story-index", path: "story-index.json", description: assignment.seriesId ? seriesIndexDescription : recentIndexDescription });
    const last = assignment.seriesId ? await latestBusinessRecord(data, { ...query, maxCharacters: 50000 }) : indexItems[0];
    if (last) {
      const full = await data.get({ moduleId, collectionId, id: last.id, view: "creative-full" });
      await writeFile(resolve(directory, "previous-story.json"), `${JSON.stringify(full, null, 2)}\n`, "utf8");
      documents.push({ id: "previous-story", path: "previous-story.json", description: "Full previous installment for direct continuation." });
    }
    await writeFile(resolve(directory, "DOCUMENTS.md"), [`# ${contextTitle}`, "", contextGuidance, "", ...documents.flatMap(item => [`## ${item.id}`, "", `- path: \`${item.path}\``, "- readPolicy: `required`", "- authority: `binding`", "- appliesAt: `planning-writing-checking`", `- description: ${item.description}`, ""])].join("\n"), "utf8");
    return { prepared: true, documents: documents.length };
  }

  return { validateCandidate, publishStory, exportRecentStories, prepareStoryContext };
}
