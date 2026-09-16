export function checkpointTeamSessionAttempt(sessionManager) {
  return { leafId: sessionManager?.getLeafId?.() || null };
}

export function rollbackTeamSessionAttempt(sessionManager, checkpoint, detail = {}) {
  if (!sessionManager) return null;
  if (checkpoint?.leafId) sessionManager.branch(checkpoint.leafId);
  else sessionManager.resetLeaf();
  return sessionManager.appendCustomEntry("rp-team-attempt-rollback", {
    executionId: detail.executionId || null,
    attemptId: detail.attemptId || null,
    error: detail.error || null,
  });
}
