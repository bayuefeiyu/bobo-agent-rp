export async function execute({ run,services }) {
  const operation = run.arguments?.operation ?? run.payload?.operation ?? "auto";
  if (!["auto","update","rebuild","cancel","status"].includes(operation)) throw Object.assign(new Error("Invalid history maintenance operation."),{ code:"invalid_request" });
  if (operation === "cancel") return services.narrativeHistory.cancel();
  if (operation === "status") return services.narrativeHistory.status();
  return services.narrativeHistory.index();
}
