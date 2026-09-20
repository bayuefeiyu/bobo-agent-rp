import { agentFiles } from "./rp-agent-files.mjs";
import { resolve, sep } from "node:path";

const response = details => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details });

/** Pure registration shared by the bridge and offline Pi integration tests. */
export function registerAgentDeliveryTools(pi, delivery, { currentMessages }, Type) {
  const object = properties => Type.Object(properties, { additionalProperties: false });
  const path = Type.String({ minLength: 1, maxLength: 500 });
  pi.registerTool({
    name: "rp_deliver", label: "Deliver artifact", executionMode: "sequential",
    description: "Submit one declared artifact by output ID and actual workspace-relative path. Validates and copies to its formal path. Success means format checks passed, not content quality. Does not end the node. Redeliver to update a version.",
    parameters: object({ output: Type.Union(Object.keys(delivery.contract.outputs).map(id => Type.Literal(id))), path }),
    async execute(_id, params) { return response(await delivery.deliver(params)); },
  });
  pi.registerTool({
    name: "rp_node_complete", label: "Complete node", executionMode: "sequential",
    description: "After receiving successful delivery receipts for every required output and finishing your task, call this tool alone once. Accepts completion only if deliveries remain valid; success ends model work without another reply.",
    parameters: object({}),
    async execute() {
      const last = [...currentMessages()].reverse().find(message => message.role === "assistant");
      const calls = last?.content?.filter(part => part.type === "toolCall") || [];
      if (calls.length !== 1 || calls[0].name !== "rp_node_complete") throw new Error("Call rp_node_complete alone, in a new message after receiving delivery receipts.");
      return { ...response(await delivery.complete()), terminate: true };
    },
  });
  pi.registerTool({
    name: "rp_files", label: "Workspace files", executionMode: "sequential",
    description: "List files inside this node workspace, or count a text file. Counts are informational, never quality or length requirements. Inputs are read-only. No shell, rename or delete actions.",
    parameters: object({ action: Type.Union([Type.Literal("list"), Type.Literal("count")]), path: Type.Optional(path), recursive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
    async execute(_id, params) { return response(await agentFiles(delivery, params)); },
  });
  pi.on("tool_call", async event => {
    if (delivery.completed) return { block: true, terminate: true, reason: "Node completion has already been accepted." };
    if (event.toolName === "read" && typeof event.input?.path === "string" && resolve(event.input.path).split(sep).some(part => part.toLowerCase() === ".rp-delivery")) {
      return { block: true, reason: "Delivery staging and receipts are runtime-private." };
    }
    // Preserve existing read access to authored module Skills/static references. The bridge
    // separately blocks prompt-source reads. Newly defaulted writes stay workspace-scoped.
    if (["write", "edit"].includes(event.toolName)) {
      try { await delivery.access(event.input?.path, event.toolName !== "read"); }
      catch (error) { return { block: true, reason: error.message }; }
    }
  });
}
