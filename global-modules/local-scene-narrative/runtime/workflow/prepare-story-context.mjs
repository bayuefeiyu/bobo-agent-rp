import { createStoryMechanics } from "../lib/story-mechanics.mjs";

export const execute = createStoryMechanics({
  moduleId: "local-scene-narrative",
  recordType: "local-narrative.story",
  contextTitle: "Local narrative story context",
  contextGuidance: "Use these documents only for the assigned local-scene candidate. Read the story index before opening a previous full installment; creative rules remain binding for planning, writing, and checking.",
  seriesIndexDescription: "The complete installment index for the assigned series.",
  recentIndexDescription: "Recent published local-story index.",
}).prepareStoryContext;
