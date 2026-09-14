import { createStoryMechanics } from "../lib/story-mechanics.mjs";

export const execute = createStoryMechanics({ moduleId: "local-scene-narrative", recordType: "local-narrative.story", recentTitle: "Recent local stories" }).exportRecentStories;
