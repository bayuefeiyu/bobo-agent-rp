export async function execute({ run }) {
  let result;
  try { result = JSON.parse(run.textInput); }
  catch { throw new Error("Post-director commit requires its complete analysis JSON."); }
  if (!result || !Array.isArray(result.changes?.operations) || !result.delegations || typeof result.delegations !== "object" || Array.isArray(result.delegations)) throw new Error("Invalid post-director analysis delivery.");
  return result;
}
