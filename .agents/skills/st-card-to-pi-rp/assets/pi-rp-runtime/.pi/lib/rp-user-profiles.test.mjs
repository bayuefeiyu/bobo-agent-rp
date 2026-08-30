import assert from "node:assert/strict";
import test from "node:test";

import { removeSavedUserProfile } from "./rp-user-profiles.mjs";

const settings = () => ({
  schemaVersion: 1,
  user: {
    playerName: "当前用户",
    description: "当前设定",
    savedProfiles: [
      { name: "当前用户", description: "当前设定", avatar: "avatars/current.png" },
      { name: "备用用户", description: "备用设定" },
    ],
  },
  system: { fontSize: 16 },
});

test("deleting the active saved user selects the first remaining profile", () => {
  const result = removeSavedUserProfile(settings(), "当前用户");
  assert.equal(result.activeChanged, true);
  assert.equal(result.removed.avatar, "avatars/current.png");
  assert.equal(result.settings.user.playerName, "备用用户");
  assert.equal(result.settings.user.description, "备用设定");
  assert.deepEqual(result.settings.user.savedProfiles.map(profile => profile.name), ["备用用户"]);
});

test("deleting an inactive saved user keeps the active profile", () => {
  const result = removeSavedUserProfile(settings(), "备用用户");
  assert.equal(result.activeChanged, false);
  assert.equal(result.settings.user.playerName, "当前用户");
});

test("the last saved user cannot be deleted", () => {
  const only = settings();
  only.user.savedProfiles = [only.user.savedProfiles[0]];
  assert.throws(() => removeSavedUserProfile(only, "当前用户"), error => error.status === 409);
});
