import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsAutosave } from "../public/module-autosave.js";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("serial autosave retains the last rapid change, updates revisions, and submits only changed fields", async () => {
  let revision = 1, values = { "/mode": "a", "/text": "untouched" }, release;
  const writes = [], statuses = [];
  const saver = createSettingsAutosave({ revision, values,
    read: async () => ({ record: { revision }, values: structuredClone(values) }),
    write: async body => { writes.push(body); if (writes.length === 1) await new Promise(resolve => { release = resolve; }); assert.equal(body.expectedRevision, revision); Object.assign(values, body.values); revision++; },
    notify: status => statuses.push(status),
  });
  saver.commit({ "/mode": "b" }); saver.commit({ "/mode": "c" }); saver.commit({ "/mode": "d" });
  assert.equal(writes.length, 1); release(); await settle();
  assert.deepEqual(writes.map(({ operationId, ...body }) => body), [{ expectedRevision: 1, values: { "/mode": "b" } }, { expectedRevision: 2, values: { "/mode": "d" } }]);
  assert.ok(writes.every(({ operationId }) => typeof operationId === "string" && operationId.length > 0));
  assert.equal(values["/text"], "untouched"); assert.equal(saver.dirty, false); assert.equal(statuses.at(-1).error, "");
});

test("conflicting edits retain the pending draft; unrelated edits rebase without overwriting other fields", async () => {
  for (const sameField of [false, true]) {
    let revision = 2, values = { "/mode": sameField ? "external" : "old", "/text": "external text" }, writes = 0, status;
    const saver = createSettingsAutosave({ revision: 1, values: { "/mode": "old", "/text": "old text" },
      read: async () => ({ record: { revision }, values }),
      write: async body => { writes++; if (body.expectedRevision !== revision) throw Object.assign(new Error("conflict"), { status: 409 }); values = { ...values, ...body.values }; revision++; },
      notify: next => { status = next; },
    });
    saver.commit({ "/mode": "mine" }); await settle();
    assert.equal(values["/text"], "external text");
    if (sameField) { assert.equal(writes, 1); assert.equal(saver.dirty, true); assert.equal(status.conflict, true); saver.retry(); await settle(); assert.equal(writes, 1); }
    else { assert.equal(writes, 2); assert.equal(values["/mode"], "mine"); assert.equal(saver.dirty, false); }
  }
});

test("failed persistence retains changes and retry completes them", async () => {
  let fail = true, values = { "/text": "old" }, revision = 1, status;
  const saver = createSettingsAutosave({ revision, values,
    read: async () => ({ record: { revision }, values }),
    write: async body => { if (fail) throw new Error("offline"); Object.assign(values, body.values); revision++; },
    notify: next => { status = next; },
  });
  saver.commit({ "/text": "draft" }); await settle(); assert.equal(saver.dirty, true); assert.match(status.error, /offline/);
  fail = false; saver.retry(); await settle(); assert.equal(values["/text"], "draft"); assert.equal(saver.dirty, false);
});
