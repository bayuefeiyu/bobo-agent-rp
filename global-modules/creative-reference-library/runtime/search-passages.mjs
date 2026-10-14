import { exportReferences } from "./compose.mjs";
export async function execute({ run, workspace, services }) {
  const result = await services.referenceLibrary.searchPassages({ text: run.textInput || "", keywords: run.arguments?.keywords || [], budget: run.arguments?.budget || {} });
  return exportReferences(workspace, result);
}
