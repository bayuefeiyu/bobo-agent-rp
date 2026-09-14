export async function execute({ run, calls }) {
  const request = run.payload?.request;
  if (typeof request !== "string" || !request.trim()) throw new Error("Manual director maintenance requires payload.request.");
  const result = await calls.invoke({
    workflow: "world-narrative-coordinator/director-data-maintenance",
    arguments: { request: request.trim() },
    outputPaths: {},
  });
  return { completed: true, callId: result.callId };
}
