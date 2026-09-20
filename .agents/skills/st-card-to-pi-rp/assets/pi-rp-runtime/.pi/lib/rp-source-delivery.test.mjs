import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDeliveryContract } from "./rp-agent-delivery.mjs";
import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function findSourceRoot(start) {
  for (let directory = start; ; directory = dirname(directory)) {
    const marker = join(directory, "PROJECT-RELEASE-MANIFEST.json");
    const modules = join(directory, "global-modules");
    if (await access(marker).then(() => true, () => false) && await access(modules).then(() => true, () => false)) return directory;
    if (dirname(directory) === directory) return null;
  }
}
async function walk(directory, name, found = []) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path, name, found);
    else if (item.name === name) found.push(path);
  }
  return found;
}
const json = async path => JSON.parse(await readFile(path, "utf8"));

test("all shipped ordinary Agent nodes declare a file or directory delivery and keep return types", async t => {
  const root = await findSourceRoot(runtime);
  if (!root) return t.skip("source assets are not installed beside this runtime copy");
  const sourceRuntime = join(root, ".agents", "skills", "st-card-to-pi-rp", "assets", "pi-rp-runtime");
  const paths = [...await walk(join(sourceRuntime, "workflows"), "workflow.json"), ...await walk(join(root, "global-modules"), "workflow.json")];
  const profiles = [...await walk(join(sourceRuntime, "agents"), "agent.json"), ...await walk(join(root, "global-modules"), "agent.json")];
  const byId = new Map(await Promise.all(profiles.map(async path => { const profile = await json(path); return [profile.id, profile]; })));
  let count = 0;
  let jsonCount = 0;
  for (const path of paths) {
    const raw = await json(path);
    if (!raw.nodes?.some(node => node.type === "agent")) continue;
    const normalized = normalizeWorkflowDefinition(raw);
    for (const node of normalized.nodes.filter(node => node.type === "agent")) {
      count++;
      const agentId = node.agentId || raw.defaults?.agentId;
      const profile = byId.get(agentId);
      assert.ok(profile, `${raw.id}/${node.id} resolves Agent profile ${agentId}`);
      const contract = agentDeliveryContract(node, profile);
      assert.ok(node.delivery, `${raw.id}/${node.id} explicitly declares delivery`);
      assert.ok(Object.keys(contract.outputs).length, `${raw.id}/${node.id} has an Agent artifact`);
      if (profile.outputMode === "json") {
        jsonCount++;
        assert.equal(contract.outputs[contract.primary].format, "json", `${raw.id}/${node.id} returns JSON from a file`);
      }
      if (Object.values(contract.outputs).some(output => output.kind === "file")) assert.ok(contract.primary, `${raw.id}/${node.id} names a primary return file`);
      for (const capability of ["read", "write", "edit"]) assert.ok(profile.tools.includes(capability), `${profile.id} exposes ${capability} in its source profile`);
      assert.ok(!profile.tools.includes("bash"), `${profile.id} does not default to shell`);
      assert.ok(!/不要尝试写文件|最终回复就是|最终回复只输出|最终严格按Agent约定输出JSON|输出且只输出含operations数组/.test(`${node.prompt || ""}\n${profile.prompt || ""}`), `${raw.id}/${node.id} uses delivery wording`);
    }
  }
  assert.equal(count, 18);
  assert.equal(jsonCount, 12);
});
