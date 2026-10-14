import { assertCollaborationContextFits } from "./rp-team-shared-context.mjs";

const PROTOCOL = new Set(["rp_team_handoff", "rp_task_next", "rp_node_complete"]);

export function assertCollaborationToolMessage(messages) {
  const last = [...messages].reverse().find(message => message.role === "assistant");
  const calls = last?.content?.filter(part => part.type === "toolCall") || [];
  if (calls.length > 1 && calls.some(call => PROTOCOL.has(call.name))) throw new Error("Call rp_team_handoff, rp_task_next or rp_node_complete alone in a separate tool-call message.");
}

// Pi context extension errors are logged and ignored. Guard the actual Agent
// transform instead, after extensions have supplied the every-call model tail.
export function installCollaborationContextGuard(agent, model, beforeDispatch = async () => {}) {
  const previous = agent.transformContext;
  const guard = { error: null };
  agent.transformContext = async function (messages, signal) {
    if (guard.error) throw guard.error;
    const transformed = previous ? await previous.call(this, messages, signal) : messages;
    try {
      assertCollaborationContextFits(agent.state.systemPrompt + JSON.stringify(transformed), model);
      await beforeDispatch();
    } catch (error) { guard.error = error; throw error; }
    return transformed;
  };
  return guard;
}
