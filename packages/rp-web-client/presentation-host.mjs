import { HOST_VERSION } from "../rp-web-contract/index.mjs";
import { assertFrontendCapabilities, normalizeFrontendManifest } from "../rp-web-contract/frontend.mjs";

/** Only lifecycle and official navigation; it has no world authority or DOM globals. */
export function createPresentationHost({ container, client, load = url => import(url), navigate, layout = () => {}, fallback = () => {}, onError = () => {} }) {
  let mounted = null, epoch = 0;
  async function detach() {
    const previous = mounted;
    mounted = null;
    if (!previous) return;
    previous.controller.abort();
    previous.client.dispose();
    container.replaceChildren();
    layout(false, false);
    await previous.renderer?.unmount?.();
  }
  async function unmount() { epoch++; await detach(); }
  async function mount(raw, { createClient, entryUrl, assetUrl }) {
    const started = ++epoch;
    await detach();
    if (started !== epoch) return null;
    const frontend = normalizeFrontendManifest(raw);
    assertFrontendCapabilities(frontend, client.connection);
    const controller = new AbortController();
    const local = createClient();
    local.setReadContext(client.readContext);
    const pending = { controller, client: local, renderer: null, frontend };
    mounted = pending;
    try {
      layout(true, frontend.immersive);
      await local.connect();
      if (started !== epoch) { local.dispose(); return null; }
      local.setReadContext(client.readContext);
      local.onContext(context => {
        if (started !== epoch || !context) return;
        const canonical = { ...context, executionId: null };
        if (JSON.stringify(canonical) !== JSON.stringify(client.readContext)) client.setReadContext(canonical);
      });
      const module = await load(entryUrl);
      if (started !== epoch) { local.dispose(); return null; }
      if (typeof module.mount !== "function") throw new Error("Frontend entry must export mount().");
      const renderer = await module.mount({ container, client: local, signal: controller.signal, context: client.readContext, assetUrl, host: Object.freeze({ version: HOST_VERSION, openManagement: panel => navigate(panel), returnToPlay: () => navigate("story"), immersive: value => layout(true, value === true) }) });
      if (!renderer || typeof renderer.unmount !== "function") throw new Error("Frontend mount must return an unmount controller.");
      if (started !== epoch) { await renderer.unmount(); local.dispose(); return; }
      pending.renderer = renderer;
      layout(true, frontend.immersive);
      return frontend;
    } catch (error) {
      if (started !== epoch) return;
      await unmount();
      onError(error);
      fallback();
      return null;
    }
  }
  return {
    mount, unmount,
    get active() { return mounted?.frontend || null; },
    context(value) { if (!mounted) return; mounted.client.setReadContext(value); mounted.renderer?.onContext?.(value); },
    visibility(visible) { mounted?.renderer?.onVisibility?.(visible); },
    resize(size) { mounted?.renderer?.onResize?.(size); },
    connection(value) { mounted?.renderer?.onConnection?.(value); },
  };
}
