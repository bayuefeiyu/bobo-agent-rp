/**
 * Lifecycle of shared data-read views.
 *
 * A read view is created once per root workflow run and inherited by every descendant of that run,
 * so an Agent that keeps working after its parent finished still reads the frozen snapshot the run
 * started with. Deleting it when the *root* run reaches a terminal status is therefore wrong: a
 * terminal parent is not the end of all of its descendants, and the descendant that is still running
 * — a deep-director child, an awaited module call — then fails with a missing `manifest.json`.
 *
 * The rule enforced here is stated in terms of consumers: a view may be deleted only once every run
 * that references it has finished **and** completed its own terminal finalization. The relationship
 * is rebuilt from persisted run state at startup so a restart cannot lose it, and in-memory
 * registration keeps the same answer live during a session.
 *
 * New consumers cannot register into a view that is already gone, because a run always registers
 * before it can create a descendant.
 */

const TERMINAL_RUN_STATUSES = new Set(["completed", "skipped", "failed", "cancelled"]);

/** One registered reference: a run that reads through a view. */
export function createDataReadViewRegistry() {
  /** @type {Map<string, string>} runId -> viewId */
  const consumers = new Map();

  function register(run) {
    if (!run || typeof run.id !== "string" || typeof run.dataReadViewId !== "string" || !run.dataReadViewId) return false;
    const previous = consumers.get(run.id);
    consumers.set(run.id, run.dataReadViewId);
    return previous !== run.dataReadViewId;
  }

  /** Consumer count per view, from both persisted and live state. */
  function activeConsumers(viewId) {
    return [...consumers.values()].filter(candidate => candidate === viewId).length;
  }

  /**
   * Runs that still need a view: anything not finished, plus anything finished whose terminal
   * finalization has not completed. The second group matters because the lifecycle finalizer itself
   * (§ `finish-deep-operation`) may still read the snapshot.
   */
  function pendingConsumers(runs) {
    return (Array.isArray(runs) ? runs : []).filter(run => {
      if (typeof run?.dataReadViewId !== "string" || !run.dataReadViewId) return false;
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return true;
      return run.terminalFinalization?.status !== "completed";
    });
  }

  return {
    register,
    activeConsumers,
    /**
     * Rebuild the run -> view relationship from persisted runs. Called once, after restore has
     * registered every live run and before any cleanup runs, so a restart never frees a view that
     * a surviving descendant still needs.
     */
    hydrate(runs) {
      consumers.clear();
      for (const run of pendingConsumers(runs)) consumers.set(run.id, run.dataReadViewId);
      return consumers.size;
    },
    /** Every view any run still references. */
    viewIds() {
      return [...new Set(consumers.values())];
    },
    /**
     * Release one finished run. Returns the viewId to delete when this was its last consumer, or
     * null when the view must stay — including when a sibling or descendant is still reading it.
     */
    release(runId, viewId) {
      if (typeof runId !== "string" || !runId) return null;
      const registered = consumers.get(runId);
      consumers.delete(runId);
      // A run that never registered (for example a terminal run restored after its view was already
      // collected) must not delete a view that other runs still hold.
      const effective = typeof viewId === "string" && viewId ? viewId : registered || null;
      if (!effective) return null;
      if (registered && registered !== effective) return null;
      return activeConsumers(effective) === 0 ? effective : null;
    },
    /** Remove a view without releasing anything: used when the view is already known to be gone. */
    forget(viewId) {
      for (const [runId, candidate] of [...consumers.entries()]) if (candidate === viewId) consumers.delete(runId);
    },
    size() {
      return consumers.size;
    },
  };
}
