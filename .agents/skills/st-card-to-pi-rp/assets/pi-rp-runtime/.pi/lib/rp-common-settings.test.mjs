import assert from "node:assert/strict";
import test from "node:test";

import { mergeCommonSettings, normalizeCommonSettings, normalizeCommonSettingsOverride } from "./rp-common-settings.mjs";

test("normalizes shared user and display settings", () => {
  const value = normalizeCommonSettings({ user: { playerName: "  Alice  ", description: "hero", savedProfiles: [] }, system: { fontSize: 20 } });
  assert.equal(value.user.playerName, "Alice");
  assert.equal(value.user.savedProfiles[0].name, "Alice");
  assert.equal(value.system.fontSize, 20);
});

test("card common settings override global categories and inherit missing categories", () => {
  const globalValue = { user: { playerName: "Global", description: "global", savedProfiles: [{ name: "Global", description: "global" }] }, system: { fontSize: 18 } };
  const userOverride = { user: { playerName: "Card", description: "card", savedProfiles: [{ name: "Card", description: "card" }] } };
  assert.deepEqual(mergeCommonSettings(globalValue, userOverride), {
    schemaVersion: 1,
    user: { playerName: "Card", description: "card", savedProfiles: [{ name: "Card", description: "card" }] },
    system: { fontSize: 18 },
  });
  assert.deepEqual(normalizeCommonSettingsOverride({ system: { fontSize: 22 } }), { system: { fontSize: 22 } });
});
