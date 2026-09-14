---
name: adapt-comfyui-workflow
description: Analyze and adapt a user-supplied ComfyUI API-format workflow into a confirmed bobo-agent-rp image profile and model-specific prompt guide. Use from the repository root in development mode, not while roleplaying in play mode.
---

# Adapt a ComfyUI workflow

Run only from the `bobo-agent-rp` repository root. This Skill adapts a ComfyUI **API-format** workflow for `global-modules/comfy-image-generation`; it does not edit `play/`, cards, sessions, ComfyUI's installation, or existing output images unless the user explicitly names a different development target.

Read [references/profile-format.md](references/profile-format.md), then:

1. Ask for or locate the API-format workflow JSON and the model family it uses. If the file is UI-format, ask the user to export API format from ComfyUI.
2. Run `node scripts/analyze-workflow.mjs <workflow.json>`. Use `/object_info` only when a reachable ComfyUI connection is already supplied and static analysis cannot identify a custom node.
3. Present detected prompt, seed, loader, LoRA, output, dimension, and custom-node candidates. Ask only about genuine ambiguities and the desired fixed positive/negative/style values.
4. Propose the exact profile mapping and the model guide. Do not write either until the user confirms the proposal.
5. After confirmation, create `profiles/<profile-id>/profile.json`, copy the source as `workflow.api.json`, and create or reuse `skill/guides/<guide-id>/SKILL.md`. Profiles may share one guide when their content-prompt grammar is genuinely identical.
6. Run `node scripts/validate-profile.mjs <profile-directory>`. Resolve every error before reporting completion.

An actual queued generation is an external mutation and may consume resources. Perform it only when the user explicitly asks for a live test. Static validation and a connection health check do not authorize queueing.

Keep all fixed quality, style, LoRA triggers, and negative text in the profile. The guide should teach only model-specific scene description and any tokens that must vary with scene content. Map the filename prefix so generated files stay below the runtime-provided flat per-chat subfolder.
