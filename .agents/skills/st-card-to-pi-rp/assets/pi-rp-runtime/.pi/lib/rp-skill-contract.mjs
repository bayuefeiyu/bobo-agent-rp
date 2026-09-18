/**
 * Loadable Skill frontmatter contract.
 *
 * A card ships two kinds of Skill: feature-module skills (`module.json.skillFile`) and the
 * message-retrieval context skill (`manifest.context_skill`). Both are read at bridge startup, so a
 * missing or malformed header is a startup failure, not a runtime degradation. The card-pack
 * validator enforces the same rules in Python; keep the wording in
 * `references/validation.md` aligned with the errors thrown here.
 *
 * Only the two facts the runtime actually consumes are required: a one-line `name`, and a
 * non-empty one-line `description` that is injected into Agent context. Optional fields are
 * tolerated but not interpreted.
 */

const DESCRIPTION_LIMIT = 1024;

function frontmatterBlock(text, label) {
  if (typeof text !== "string") throw new Error(`${label} must be readable text.`);
  const normalized = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${label} must start with YAML frontmatter.`);
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${label} YAML frontmatter is not closed.`);
  const body = normalized.slice(4, end);
  const rest = normalized.slice(end + 4);
  if (rest && !rest.startsWith("\n")) throw new Error(`${label} YAML frontmatter closing delimiter is malformed.`);
  return body;
}

function scalarField(block, field) {
  const match = block.match(new RegExp(`^${field}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") return null;
  return raw.replace(/^(['"])(.*)\1$/, "$2").trim();
}

/** The single-line `description` a Skill publishes into Agent context. */
export function parseSkillFrontmatterDescription(text, label) {
  const block = frontmatterBlock(text, label);
  const name = scalarField(block, "name");
  if (!name) throw new Error(`${label} frontmatter must contain a one-line name.`);
  const description = scalarField(block, "description");
  if (!description) throw new Error(`${label} frontmatter must contain a one-line description.`);
  if (description.length > DESCRIPTION_LIMIT) throw new Error(`${label} frontmatter description must be at most ${DESCRIPTION_LIMIT} characters.`);
  return description;
}

/** Full loadability check; returns the parsed header or throws with the offending file label. */
export function assertLoadableSkill(text, label) {
  const description = parseSkillFrontmatterDescription(text, label);
  const name = scalarField(frontmatterBlock(text, label), "name");
  return { name, description };
}
