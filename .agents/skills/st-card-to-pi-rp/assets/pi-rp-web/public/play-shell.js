import { createRpClient } from "./vendor/rp-web-client/index.mjs";
import { createPresentationHost } from "./vendor/rp-web-client/presentation-host.mjs";

export async function mountPlayShell({ client, navigate, pauseDefault, resumeDefault, onError }) {
  const container = document.querySelector("#custom-play");
  const controls = document.querySelector("#presentation-controls");
  let shown = false;
  const host = createPresentationHost({ container, client, navigate, onError,
    layout(custom, immersive) {
      shown = custom;
      document.body.classList.toggle("custom-play-active", custom);
      document.body.classList.toggle("immersive-play", immersive && custom);
      controls.hidden = !custom;
      if (custom) pauseDefault(); else { container.hidden = true; if (!controller.signal.aborted) resumeDefault(); }
      if (custom) navigate("story");
    }, fallback() { navigate("story"); },
  });
  const controller = new AbortController();
  const offContext = client.onContext(context => host.context(context));
  document.querySelector("#presentation-manage").addEventListener("click", () => navigate("profiles"), { signal: controller.signal });
  document.querySelector("#presentation-default").addEventListener("click", () => host.unmount().then(() => navigate("story")), { signal: controller.signal });
  window.addEventListener("keydown", event => { if (event.key === "Escape" && shown) { document.body.classList.remove("immersive-play"); navigate("profiles"); } }, { signal: controller.signal });
  document.addEventListener("visibilitychange", () => host.visibility(!document.hidden), { signal: controller.signal });
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(entries => host.resize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height })) : null;
  observer?.observe(container);
  window.addEventListener("pagehide", () => { controller.abort(); offContext(); observer?.disconnect(); void host.unmount(); }, { once: true });
  const packaged = await client.request("frontend");
  if (packaged.manifest.kind === "custom") {
    const assetUrl = path => {
      if (!packaged.manifest.assets.includes(path)) throw new Error("Frontend asset is not declared.");
      return new URL(packaged.assetRoot + path, window.location.href).href;
    };
    await host.mount(packaged.manifest, { createClient: () => createRpClient({ baseUrl: window.location.href }), entryUrl: new URL(packaged.entryUrl, window.location.href).href, assetUrl });
  }
  return { host, panel(name) { container.hidden = !shown || name !== "story"; document.body.classList.toggle("custom-story", shown && name === "story"); if (shown && name === "story") document.querySelector("#panel-story").hidden = true; host.visibility(shown && name === "story" && !document.hidden); } };
}
