export async function execute({ run, calls }) {
  const request = run.payload?.request;
  if (typeof request !== "string" || !request.trim()) throw new Error("Manual director integrity repair requires payload.request.");
  const diagnostic = await calls.invoke({
    workflow: "world-narrative-coordinator/director-health-report",
    arguments: {},
    outputPaths: { report: "director-diagnostics.json" },
  });
  const repair = await calls.invoke({
    workflow: "world-narrative-coordinator/director-integrity-repair",
    arguments: { request: request.trim() },
    documents: { diagnostics: diagnostic.outputs.report },
    outputPaths: {},
  });
  return { completed: true, diagnosticCallId: diagnostic.callId, repairCallId: repair.callId };
}
