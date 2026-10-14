const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TOOLS = new Set(["read", "write", "edit", "rp_files", "rp_call"]);
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const identity = (value, label) => {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a safe ID.`);
  return value;
};
export function normalizeCollaborationTeam(value) {
  const input = object(value, "team");
  if (input.schemaVersion !== 2 || input.protocol !== "collaboration") throw new Error("Collaboration teams require schemaVersion 2 and protocol collaboration.");
  if (input.leader || input.secretary || input.experts || input.agenda || input.baseRetrieval || input.assistants?.length) throw new Error("Collaboration teams cannot declare meeting-only fields.");
  if (!Array.isArray(input.members) || input.members.length < 2) throw new Error("Collaboration teams require at least two members.");
  const members = input.members.map((raw, index) => {
    const entry = object(raw, `team.members[${index}]`);
    const id = identity(entry.id, "member.id");
    if (typeof entry.agentId !== "string" || entry.agentId.split("/").length !== 2 || !entry.agentId.split("/").every(part => ID.test(part))) throw new Error("member.agentId must be module-id/agent-id.");
    if (!Array.isArray(entry.tools) || entry.tools.some(tool => !TOOLS.has(tool))) throw new Error("member.tools contains an unsupported collaboration tool.");
    return { id, label: typeof entry.label === "string" ? entry.label : id, role: "collaborator", agentId: entry.agentId, tools: [...new Set(entry.tools)], prompt: typeof entry.prompt === "string" ? entry.prompt : "", focus: typeof entry.focus === "string" ? entry.focus : "" };
  });
  const ids = new Set(members.map(member => member.id));
  if (new Set(members.map(member => member.id.toLowerCase())).size !== members.length) throw new Error("team member IDs must be unique, including case-insensitive workspace paths.");
  const reference = (value, label) => {
    if (!ids.has(value)) throw new Error(`${label} must reference a team member.`);
    return value;
  };
  const owners = object(input.outputOwners, "team.outputOwners");
  const outputOwners = Object.fromEntries(Object.entries(owners).map(([id, owner]) => [identity(id, "output ID"), reference(owner, "output owner")]));
  const limits = object(input.limits || {}, "team.limits");
  const limit = (name, fallback) => {
    const value = limits[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error(`team.limits.${name} must be between 1 and 10000.`);
    return value;
  };
  return { schemaVersion: 2, protocol: "collaboration", members, initialMemberId: reference(input.initialMemberId, "initialMemberId"), stageOwnerId: reference(input.stageOwnerId, "stageOwnerId"), completionMemberId: reference(input.completionMemberId, "completionMemberId"), outputOwners, limits: { maxActivations: limit("maxActivations", 32), maxToolCalls: limit("maxToolCalls", 128), maxProtocolReminders: limit("maxProtocolReminders", 2) }, assistants: [], baseRetrieval: null };
}

export function validateCollaborationOutputs(team, node) {
  const generated = node.metadata?.documentWorkspaceSnapshot?.output;
  for (const id of Object.keys(node.outputs || {})) {
    if (id !== generated && !team.outputOwners[id]) throw new Error(`Collaboration output ${id} needs an owner.`);
  }
  for (const id of Object.keys(team.outputOwners)) {
    if (!node.outputs?.[id] || id === generated) throw new Error(`Unknown or runtime-generated collaboration output ${id}.`);
    const owner = team.members.find(member => member.id === team.outputOwners[id]);
    if (!owner.tools.includes("write")) throw new Error(`Owner of ${id} requires write permission.`);
  }
  if (node.requiredCalls?.length && !team.members.some(member => member.tools.includes("rp_call"))) throw new Error("Required collaboration calls need an authorized member.");
}
