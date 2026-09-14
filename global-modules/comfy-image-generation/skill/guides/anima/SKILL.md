---
name: anima
description: Write one scene-only English mixed tag and natural-language prompt for Anima, excluding fixed quality, safety, LoRA-trigger, and negative tokens.
---

# Anima content prompt guide

Write only the variable visual content for one image. The parent image-generation workflow owns the response envelope and combines this fragment with the profile's fixed prompt text.

## Content rules

- Describe one visually expressible moment from the requested target passage. Earlier reference passages provide continuity details only; do not depict them or advance the story beyond the target.
- Use English and target an anime illustration rather than photorealism.
- Begin with concise lowercase Danbooru/Gelbooru-style tags, using spaces rather than underscores. Order them as: person count, character identity, franchise or work when relevant, explicitly requested artist, then general scene tags.
- Use an `@artist name` tag only when the user explicitly requests that artist. Prefer Gelbooru naming when tag spellings conflict.
- Follow the tags with at least two complete English sentences for relationships, actions, spatial arrangement, composition, lighting, and details that tags express poorly.
- For multiple people, bind each person's position, appearance, clothing, action, gaze, and contact clearly enough to avoid attribute leakage.
- Prioritize the subjects, their relationship and action, the environment, and composition. Avoid exhaustive inventories and avoid strong prompt weighting unless an earlier attempt failed for a specific reason.
- Aim for roughly 80–180 English words when the scene has enough information. Stay concise for simple scenes rather than inventing details.
- Honor an extra manual instruction by using it to choose the depicted beat or emphasis, while remaining faithful to the supplied material.

## Exclusions

Do not include fixed quality or safety tokens such as `masterpiece`, `best quality`, `highres`, `score_*`, `safe`, `sensitive`, `nsfw`, or `explicit`. Do not include fixed LoRA trigger tokens such as `@gpt-image-2`, and do not write negative-prompt terms. These belong to the profile.

Return a single prompt fragment only. Do not add headings, Chinese titles, scene numbering, `<image_Tag>` wrappers, `image###` markers, scratch notes, file paths, or multiple alternatives.
