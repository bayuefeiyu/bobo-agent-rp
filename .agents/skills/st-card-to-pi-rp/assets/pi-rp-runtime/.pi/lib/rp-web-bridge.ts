import type { ActiveBridge } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

/** Capture request identity; only explicit chat lifecycle operations may change it. */
export function bindWebBridge<T extends Record<string, unknown>>(scope: HostSessionScope<ActiveBridge>, operations: T): T {
  const owner = scope.requireCurrent();
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, typeof operation !== "function" ? operation : (...args: unknown[]) => {
    if (!scope.matches(owner)) throw Object.assign(new Error("This Web bridge is not active."), { status: 409 });
    return scope.run(() => operation(...args));
  }])) as T;
}
