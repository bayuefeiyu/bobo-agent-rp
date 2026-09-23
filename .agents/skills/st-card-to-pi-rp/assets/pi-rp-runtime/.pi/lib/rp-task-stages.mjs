import { createHash } from "node:crypto";

const STAGE_MARKER = /^\s*<!--\s*stage\s*-->\s*$/i;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

function taskFailure(message) {
  return Object.assign(new Error(message), { code: "workflow_configuration_invalid" });
}

function stageMessage(number, content) {
  return `【当前任务阶段 ${number}】\n${content.trim()}`;
}

export function parseTaskStages(source, label = "node task prompt") {
  const text = String(source || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = text.split("\n");
  const markers = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opening = line.match(FENCE_OPEN);
    if (fence) {
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    if (STAGE_MARKER.test(line)) markers.push(index);
  }
  if (!markers.length) {
    return Object.freeze({ staged: false, common: "", stages: Object.freeze([text]), initialText: text, sourceHash: taskSourceHash(text) });
  }
  const common = lines.slice(0, markers[0]).join("\n").trim();
  const stages = markers.map((marker, index) => {
    const end = markers[index + 1] ?? lines.length;
    const content = lines.slice(marker + 1, end).join("\n").trim();
    if (!content) throw taskFailure(`${label} contains an empty task stage after line ${marker + 1}.`);
    return content;
  });
  const initialText = [common, stageMessage(1, stages[0])].filter(Boolean).join("\n\n");
  return Object.freeze({
    staged: true,
    common,
    stages: Object.freeze(stages),
    initialText,
    sourceHash: taskSourceHash(text),
  });
}

export function taskSourceHash(source) {
  return `sha256:${createHash("sha256").update(String(source || ""), "utf8").digest("hex")}`;
}

export function createTaskStageController(plan, { now = () => new Date().toISOString() } = {}) {
  if (!plan || !Array.isArray(plan.stages) || !plan.stages.length) throw taskFailure("Task stage plan must contain at least one stage.");
  let currentIndex = 0;
  let exhausted = plan.staged !== true;
  const calls = new Map();
  const events = plan.staged ? [{ type: "stage-issued", stage: 1, at: now() }] : [];

  return Object.freeze({
    get staged() { return plan.staged === true; },
    get exhausted() { return exhausted; },
    get currentStage() { return currentIndex + 1; },
    get events() { return structuredClone(events); },
    reminder() {
      return plan.staged && !exhausted
        ? `当前分阶段任务尚未全部发放。继续完成阶段 ${currentIndex + 1}；完成后单独调用 rp_task_next({})。`
        : null;
    },
    assertExhausted() {
      if (plan.staged && !exhausted) {
        throw Object.assign(new Error("Task stages remain. Complete the current stage, then call rp_task_next alone until it reports that all stages were issued."), { code: "task_stages_incomplete" });
      }
    },
    async advance(callId, deliver = async () => {}) {
      if (typeof callId !== "string" || !callId) throw new Error("Task stage tool call ID is required.");
      if (calls.has(callId)) return structuredClone(calls.get(callId));
      let result;
      if (exhausted) {
        result = { status: "all_stages_issued", instruction: "Confirm required artifacts are delivered, then call rp_node_complete alone." };
      } else if (currentIndex + 1 < plan.stages.length) {
        const nextIndex = currentIndex + 1;
        const message = stageMessage(nextIndex + 1, plan.stages[nextIndex]);
        await deliver(message);
        currentIndex = nextIndex;
        result = { status: "next_stage_scheduled", stage: currentIndex + 1 };
        events.push({ type: "stage-issued", stage: currentIndex + 1, callId, at: now() });
      } else {
        exhausted = true;
        result = { status: "all_stages_issued", instruction: "Confirm required artifacts are delivered, then call rp_node_complete alone." };
        events.push({ type: "stages-exhausted", stage: currentIndex + 1, callId, at: now() });
      }
      calls.set(callId, result);
      return structuredClone(result);
    },
  });
}

export function registerTaskStageTool(pi, controller, { currentMessages, enqueueStage }, Type) {
  const response = details => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details });
  pi.registerTool({
    name: "rp_task_next",
    label: "Continue staged task",
    executionMode: "sequential",
    description: "After finishing the current task stage, call this tool alone. It schedules the next stage after this tool result, or reports that all stages were issued. It does not judge whether the current stage was completed well.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(id) {
      const last = [...currentMessages()].reverse().find(message => message.role === "assistant");
      const calls = last?.content?.filter(part => part.type === "toolCall") || [];
      if (calls.length !== 1 || calls[0].name !== "rp_task_next") throw new Error("Call rp_task_next alone after finishing the current task stage.");
      return response(await controller.advance(id, message => enqueueStage(message)));
    },
  });
}
