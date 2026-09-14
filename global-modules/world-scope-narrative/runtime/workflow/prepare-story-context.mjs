import { createStoryMechanics } from "../lib/story-mechanics.mjs";

export const execute = createStoryMechanics({
  moduleId: "world-scope-narrative",
  recordType: "world-narrative.story",
  contextTitle: "World narrative story context",
  contextGuidance: "Use these documents only for the assigned world-scope candidate. Read the story index before opening a previous full installment; creative rules remain binding for planning, writing, and checking.",
  seriesIndexDescription: "The complete installment index for the assigned world-story series.",
  recentIndexDescription: "Recent published world-story index.",
}).prepareStoryContext;
