const TRANSITIONS = {
  pending: new Set(["submitting", "cancelled", "failed"]),
  submitting: new Set(["submitting", "submitted", "completed", "failed"]),
  submitted: new Set(["submitted", "completed", "failed"]),
  completed: new Set(),
  failed: new Set(["submitting"]),
  cancelled: new Set(),
};

export function transitionRender({ current, operation }) {
  const next = operation?.params?.state;
  const previous = current?.data?.state;
  if (!TRANSITIONS[previous]?.has(next)) {
    throw Object.assign(new Error(`Render state cannot change from ${previous} to ${next}.`), { code: "invalid_render_transition" });
  }
  const patch = operation.params.patch && typeof operation.params.patch === "object" ? operation.params.patch : {};
  const allowed = new Set(["attemptNumber", "attemptId", "promptId", "seed", "filenamePrefix", "payloadDigest", "outputs", "error", "errorKind", "lastCheckedAt", "submittedAt", "completedAt"]);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error("Render transition patch contains an unsupported field.");
  return { record: { data: { ...current.data, ...structuredClone(patch), state: next } }, result: { from: previous, to: next } };
}
