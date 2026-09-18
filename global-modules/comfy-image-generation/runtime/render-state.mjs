const TRANSITIONS = {
  pending: new Set(["submitting", "cancelled", "failed"]),
  submitting: new Set(["submitting", "submitted", "completed", "failed"]),
  submitted: new Set(["submitted", "completed", "failed"]),
  completed: new Set(),
  failed: new Set(["submitting"]),
  cancelled: new Set(),
};

/**
 * Fields a state transition may write.
 *
 * `warnings` belongs here because the completion path records the non-blocking node messages it found
 * (a render can succeed while the history carries unrelated node errors). Leaving it out made every
 * *successful* render fail its own completion write — the transition was rejected as an unsupported
 * field, so the record stayed `submitted` with no outputs and the image the module had just produced
 * was never attached to it (RC-16).
 */
const TRANSITION_FIELDS = ["attemptNumber", "attemptId", "promptId", "seed", "filenamePrefix", "payloadDigest", "outputs", "warnings", "error", "errorKind", "lastCheckedAt", "submittedAt", "completedAt"];

export function transitionRender({ current, operation }) {
  const next = operation?.params?.state;
  const previous = current?.data?.state;
  if (!TRANSITIONS[previous]?.has(next)) {
    throw Object.assign(new Error(`Render state cannot change from ${previous} to ${next}.`), { code: "invalid_render_transition" });
  }
  const patch = operation.params.patch && typeof operation.params.patch === "object" ? operation.params.patch : {};
  const allowed = new Set(TRANSITION_FIELDS);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error(`Render transition patch contains an unsupported field: ${Object.keys(patch).filter(key => !allowed.has(key)).join(", ")}.`);
  return { record: { data: { ...current.data, ...structuredClone(patch), state: next } }, result: { from: previous, to: next } };
}
