const CHARACTER_MACROS = ["{{char}}", "<char>", "<bot>"];
const LEGACY_USER_MACRO = "<user>";
const STRUCTURAL_FIELD = /(?:^id$|Id$|Ids$|Path$|File$|^path$|^file$|^source$|^target$|^recordType$|^collectionId$|^moduleId$)/;

export function renderCardText(value, playerName, source = "card text") {
  if (typeof value !== "string") throw new TypeError(`${source} must be text.`);
  if (typeof playerName !== "string" || !playerName.trim()) throw new Error(`A player name is required to render ${source}.`);
  const unresolved = CHARACTER_MACROS.find(macro => value.includes(macro)) || (value.includes(LEGACY_USER_MACRO) ? LEGACY_USER_MACRO : null);
  if (unresolved) throw new Error(`${source} contains ${unresolved}; resolve character names and normalize player macros during card conversion.`);
  return value.replaceAll("{{user}}", () => playerName);
}

export function renderCardTextValues(value, playerName, source = "card data") {
  if (typeof value === "string") return renderCardText(value, playerName, source);
  if (Array.isArray(value)) return value.map((item, index) => renderCardTextValues(item, playerName, `${source}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (["{{user}}", "{{char}}", "<user>", "<char>", "<bot>"].some(macro => key.includes(macro))) {
        throw new Error(`${source} has a macro in a structural key: ${key}`);
      }
      if (STRUCTURAL_FIELD.test(key) && typeof item === "string" && ["{{user}}", "{{char}}", "<user>", "<char>", "<bot>"].some(macro => item.includes(macro))) {
        throw new Error(`${source}.${key} has a macro in a structural field.`);
      }
      return [key, renderCardTextValues(item, playerName, `${source}.${key}`)];
    }));
  }
  return value;
}

export function renderTeamAuthorText(team, playerName, source = "team") {
  const result = structuredClone(team);
  for (const member of [result.leader, result.secretary, ...(result.experts || []), ...(result.members || [])].filter(Boolean)) {
    member.focus = renderCardText(member.focus || "", playerName, `${source}/${member.id} focus`);
    member.prompt = renderCardText(member.prompt || "", playerName, `${source}/${member.id} prompt`);
  }
  for (const ability of [...(result.assistants || []), ...(result.baseRetrieval ? [result.baseRetrieval] : [])]) {
    if (typeof ability.prompt === "string") ability.prompt = renderCardText(ability.prompt, playerName, `${source}/${ability.id} prompt`);
  }
  return result;
}
