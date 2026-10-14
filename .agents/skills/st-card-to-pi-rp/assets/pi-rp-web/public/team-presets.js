/* Pure workflow-node mode helpers shared by the configuration UI and tests. */

const AGENT_FIELDS = ["agentId", "modelId", "prompt", "promptFile"];
const COLLABORATION_FIELDS = ["team", "promptFile", "prompt"];
const MODE_FIELDS = new Set([...AGENT_FIELDS, ...COLLABORATION_FIELDS]);

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function modeOf(node) {
  if (node?.type === "team" && node.team?.protocol === "collaboration") return "collaboration";
  if (node?.type === "agent") return "agent";
  return node?.type === "team" ? "meeting" : node?.type || null;
}

function ensureBackupPath(backups, workflowKey, nodeId) {
  const next = clone(backups || {});
  next[workflowKey] ??= {};
  next[workflowKey][nodeId] ??= {};
  return next;
}

function typeFields(source, fields) {
  const result = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = clone(source[field]);
  return result;
}

function replaceTypeFields(current, source, fields) {
  const next = clone(current);
  for (const field of MODE_FIELDS) delete next[field];
  // Older profile drafts briefly used node.writer; never carry that legacy
  // field into a normalized Agent or collaboration node.
  delete next.writer;
  Object.assign(next, typeFields(source, fields));
  return next;
}

function resolveArguments(workflowOrOptions, nodeId, mode, options) {
  if (workflowOrOptions && workflowOrOptions.workflow && typeof workflowOrOptions.workflow === "object") {
    const { workflow, nodeId: targetId, mode: targetMode, options: nestedOptions, ...rest } = workflowOrOptions;
    return { workflow, nodeId: targetId, mode: targetMode, options: { ...rest, ...(nestedOptions || {}) } };
  }
  return { workflow: workflowOrOptions, nodeId, mode, options: options || {} };
}

/**
 * Return a workflow with exactly one node changed to Agent or collaboration.
 * The input workflow and backup map are never mutated. Shared node fields stay
 * on the currently edited node while type-specific fields come from a preset
 * or the mode backup.
 */
export function switchWorkflowNode(workflowOrOptions, nodeId, mode, options = {}) {
  const args = resolveArguments(workflowOrOptions, nodeId, mode, options);
  const workflow = args.workflow;
  const targetId = args.nodeId;
  const targetMode = args.mode;
  const opts = args.options || {};
  if (!workflow || !Array.isArray(workflow.nodes)) throw new TypeError("workflow.nodes must be an array");
  if (!["agent", "collaboration"].includes(targetMode)) throw new Error(`Unsupported node mode: ${targetMode}`);
  const index = workflow.nodes.findIndex(node => node?.id === targetId);
  if (index < 0) throw new Error(`Unknown workflow node: ${targetId}`);

  const current = workflow.nodes[index];
  const workflowKey = opts.workflowKey || workflow.key || workflow.id || "workflow";
  const currentMode = modeOf(current);
  if (currentMode === targetMode) {
    return { workflow: clone(workflow), node: clone(current), nodeModeBackups: clone(opts.nodeModeBackups || {}) };
  }
  const backups = ensureBackupPath(opts.nodeModeBackups, workflowKey, targetId);
  if (currentMode && currentMode !== targetMode && ["agent", "collaboration"].includes(currentMode)) {
    backups[workflowKey][targetId][currentMode] = clone(current);
  }

  const modeBackups = backups[workflowKey][targetId];
  let nextNode;
  if (targetMode === "collaboration") {
    const preset = opts.preset || opts.collaborationPreset || workflow.collaborationPresets?.[targetId];
    const restored = modeBackups.collaboration;
    const source = restored || preset;
    if (!source?.team || source.team.schemaVersion !== 2 || source.team.protocol !== "collaboration") {
      throw new Error(`Missing collaboration preset for workflow node ${targetId}`);
    }
    const team = clone(source.team);
    if (!restored && currentMode === "agent") {
      const memberId = team.outputOwners?.narrative || team.stageOwnerId;
      const member = team.members?.find(entry => entry.id === memberId);
      if (member) member.modelId = current.modelId || null;
    }
    nextNode = replaceTypeFields(current, {
      team,
      promptFile: source.promptFile ?? null,
      ...(Object.prototype.hasOwnProperty.call(source, "prompt") ? { prompt: source.prompt } : {}),
    }, COLLABORATION_FIELDS);
    nextNode.type = "team";
    delete nextNode.agentId;
    delete nextNode.modelId;
  } else {
    const baseNode = opts.baseNode || opts.catalogBaseNode;
    const source = modeBackups.agent || (baseNode?.type === "agent" ? baseNode : null) || (currentMode === "agent" ? current : null);
    if (!source) throw new Error(`Missing Agent backup for workflow node ${targetId}`);
    nextNode = replaceTypeFields(current, source, AGENT_FIELDS);
    nextNode.type = "agent";
    delete nextNode.team;
  }

  const nextWorkflow = clone(workflow);
  nextWorkflow.nodes[index] = nextNode;
  return { workflow: nextWorkflow, node: nextNode, nodeModeBackups: backups };
}

export const switchWorkflowNodeMode = switchWorkflowNode;
export const switchNodeMode = switchWorkflowNode;
export const switchWorkflowNodeType = switchWorkflowNode;
export const applyCollaborationPreset = (workflow, nodeId, preset, options = {}) =>
  switchWorkflowNode(workflow, nodeId, "collaboration", { ...options, preset });
export const getWorkflowNodeMode = modeOf;

export function collaborationModeOptions(node, preset) {
  const hasPreset = Boolean(preset?.team?.schemaVersion === 2 && preset.team.protocol === "collaboration");
  return [
    { value: "agent", label: "Agent" },
    ...(hasPreset ? [{ value: "collaboration", label: "协作团队" }] : []),
  ];
}
