export const NONE_OPTION_ID = "none";
export const CUSTOM_OPTION_ID = "custom";

function groupsOf(controls) {
  return Array.isArray(controls?.groups) ? controls.groups : [];
}

function selectionPointer(groupId, field) {
  return `/selections/${groupId}/${field}`;
}

function optionFor(group, optionId) {
  const options = Array.isArray(group?.options) ? group.options : [];
  return options.find(option => option.id === optionId)
    || options.find(option => option.id === NONE_OPTION_ID)
    || options[0]
    || { id: NONE_OPTION_ID, content: "" };
}

export function selectionsFromValues(controls, values = {}) {
  return Object.fromEntries(groupsOf(controls).map(group => {
    const optionId = values[selectionPointer(group.id, "optionId")];
    const customText = values[selectionPointer(group.id, "customText")];
    const firstOptionId = Array.isArray(group.options) && group.options[0]?.id
      ? group.options[0].id
      : NONE_OPTION_ID;
    return [group.id, {
      optionId: typeof optionId === "string" && optionId ? optionId : firstOptionId,
      customText: typeof customText === "string" ? customText : "",
    }];
  }));
}

export function valuesFromSelections(controls, selections = {}) {
  const values = {};
  for (const group of groupsOf(controls)) {
    const selection = selections[group.id] || {};
    values[selectionPointer(group.id, "optionId")] = typeof selection.optionId === "string" && selection.optionId
      ? selection.optionId
      : NONE_OPTION_ID;
    values[selectionPointer(group.id, "customText")] = typeof selection.customText === "string"
      ? selection.customText
      : "";
  }
  return values;
}

export function composePromptPreview(controls, selections = {}) {
  return groupsOf(controls).flatMap(group => {
    const selection = selections[group.id] || {};
    const option = optionFor(group, selection.optionId);
    const content = option.id === CUSTOM_OPTION_ID ? selection.customText : option.content;
    if (typeof content !== "string" || !content.trim()) return [];
    return [{ id: group.id, title: group.title || group.id, content: content.trim() }];
  });
}
