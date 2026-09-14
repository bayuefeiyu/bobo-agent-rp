const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const READ_POLICIES = new Set(["required", "conditional", "choice", "optional"]);
const AUTHORITIES = new Set(["binding", "canonical", "advisory", "exploratory"]);
const PHASES = new Set(["analysis", "retrieval", "planning", "writing", "checking", "archiving"]);
const SELECTION_MODES = new Set(["one", "at-most-one", "one-or-more", "any"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || expected.some((field, index) => actual[index] !== field)) {
    throw new Error(`${label} must use the exact field set.`);
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must be a safe ID.`);
  return value;
}

function text(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`${label} must be ${empty ? "a" : "a non-empty"} string.`);
  return value.trim();
}

function strings(value, label, { ids = false, allowed = null } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map((item, index) => ids ? id(item, `${label}[${index}]`) : text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  if (allowed && result.some(item => !allowed.has(item))) throw new Error(`${label} contains an unsupported value.`);
  return result;
}

function relativeDocumentPath(value, label) {
  const path = text(value, label).replaceAll("\\", "/");
  if (!path.startsWith("documents/") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(part => !part || part === "..") || !path.toLowerCase().endsWith(".md")) {
    throw new Error(`${label} must be a safe Markdown path below documents/.`);
  }
  return path;
}

export function normalizeResourceCatalog(value, expectedModuleId = null) {
  const input = object(value, "resource catalog");
  exactFields(input, ["schemaVersion", "moduleId", "categories", "selectionGroups", "documents"], "resource catalog");
  if (input.schemaVersion !== 1) throw new Error("resource catalog schemaVersion must be 1.");
  const moduleId = id(input.moduleId, "resource catalog moduleId");
  if (expectedModuleId && moduleId !== expectedModuleId) throw new Error(`Resource catalog moduleId must be ${expectedModuleId}.`);

  const categories = Object.fromEntries(Object.entries(object(input.categories, "resource catalog categories")).map(([categoryId, raw]) => {
    id(categoryId, "resource catalog category ID");
    const category = object(raw, `resource catalog categories.${categoryId}`);
    exactFields(category, ["title", "description"], `resource catalog categories.${categoryId}`);
    return [categoryId, { title: text(category.title, `category ${categoryId}.title`), description: text(category.description, `category ${categoryId}.description`, { empty: true }) }];
  }));
  if (!Object.keys(categories).length) throw new Error("A resource catalog requires at least one category.");

  const selectionGroups = Object.fromEntries(Object.entries(object(input.selectionGroups, "resource catalog selectionGroups")).map(([groupId, raw]) => {
    id(groupId, "resource catalog selection group ID");
    const group = object(raw, `resource catalog selectionGroups.${groupId}`);
    exactFields(group, ["title", "mode", "instruction", "fallback"], `resource catalog selectionGroups.${groupId}`);
    if (!SELECTION_MODES.has(group.mode)) throw new Error(`Selection group ${groupId}.mode is unsupported.`);
    return [groupId, {
      title: text(group.title, `selection group ${groupId}.title`),
      mode: group.mode,
      instruction: text(group.instruction, `selection group ${groupId}.instruction`),
      fallback: group.fallback === null ? null : id(group.fallback, `selection group ${groupId}.fallback`),
    }];
  }));

  if (!Array.isArray(input.documents)) throw new Error("resource catalog documents must be an array.");
  const seenIds = new Set();
  const seenPaths = new Set();
  const documents = input.documents.map((raw, index) => {
    const document = object(raw, `resource catalog documents[${index}]`);
    exactFields(document, ["id", "path", "title", "summary", "categories", "subcategory", "readPolicy", "authority", "appliesAt", "priority", "selectionGroup", "readWhen", "perspective", "aliases", "related", "sources"], `resource catalog documents[${index}]`);
    const documentId = id(document.id, `resource catalog documents[${index}].id`);
    const path = relativeDocumentPath(document.path, `resource catalog documents[${index}].path`);
    if (seenIds.has(documentId) || seenPaths.has(path)) throw new Error(`Resource catalog contains a duplicate document ID or path: ${documentId}.`);
    seenIds.add(documentId);
    seenPaths.add(path);
    const documentCategories = strings(document.categories, `document ${documentId}.categories`, { ids: true });
    if (!documentCategories.length || documentCategories.some(category => !categories[category])) throw new Error(`Document ${documentId} must reference declared categories.`);
    if (!READ_POLICIES.has(document.readPolicy)) throw new Error(`Document ${documentId}.readPolicy is unsupported.`);
    if (!AUTHORITIES.has(document.authority)) throw new Error(`Document ${documentId}.authority is unsupported.`);
    const selectionGroup = document.selectionGroup === null ? null : id(document.selectionGroup, `document ${documentId}.selectionGroup`);
    if ((document.readPolicy === "choice") !== Boolean(selectionGroup)) throw new Error(`Document ${documentId} must declare selectionGroup exactly when readPolicy is choice.`);
    if (selectionGroup && !selectionGroups[selectionGroup]) throw new Error(`Document ${documentId} references unknown selection group ${selectionGroup}.`);
    if (!Number.isSafeInteger(document.priority)) throw new Error(`Document ${documentId}.priority must be an integer.`);
    return {
      id: documentId,
      path,
      title: text(document.title, `document ${documentId}.title`),
      summary: text(document.summary, `document ${documentId}.summary`),
      categories: documentCategories,
      subcategory: document.subcategory === null ? null : id(document.subcategory, `document ${documentId}.subcategory`),
      readPolicy: document.readPolicy,
      authority: document.authority,
      appliesAt: strings(document.appliesAt, `document ${documentId}.appliesAt`, { ids: true, allowed: PHASES }),
      priority: document.priority,
      selectionGroup,
      readWhen: strings(document.readWhen, `document ${documentId}.readWhen`),
      perspective: text(document.perspective, `document ${documentId}.perspective`),
      aliases: strings(document.aliases, `document ${documentId}.aliases`),
      related: strings(document.related, `document ${documentId}.related`, { ids: true }),
      sources: strings(document.sources, `document ${documentId}.sources`),
    };
  });
  for (const document of documents) {
    if (document.related.some(related => !seenIds.has(related))) throw new Error(`Document ${document.id} references an unknown related document.`);
  }
  for (const [groupId, group] of Object.entries(selectionGroups)) {
    const members = documents.filter(document => document.selectionGroup === groupId);
    if (!members.length) throw new Error(`Selection group ${groupId} has no document members.`);
    if (group.fallback && !members.some(document => document.id === group.fallback)) throw new Error(`Selection group ${groupId}.fallback must name one of its members.`);
  }
  return { schemaVersion: 1, moduleId, categories, selectionGroups, documents };
}

export function selectResourceDocuments(catalog, requestedCategories) {
  const normalized = normalizeResourceCatalog(catalog, catalog?.moduleId);
  const categories = strings(requestedCategories, "requested resource categories", { ids: true });
  if (!categories.length) throw new Error("At least one resource category must be requested.");
  const unknown = categories.filter(category => !normalized.categories[category]);
  if (unknown.length) throw new Error(`Unknown resource categories: ${unknown.join(", ")}.`);
  const requested = new Set(categories);
  return {
    categories,
    documents: normalized.documents.filter(document => document.categories.some(category => requested.has(category)))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)),
  };
}
