import { executeImageOperation, finalizePreparedImageOperation } from "../image-execution.mjs";

export async function execute({ run, data, services }) {
  const resolved = run.nodes["resolve-input"].output;
  const generated = run.nodes["generate-content-prompts"].output;
  const prompts = Array.isArray(generated?.prompts) ? generated.prompts : [];
  const finalized = await finalizePreparedImageOperation({
    data,
    requestId: resolved.requestId,
    contentPrompts: prompts,
  });
  return executeImageOperation({ data, services, requestId: resolved.requestId, renders: finalized.renders });
}
