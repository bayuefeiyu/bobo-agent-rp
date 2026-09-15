const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const INPUT_ADAPTERS = new Set(["natural-language-v1", "memory-request-v1"]);

const PHASE_POOLS = [
  "preparation",
  "base-assistance",
  "discussion",
  "supplemental-assistance",
  "coordination",
  "closing",
  "draft",
  "review",
  "revision",
  "references",
  "retries",
];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must be a filesystem-safe ID.`);
  return value;
}

function positiveInteger(value, fallback, maximum = 1000) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function member(value, role, index = null) {
  const label = index === null ? `team.${role}` : `team.${role}[${index}]`;
  const input = object(value, label);
  const memberId = id(input.id || role, `${label}.id`);
  const agentId = id(input.agentId, `${label}.agentId`);
  const modelId = typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : null;
  return {
    id: memberId,
    role,
    agentId,
    modelId,
    focus: typeof input.focus === "string" ? input.focus.trim() : "",
    prompt: typeof input.prompt === "string" ? input.prompt.trim() : "",
  };
}

function publicDescription(value, label) {
  const input = object(value, label);
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : label,
    purpose: typeof input.purpose === "string" ? input.purpose.trim() : "",
    limitations: typeof input.limitations === "string" ? input.limitations.trim() : "",
    requestExample: typeof input.requestExample === "string" ? input.requestExample.trim() : "",
  };
}

function ability(value, label, { required = false } = {}) {
  const input = object(value, label);
  const kind = input.kind;
  if (!["workflow", "agent", "tool"].includes(kind)) throw new Error(`${label}.kind is unsupported.`);
  const inputAdapter = id(input.inputAdapter || "natural-language-v1", `${label}.inputAdapter`);
  if (!INPUT_ADAPTERS.has(inputAdapter)) throw new Error(`${label}.inputAdapter is unsupported.`);
  const result = {
    id: id(input.id, `${label}.id`),
    enabled: input.enabled !== false,
    required,
    kind,
    budgetPool: id(input.budgetPool || (required ? "base-assistance" : "supplemental-assistance"), `${label}.budgetPool`),
    inputAdapter,
    fixedArguments: input.fixedArguments === undefined ? {} : structuredClone(object(input.fixedArguments, `${label}.fixedArguments`)),
    documents: input.documents === undefined ? {} : structuredClone(object(input.documents, `${label}.documents`)),
    exports: Array.isArray(input.exports) ? input.exports.map((entry, index) => id(entry, `${label}.exports[${index}]`)) : [],
    publicDescription: publicDescription(input.publicDescription || { title: input.id }, `${label}.publicDescription`),
    timeoutMs: positiveInteger(input.timeoutMs, 120000, 3600000),
  };
  if (kind === "workflow") {
    if (typeof input.target !== "string" || input.target.split("/").length !== 2) throw new Error(`${label}.target must be a module/workflow reference.`);
    result.target = input.target;
  } else if (kind === "agent") {
    result.agentId = id(input.agentId, `${label}.agentId`);
    result.modelId = typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : null;
    result.prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  } else {
    result.adapter = id(input.adapter, `${label}.adapter`);
  }
  return result;
}

function budgets(value, memberCount) {
  const input = value === undefined ? {} : object(value, "team.budgets");
  const defaults = {
    preparation: Math.max(3, memberCount + 2),
    "base-assistance": 1,
    discussion: Math.max(4, memberCount * 4),
    "supplemental-assistance": 4,
    coordination: 6,
    closing: Math.max(2, memberCount),
    draft: 1,
    review: Math.max(2, memberCount),
    revision: 1,
    references: 1,
    retries: 3,
  };
  return Object.fromEntries(PHASE_POOLS.map(pool => {
    const raw = input[pool];
    const calls = raw && typeof raw === "object" ? raw.calls : raw;
    return [pool, { calls: positiveInteger(calls, defaults[pool], 10000) }];
  }));
}

export function normalizeTeamDefinition(value) {
  const input = object(value, "team");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error("team.schemaVersion must be 1.");
  const leader = member(input.leader, "leader");
  const secretary = member(input.secretary, "secretary");
  const experts = input.experts === undefined ? [] : (() => {
    if (!Array.isArray(input.experts)) throw new Error("team.experts must be an array.");
    return input.experts.map((entry, index) => member(entry, "expert", index));
  })();
  const members = [leader, ...experts, secretary];
  const memberIds = members.map(entry => entry.id);
  if (new Set(memberIds).size !== memberIds.length) throw new Error("team member IDs must be unique.");

  const assistants = input.assistants === undefined ? [] : (() => {
    if (!Array.isArray(input.assistants)) throw new Error("team.assistants must be an array.");
    return input.assistants.map((entry, index) => ability(entry, `team.assistants[${index}]`));
  })();
  const baseRetrieval = input.baseRetrieval === undefined || input.baseRetrieval === null
    ? null
    : ability(input.baseRetrieval, "team.baseRetrieval", { required: true });
  const abilityIds = [...assistants, ...(baseRetrieval ? [baseRetrieval] : [])].map(entry => entry.id);
  if (new Set(abilityIds).size !== abilityIds.length) throw new Error("team ability IDs must be unique, including baseRetrieval.");

  const agendaInput = input.agenda === undefined ? {} : object(input.agenda, "team.agenda");
  const normalRounds = positiveInteger(agendaInput.normalRounds, 2, 20);
  const maxRounds = Math.max(normalRounds, positiveInteger(agendaInput.maxRounds, 4, 20));
  const agenda = {
    normalRounds,
    maxRounds,
    assistantConcurrency: positiveInteger(agendaInput.assistantConcurrency, 2, 16),
    speechCharacterTarget: positiveInteger(agendaInput.speechCharacterTarget, 4000, 30000),
    referenceDocumentCharacterTarget: positiveInteger(agendaInput.referenceDocumentCharacterTarget, 3000, 30000),
    referenceTotalCharacterTarget: positiveInteger(agendaInput.referenceTotalCharacterTarget, 16000, 100000),
  };
  const deliverablesInput = input.deliverables === undefined ? {} : object(input.deliverables, "team.deliverables");
  const deliverables = {
    report: typeof deliverablesInput.report === "string" && deliverablesInput.report.trim() ? deliverablesInput.report.trim() : "deliverables/report.json",
    references: typeof deliverablesInput.references === "string" && deliverablesInput.references.trim() ? deliverablesInput.references.trim() : "deliverables/references.json",
  };
  for (const [key, path] of Object.entries(deliverables)) {
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error(`team.deliverables.${key} must be a safe relative path.`);
  }
  return {
    schemaVersion: 1,
    leader,
    secretary,
    experts,
    members,
    assistants,
    baseRetrieval,
    agenda,
    budgets: budgets(input.budgets, members.length),
    deliverables,
  };
}

export function teamAbilityCatalog(team) {
  return team.assistants.filter(entry => entry.enabled).map(entry => ({ id: entry.id, ...entry.publicDescription }));
}

export function minimumTeamCalls(team) {
  const expertCount = team.experts.length;
  return {
    preparation: 3 + expertCount,
    "base-assistance": team.baseRetrieval ? 1 : 0,
    discussion: team.agenda.normalRounds * (1 + expertCount),
    coordination: team.agenda.maxRounds,
    closing: 1 + expertCount,
    draft: 1,
    review: 1 + expertCount,
    revision: 1,
    references: 0,
  };
}

export function validateTeamBudgets(team) {
  const required = minimumTeamCalls(team);
  const shortages = Object.entries(required).filter(([pool, calls]) => team.budgets[pool]?.calls < calls);
  if (shortages.length) throw new Error(`Team budgets cannot cover required phases: ${shortages.map(([pool, calls]) => `${pool} requires ${calls}`).join(", ")}.`);
  return true;
}

export { PHASE_POOLS };
