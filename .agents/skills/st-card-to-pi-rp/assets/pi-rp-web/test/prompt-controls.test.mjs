import assert from "node:assert/strict";
import test from "node:test";

import {
  composePromptPreview,
  selectionsFromValues,
  valuesFromSelections,
} from "../public/prompt-controls.js";

const controls = {
  groups: [
    {
      id: "pacing",
      title: "Narrative pace",
      options: [
        { id: "none", label: "None", content: "" },
        { id: "steady", label: "Steady", content: "Keep the scene moving." },
        { id: "custom", label: "Custom", content: "" },
      ],
    },
    {
      id: "voice",
      title: "Voice",
      options: [
        { id: "none", label: "None", content: "" },
        { id: "quiet", label: "Quiet", content: "Use a restrained voice." },
        { id: "custom", label: "Custom", content: "" },
      ],
    },
  ],
};

test("maps prompt selections to the settings pointer contract", () => {
  const selections = selectionsFromValues(controls, {
    "/selections/pacing/optionId": "custom",
    "/selections/pacing/customText": "Keep the focus narrow.",
    "/selections/voice/optionId": "none",
  });
  assert.deepEqual(selections, {
    pacing: { optionId: "custom", customText: "Keep the focus narrow." },
    voice: { optionId: "none", customText: "" },
  });
  assert.deepEqual(valuesFromSelections(controls, selections), {
    "/selections/pacing/optionId": "custom",
    "/selections/pacing/customText": "Keep the focus narrow.",
    "/selections/voice/optionId": "none",
    "/selections/voice/customText": "",
  });
});

test("composes only selected non-empty preset or custom content", () => {
  const preview = composePromptPreview(controls, {
    pacing: { optionId: "custom", customText: "  Keep the focus narrow.  " },
    voice: { optionId: "none", customText: "Ignored" },
  });
  assert.deepEqual(preview, [{ id: "pacing", title: "Narrative pace", content: "Keep the focus narrow." }]);

  assert.deepEqual(composePromptPreview(controls, {
    pacing: { optionId: "steady", customText: "" },
    voice: { optionId: "quiet", customText: "" },
  }), [
    { id: "pacing", title: "Narrative pace", content: "Keep the scene moving." },
    { id: "voice", title: "Voice", content: "Use a restrained voice." },
  ]);
});

test("defaults two-option other requirements and keeps authored preview order", () => {
  const otherRequirements = {
    title: "Director requirements",
    groups: [
      {
        id: "other-requirements",
        title: "Other requirements",
        options: [
          { id: "default", label: "Default", content: "<!-- director-only -->\nKeep the director's source visible." },
          { id: "custom", label: "Custom", content: "" },
        ],
      },
      {
        id: "ending",
        title: "Ending",
        options: [
          { id: "default", label: "Default", content: "Resolve the scene clearly." },
          { id: "custom", label: "Custom", content: "" },
        ],
      },
    ],
  };

  const selections = selectionsFromValues(otherRequirements, {});
  assert.deepEqual(selections, {
    "other-requirements": { optionId: "default", customText: "" },
    ending: { optionId: "default", customText: "" },
  });
  assert.deepEqual(composePromptPreview(otherRequirements, selections), [
    { id: "other-requirements", title: "Other requirements", content: "<!-- director-only -->\nKeep the director's source visible." },
    { id: "ending", title: "Ending", content: "Resolve the scene clearly." },
  ]);
});
