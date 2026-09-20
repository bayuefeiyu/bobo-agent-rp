import { parseRolePrompt, readPromptFile, selectPrompts } from "./rp-node-context.mjs";
import { renderCardText } from "./rp-card-text.mjs";

async function optionalPromptFile(root, path) {
  return readPromptFile(root, path).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function playPromptSources(active, profile, agent, node, workspace, tools) {
  const root = active.context.cwd;
  const card = active.cardDirectory;
  const fromCardOrRoot = async path => {
    const cardContent = await optionalPromptFile(card, path);
    return cardContent !== null ? cardContent : await optionalPromptFile(root, path);
  };
  const authored = (value, label) => renderCardText(value, active.playerName, label);
  const optionsText = await fromCardOrRoot("prompts/context-options.json");
  const options = optionsText ? JSON.parse(optionsText) : {};
  const roles = options.defaults || {};
  const baseTemplate = await fromCardOrRoot("prompts/system/base.md");
  if (!baseTemplate) throw new Error("Missing play prompt: prompts/system/base.md");
  const toolDescriptionsText = await fromCardOrRoot("prompts/system/tools.json");
  if (!toolDescriptionsText) throw new Error("Missing play prompt tool descriptions: prompts/system/tools.json");
  const toolDescriptions = JSON.parse(toolDescriptionsText);
  const toolList = tools.map(name => `- ${name}: ${authored(toolDescriptions[name] || "Available to this node.", `prompts/system/tools.json:${name}`)}`).join("\n") || "(none)";
  const baseSystem = authored(baseTemplate, "prompts/system/base.md").replace("{{AVAILABLE_TOOLS}}", () => toolList).replace("{{WORKSPACE}}", () => workspace.replaceAll("\\", "/"));
  const totalPrefix = parseRolePrompt(authored(await fromCardOrRoot("prompts/prefix/total.md") || "", "prompts/prefix/total.md"), roles.totalPrefixRole || "system");
  const totalTail = parseRolePrompt(authored(await fromCardOrRoot("prompts/tail/total.md") || "", "prompts/tail/total.md"), roles.totalTailRole || "user");
  const modelPrefixText = profile?.headPromptFile ? await fromCardOrRoot(profile.headPromptFile) : profile?.headPrompt || "";
  const modelTailText = profile?.tailPromptFile ? await fromCardOrRoot(profile.tailPromptFile) : profile?.tailPrompt || "";
  if (profile?.headPromptFile && modelPrefixText === null) throw new Error(`Missing model prefix prompt file: ${profile.headPromptFile}`);
  if (profile?.tailPromptFile && modelTailText === null) throw new Error(`Missing model tail prompt file: ${profile.tailPromptFile}`);
  const modelPrefix = parseRolePrompt(authored(modelPrefixText, profile?.headPromptFile || "model headPrompt"), roles.modelPrefixRole || "system");
  const modelTail = parseRolePrompt(authored(modelTailText, profile?.tailPromptFile || "model tailPrompt"), roles.modelTailRole || "user");
  const agentText = agent?.promptFile ? await fromCardOrRoot(agent.promptFile) : agent?.prompt || "";
  const nodeText = node.promptFile ? await fromCardOrRoot(node.promptFile) : node.prompt || node.description || "";
  if (agent?.promptFile && agentText === null) throw new Error(`Missing Agent prompt file: ${agent.promptFile}`);
  if (node.promptFile && nodeText === null) throw new Error(`Missing node prompt file: ${node.promptFile}`);
  return {
    baseSystem,
    prefix: selectPrompts(totalPrefix, modelPrefix, options.prefixExclusive === true),
    tail: selectPrompts(totalTail, modelTail, options.tailExclusive === true),
    agent: parseRolePrompt(authored(agentText, agent?.promptFile || "Agent prompt"), roles.agentRole || "system"),
    nodeText: authored(nodeText, node.promptFile || `node ${node.id} prompt`),
    roles,
    tailMode: options.tailMode === "every-call" ? "every-call" : "on-start",
  };
}
