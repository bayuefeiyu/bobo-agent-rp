const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MODULE_FIELDS = [
  "schemaVersion",
  "id",
  "moduleKind",
  "basedOn",
  "title",
  "description",
  "surface",
  "contextOrder",
  "displayOrder",
  "dataContractFile",
  "resourceCatalogFile",
  "frontendViewFile",
  "skillFile",
  "workflowFiles",
].sort();

function assertRelativeFile(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty relative path.`);
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.split("/").some(part => part === ".." || part === "")) {
    throw new Error(`${label} must stay inside the module directory.`);
  }
  return path;
}

export function normalizeFeatureModuleManifest(value, label = "feature module") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  const fields = Object.keys(value).sort();
  if (fields.length !== MODULE_FIELDS.length || MODULE_FIELDS.some((field, index) => fields[index] !== field)) {
    throw new Error(`${label} must use the exact schemaVersion 6 field set.`);
  }
  if (value.schemaVersion !== 6 || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw new Error(`Invalid ${label} definition.`);
  if (!["data", "resource", "hybrid"].includes(value.moduleKind)) throw new Error(`${label}.moduleKind must be data, resource, or hybrid.`);
  if (value.basedOn !== null && (typeof value.basedOn !== "string" || !ID_PATTERN.test(value.basedOn))) throw new Error(`${label}.basedOn must be null or a safe module ID.`);
  if (typeof value.title !== "string" || !value.title.trim()) throw new Error(`${label}.title must be non-empty.`);
  if (typeof value.description !== "string") throw new Error(`${label}.description must be a string.`);
  if (!["frontend", "background"].includes(value.surface)) throw new Error(`${label}.surface must be frontend or background.`);
  if (!Number.isSafeInteger(value.contextOrder) || !Number.isSafeInteger(value.displayOrder)) throw new Error(`${label} must declare integer contextOrder and displayOrder values.`);
  const hasData = value.moduleKind === "data" || value.moduleKind === "hybrid";
  const hasResources = value.moduleKind === "resource" || value.moduleKind === "hybrid";
  if (hasData !== (typeof value.dataContractFile === "string")) throw new Error(`${label}.dataContractFile must match moduleKind ${value.moduleKind}.`);
  if (hasResources !== (typeof value.resourceCatalogFile === "string")) throw new Error(`${label}.resourceCatalogFile must match moduleKind ${value.moduleKind}.`);
  if (value.surface === "frontend" && !hasData) throw new Error(`${label} resource-only modules must use background surface.`);
  if ((value.surface === "frontend") !== (typeof value.frontendViewFile === "string")) throw new Error(`${label}.frontendViewFile must be present exactly for frontend modules.`);
  if (!Array.isArray(value.workflowFiles) || value.workflowFiles.length === 0) throw new Error(`${label}.workflowFiles must contain at least one owned workflow.`);
  const workflowFiles = value.workflowFiles.map((path, index) => assertRelativeFile(path, `${label}.workflowFiles[${index}]`));
  if (new Set(workflowFiles).size !== workflowFiles.length) throw new Error(`${label}.workflowFiles must not contain duplicates.`);
  return {
    schemaVersion: 6,
    id: value.id,
    moduleKind: value.moduleKind,
    basedOn: value.basedOn,
    title: value.title.trim(),
    description: value.description.trim(),
    surface: value.surface,
    contextOrder: value.contextOrder,
    displayOrder: value.displayOrder,
    dataContractFile: hasData ? assertRelativeFile(value.dataContractFile, `${label}.dataContractFile`) : null,
    resourceCatalogFile: hasResources ? assertRelativeFile(value.resourceCatalogFile, `${label}.resourceCatalogFile`) : null,
    frontendViewFile: value.surface === "frontend" ? assertRelativeFile(value.frontendViewFile, `${label}.frontendViewFile`) : null,
    skillFile: assertRelativeFile(value.skillFile, `${label}.skillFile`),
    workflowFiles,
  };
}
