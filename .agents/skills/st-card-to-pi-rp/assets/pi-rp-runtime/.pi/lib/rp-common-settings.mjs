export const defaultCommonSettings = Object.freeze({
  schemaVersion: 1,
  user: {
    playerName: "玩家",
    description: "",
    savedProfiles: [{ name: "玩家", description: "" }],
  },
  system: { fontSize: 16 },
});

function normalizeUser(value) {
  const playerName = typeof value?.playerName === "string" && value.playerName.trim()
    ? value.playerName.trim()
    : "玩家";
  const description = typeof value?.description === "string" ? value.description : "";
  const savedProfiles = Array.isArray(value?.savedProfiles)
    ? value.savedProfiles
      .filter(profile => typeof profile?.name === "string" && profile.name.trim())
      .map(profile => {
        const normalized = {
          name: profile.name.trim(),
          description: typeof profile.description === "string" ? profile.description : "",
        };
        if (typeof profile.avatar === "string" && /^avatars\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(profile.avatar)) normalized.avatar = profile.avatar;
        return normalized;
      })
    : [];
  if (!savedProfiles.some(profile => profile.name === playerName)) savedProfiles.push({ name: playerName, description });
  return { playerName, description, savedProfiles };
}

function normalizeFontSize(value, fallback = 16) {
  return Number.isInteger(value) && value >= 14 && value <= 24 ? value : fallback;
}

export function normalizeCommonSettings(value) {
  return {
    schemaVersion: 1,
    user: normalizeUser(value?.user),
    system: { fontSize: normalizeFontSize(value?.system?.fontSize) },
  };
}

export function normalizeCommonSettingsOverride(value) {
  const result = {};
  if (value?.user && typeof value.user === "object" && !Array.isArray(value.user)) result.user = normalizeUser(value.user);
  if (value?.system && typeof value.system === "object" && !Array.isArray(value.system)) {
    const fontSize = normalizeFontSize(value.system.fontSize, null);
    if (fontSize !== null) result.system = { fontSize };
  }
  return result;
}

export function mergeCommonSettings(globalValue, cardOverride) {
  const base = normalizeCommonSettings(globalValue);
  const override = normalizeCommonSettingsOverride(cardOverride);
  return {
    schemaVersion: 1,
    user: override.user || base.user,
    system: { fontSize: override.system?.fontSize ?? base.system.fontSize },
  };
}
