import { AsyncLocalStorage } from "node:async_hooks";

type SessionIdentity = { recordId: string | null; sessionDirectory: string | null };
type ReadContext = { serverInstanceId: string; cardId: string | null; chatId: string | null; executionId: string | null };

/** Bind async work to one bridge and chat. Reads and writes after a switch are rejected. */
export function createHostSessionScope<T extends SessionIdentity>() {
  let current: T | null = null;
  const work = new AsyncLocalStorage<{ owner: T; recordId: string | null; directory: string | null; proxy: T; readContext: ReadContext | null }>();
  const inactive = () => Object.assign(new Error("This Web page belongs to a closed Pi session. Use the newest Web RP page."), { status: 409, code: "session_changed" });
  function requireCurrent(): T {
    const context = work.getStore();
    if (!context) {
      if (!current) throw inactive();
      return current;
    }
    if (current !== context.owner || current.recordId !== context.recordId || current.sessionDirectory !== context.directory) throw inactive();
    return context.proxy;
  }
  return {
    get current() { return work.getStore() ? requireCurrent() : current; },
    set current(value: T | null) { current = value; },
    requireCurrent,
    get readContext() { return work.getStore()?.readContext || null; },
    get executionId() { return work.getStore()?.readContext?.executionId || null; },
    matches(owner: T) { return current === owner; },
    updateChat(recordId: string | null, sessionDirectory: string | null) {
      requireCurrent();
      current!.recordId = recordId;
      current!.sessionDirectory = sessionDirectory;
      const context = work.getStore();
      if (context) { context.recordId = recordId; context.directory = sessionDirectory; }
    },
    requireChat(): T & { recordId: string; sessionDirectory: string } {
      const owner = requireCurrent();
      if (!owner.recordId || !owner.sessionDirectory) throw Object.assign(new Error("Start or resume a chat before using session data."), { status: 409 });
      return owner as T & { recordId: string; sessionDirectory: string };
    },
    run<R>(action: () => R, readContext: ReadContext | null = work.getStore()?.readContext || null): R {
      requireCurrent();
      if (work.getStore() && work.getStore()!.readContext === readContext) return action();
      const owner = current!;
      if (readContext && readContext.chatId !== owner.recordId) throw inactive();
      const context = { owner, recordId: owner.recordId, directory: owner.sessionDirectory, proxy: owner, readContext };
      context.proxy = new Proxy(owner, {
        get(target, key, receiver) { requireCurrent(); return Reflect.get(target, key, receiver); },
        set(target, key, value, receiver) { requireCurrent(); return Reflect.set(target, key, value, receiver); },
      });
      return work.run(context, action);
    },
    bind<F extends (...args: never[]) => unknown>(action: F): F {
      return ((...args: Parameters<F>) => this.run(() => action(...args))) as F;
    },
  };
}

export type HostSessionScope<T extends SessionIdentity> = ReturnType<typeof createHostSessionScope<T>>;
