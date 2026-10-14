import { API_ROOT, API_VERSION, RpWebError, assertCompatible, contextKey, normalizeReadContext } from "../rp-web-contract/index.mjs";

/** Instance-local transport and context. Works in Node and browsers without DOM. */
export function createRpClient({ baseUrl, fetch: fetchImpl = globalThis.fetch, auth = async () => ({}), transport = null } = {}) {
  if (!baseUrl || typeof fetchImpl !== "function") throw new Error("baseUrl and fetch are required.");
  const root = new URL(baseUrl);
  let connection = null;
  let readContext = null;
  let generation = 0;
  const pending = new Set();
  const subscriptions = new Set();
  const contextListeners = new Set();
  const resources = new Set();
  const resolveUrl = (path, { context = readContext } = {}) => {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/api/") ? path : `${API_ROOT}/${path.replace(/^\//, "")}`, root);
    if (url.origin !== root.origin || !url.pathname.startsWith(`${API_ROOT}/`)) throw new RpWebError("invalid_request", "Resource must belong to this API origin.");
    if (context) url.searchParams.set("readContext", JSON.stringify(context));
    return url.href;
  };
  async function request(path, options = {}) {
    const started = generation;
    const controller = new AbortController();
    pending.add(controller);
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => controller.abort(new RpWebError("operation_outcome_unknown", "Request timed out; check its outcome before retrying.")), options.timeoutMs) : null;
    try {
      const method = options.method || "GET";
      const headers = { ...(await auth({ path, method, connection })), ...options.headers };
      if (options.body != null && typeof options.body === "object" && !(options.body instanceof Uint8Array) && !(typeof Blob !== "undefined" && options.body instanceof Blob)) {
        headers["content-type"] ||= "application/json";
      }
      const body = headers["content-type"] === "application/json" && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body;
      const url = resolveUrl(path, options);
      const response = await (transport?.request || fetchImpl)(url, { method, headers, body, signal: controller.signal });
      if (started !== generation) throw new RpWebError("session_changed", "Response belongs to a previous context.");
      const payload = options.binary && response.ok ? await response.blob() : await response.json().catch(() => ({}));
      if (started !== generation) throw new RpWebError("session_changed", "Response belongs to a previous context.");
      if (!response.ok) {
        const error = payload.error || {};
        throw new RpWebError(error.code || "internal_error", error.message || "Request failed.", { ...error, status: response.status, requestId: payload.requestId });
      }
      if (!options.binary && payload.readContext && (options.method || "GET") !== "GET") resetContext(payload.readContext);
      return options.envelope || options.binary ? payload : payload.data;
    } catch (error) {
      if (started !== generation) throw new RpWebError("session_changed", "Request belongs to a previous context.");
      if (!(error instanceof RpWebError) && (options.method || "GET") !== "GET") throw new RpWebError("operation_outcome_unknown", "Submission outcome is unknown; query the operation before retrying.", { details: { cause: error.message } });
      throw error;
    } finally {
      pending.delete(controller);
      options.signal?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
    }
  }
  function resetContext(value) {
    const next = value ? normalizeReadContext(value) : null;
    if (JSON.stringify(next) === JSON.stringify(readContext)) return;
    generation++;
    for (const controller of pending) controller.abort();
    readContext = next;
    for (const watcher of subscriptions) watcher.reset();
    for (const listener of contextListeners) listener(readContext ? { ...readContext } : null);
  }
  async function connect() {
    const discovered = await request("connection", { context: null });
    assertCompatible(API_VERSION, discovered.apiVersion);
    connection = discovered;
    resetContext(discovered.readContext);
    return discovered;
  }
  function watch(path, listener, { intervalMs = 600, maximumBackoffMs = 10000, signal, onError = () => {}, visible = () => true } = {}) {
    const controller = new AbortController();
    let disposed = false, timer = null, previous = null, failures = 0, first = true, inFlight = false;
    const schedule = () => { if (!disposed) timer = setTimeout(tick, Math.min(maximumBackoffMs, intervalMs * 2 ** failures) * (visible() ? 1 : 4)); };
    async function tick() {
      if (disposed || inFlight) return;
      inFlight = true;
      const started = generation;
      try {
        const payload = await request(path, { signal: controller.signal });
        if (disposed || started !== generation) return;
        failures = 0;
        const signature = JSON.stringify(payload);
        if (signature !== previous || first) {
          await listener(payload, { kind: first ? "snapshot" : "change", context: readContext ? { ...readContext } : null });
          previous = signature;
          first = false;
        }
      } catch (error) {
        if (!disposed && error.name !== "AbortError" && error.code !== "session_changed") { failures++; onError(error); }
      } finally { inFlight = false; schedule(); }
    }
    const watcher = { reset() { previous = null; first = true; }, dispose() { disposed = true; controller.abort(); clearTimeout(timer); subscriptions.delete(watcher); signal?.removeEventListener("abort", watcher.dispose); } };
    subscriptions.add(watcher);
    signal?.addEventListener("abort", watcher.dispose, { once: true });
    if (signal?.aborted) watcher.dispose(); else void tick();
    return watcher.dispose;
  }
  return {
    request, connect, watch,
    get connection() { return connection; },
    get readContext() { return readContext ? { ...readContext } : null; },
    setReadContext: resetContext,
    onContext(listener) { contextListeners.add(listener); return () => contextListeners.delete(listener); },
    preview(executionId) { if (!readContext) throw new RpWebError("session_changed", "Connect first."); resetContext({ ...readContext, executionId }); },
    resourceUrl: resolveUrl,
    async loadResource(path, options = {}) {
      const blob = await request(path, { ...options, binary: true });
      const url = URL.createObjectURL(blob);
      resources.add(url);
      return { url, release() { URL.revokeObjectURL(url); resources.delete(url); } };
    },
    get cacheKey() { return readContext ? contextKey(readContext) : "disconnected"; },
    dispose() { generation++; for (const controller of pending) controller.abort(); for (const watcher of [...subscriptions]) watcher.dispose(); for (const url of resources) URL.revokeObjectURL(url); resources.clear(); contextListeners.clear(); },
    chat: { state: () => request("state"), transcript: () => request("transcript"), input: (value) => request("input", { method: "POST", body: value }), opening: (value) => request("opening", { method: "POST", body: value }), resume: (sessionId) => request("resume", { method: "POST", body: { sessionId } }) },
    attempts: { list: () => request("narrative-attempts"), adopt: (id, value) => request(`narrative-attempts/${encodeURIComponent(id)}/adopt`, { method: "POST", body: value }), regenerate: value => request("narrative-attempts/regenerate", { method: "POST", body: value }) },
    modules: { list: () => request("modules"), query: (moduleId, bindingId, query = "") => request(`modules/${encodeURIComponent(moduleId)}/bindings/${encodeURIComponent(bindingId)}/records${query}`), settings: (moduleId, bindingId) => request(`modules/${encodeURIComponent(moduleId)}/bindings/${encodeURIComponent(bindingId)}/settings`), update: (moduleId, bindingId, value) => request(`modules/${encodeURIComponent(moduleId)}/bindings/${encodeURIComponent(bindingId)}/settings`, { method: "PUT", body: value }) },
  };
}
