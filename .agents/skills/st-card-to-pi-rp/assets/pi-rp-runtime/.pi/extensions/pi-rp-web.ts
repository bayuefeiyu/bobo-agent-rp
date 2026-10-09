import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRpHostSession } from "../lib/rp-host-session.ts";
export type { WebMessage, RecordEnvelope, RetrievalPolicy, ActiveBridge, RpRun, FeatureModule, ContextProcessor, ModuleDisplaySettings, CommonSettings, CardSettings } from "../lib/rp-host-types.ts";

/** Pi entry: construct the session owner and register its current tools and commands. */
export default function (pi: ExtensionAPI) {
  const host = createRpHostSession(pi);
  host.register(pi);
}
