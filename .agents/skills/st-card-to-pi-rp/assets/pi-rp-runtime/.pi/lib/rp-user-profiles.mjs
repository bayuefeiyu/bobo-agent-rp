export function removeSavedUserProfile(commonSettings, playerName) {
  const profiles = commonSettings?.user?.savedProfiles;
  if (!Array.isArray(profiles)) throw new Error("Saved player profiles are unavailable.");
  const index = profiles.findIndex(profile => profile.name === playerName);
  if (index === -1) throw Object.assign(new Error("Saved player profile was not found."), { status: 404 });
  if (profiles.length <= 1) throw Object.assign(new Error("At least one saved player profile must remain."), { status: 409 });
  const removed = profiles[index];
  const remaining = profiles.filter((_, profileIndex) => profileIndex !== index);
  const next = {
    ...commonSettings,
    user: {
      ...commonSettings.user,
      savedProfiles: remaining,
    },
  };
  if (commonSettings.user.playerName === removed.name) {
    next.user.playerName = remaining[0].name;
    next.user.description = remaining[0].description;
  }
  return { settings: next, removed, activeChanged: commonSettings.user.playerName === removed.name };
}
