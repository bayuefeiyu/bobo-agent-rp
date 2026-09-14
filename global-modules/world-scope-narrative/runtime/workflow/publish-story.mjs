import { createStoryMechanics } from "../lib/story-mechanics.mjs";

export const execute = createStoryMechanics({ moduleId: "world-scope-narrative", recordType: "world-narrative.story" }).publishStory;
