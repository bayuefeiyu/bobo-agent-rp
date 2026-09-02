import { dataValueAt } from "./rp-data-index.mjs";
import { recordTypeDefinition } from "./rp-data-contracts.mjs";

function printable(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function renderDataRecordView(record, contract, viewId) {
  const definition = recordTypeDefinition(contract, record.collectionId, record.recordType);
  const view = definition.views[viewId];
  if (!view) throw new Error(`Record type ${record.recordType} does not define view ${viewId}.`);
  if (view.format === "text") {
    return view.fields.map(field => {
      const value = printable(dataValueAt(record, field.path));
      return field.label ? `${field.label}：${value}` : value;
    }).filter(Boolean).join(view.separator);
  }
  const result = {};
  for (const field of view.fields) {
    const key = field.label || field.path.split("/").at(-1);
    result[key] = structuredClone(dataValueAt(record, field.path));
  }
  return result;
}
