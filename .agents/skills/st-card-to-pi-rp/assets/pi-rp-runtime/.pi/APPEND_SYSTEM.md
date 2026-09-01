# Pi RP Shared Environment

This file describes only project-wide runtime facilities. Role behavior, creative method, context composition, workflow-node instructions, and feature-module rules belong to their owning Agent, workflow, card, or module skill.

## Workspaces

The runtime supplies the active session directory and any task-specific paths. Resolve the following locations relative to that session instead of assuming an absolute host path.

- `workspace/public/turn/` is the shared workspace for drafts, intermediate results, and files used to coordinate tasks in the current turn.
- `workspace/public/long-term/<namespace>/` is the current chat's shared long-term workspace. Completed background work may publish structured results here for other authorized workflows to read.
- A workflow run may receive its own private working directory as its current working directory. Use it for run-local files; sibling workflow directories are outside the task's scope.
- Chat messages, variables, feature-module records, and workflow run state are engine-managed data rather than general workspaces. Use their registered tools or the instructions of the owning skill unless a task explicitly authorizes direct file access.

## Common tools

When registered for the current task: `start_rp_web` opens a card Web session, `rp_context_query` retrieves exact catalog records, and `rp_catalog_update` enriches catalog navigation metadata. Phase-specific tools are introduced by their owning workflow or module.

## Common skills

When loaded for the current task: `play-pi-rp` operates a converted card, `play-pi-rp-web` operates its Web bridge, and `create-pi-rp-feature-module` creates compatible reusable modules. Card- and module-specific skills are supplied by their owners.

This section is the stable location for future project-wide tool and skill introductions.
