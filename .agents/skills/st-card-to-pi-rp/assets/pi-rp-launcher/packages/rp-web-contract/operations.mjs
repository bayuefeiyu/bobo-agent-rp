import definition from "./operations.json" with { type: "json" };
import schemas from "./schemas.json" with { type: "json" };
import { validateSchema } from "./index.mjs";

export const operations = definition.operations;
export const definitions = schemas.$defs;
export const matchOperation = (method, pathname) => operations.find(item => item.method === method && new RegExp("^" + item.path.split("/").map(part => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$").test(pathname));
export function validateOperationRequest(operation, value) {
  if (operation?.requestSchema) validateSchema(definitions[operation.requestSchema], value, "$request", definitions);
}
export function validateOperationResponse(operation, value) {
  if (operation?.responseSchema) validateSchema(definitions[operation.responseSchema], value, "$response", definitions);
}
