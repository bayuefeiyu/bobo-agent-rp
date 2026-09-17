const TERMINAL = new Set(["completed", "skipped", "failed", "cancelled"]);

/**
 * Run fallible host propagation while guaranteeing foreground-turn release.
 *
 * Persistence, cleanup and event delivery belong to the host and may fail independently from the
 * workflow. A terminal foreground run has already reached its state-machine outcome, so its turn
 * occupation must be released in `finally` even when those host operations throw.
 */
export async function withTerminalForegroundRelease(run, workflow, work, release) {
  try {
    return await work();
  } finally {
    if (workflow?.kind === "foreground" && TERMINAL.has(run?.status)) release();
  }
}
