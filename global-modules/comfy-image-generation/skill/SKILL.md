---
name: comfy-image-generation
description: Generate scene-content prompt fragments for this card's adapted ComfyUI profiles when the image workflow explicitly supplies separated reference and target material.
---

# ComfyUI scene prompting

This module generates images only through its dedicated background workflow. It does not add images to narrative context and does not make the narrative Agent responsible for fixed quality, style, LoRA, or negative prompts.

For each distinct supplied guide, return one concise `content` fragment describing only the requested scene. Treat **参考内容** as continuity evidence for identities, clothing, location, and relationships; never turn older reference events into the image target. Treat **生图目标** as authoritative. Apply the optional one-run user direction last.

The adapted profile owns prompt assembly, fixed prompt text, negative prompt, workflow bindings, and output selection. Never repeat those fixed parts in the content fragment unless its guide explicitly requires a model-specific token.

The workflow output must be JSON:

```json
{"prompts":[{"guideId":"example-guide","content":"scene-only prompt"}]}
```

Return exactly one item per distinct supplied `guideId`, with no prose outside JSON.

Generated files remain in ComfyUI's output directory. Session deletion does not delete them. A missing source file is an availability condition, not a change from `completed` to `failed`.
