import { createRpClient } from "../packages/rp-web-client/index.mjs";
import { normalizeReadContext, RpWebError, type State } from "../packages/rp-web-contract/index.mjs";
const client = createRpClient({ baseUrl: "http://127.0.0.1", auth: () => ({ "x-rp-config-token": "example" }) });
client.setReadContext(normalizeReadContext({ serverInstanceId: "instance", cardId: "card", chatId: null }));
const request: Promise<State> = client.chat.state();
void request;
void client.chat.input({ content: "example", operationId: "operation" });
// @ts-expect-error Persistent input commands require an explicit operation identity.
void client.chat.input({ content: "example" });
// @ts-expect-error Preview context only accepts an execution identity, never a writable world object.
client.preview({ state: {} });
const stop = client.watch<State>("state", (state, metadata) => { const content: string | undefined = state.messages.at(-1)?.content; void content; void metadata.context?.chatId; });
stop(); client.dispose();
const error: Error = new RpWebError("session_changed", "Session changed."); void error;
