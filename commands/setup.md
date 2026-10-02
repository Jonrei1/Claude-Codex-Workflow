---
description: Install every tool (Claude Code, Codex CLI, graphify, Impeccable) and set up the Claude + Codex workflow in this project
argument-hint: "[--yes] [--dry-run] [--tools-only|--project-only] [--update-sections] [--impeccable-providers=codex]"
allowed-tools: Bash(node:*), Read, Write, Edit
---

Set up the Claude + Codex workflow in the current project.

1. From the project root, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/claude-codex-workflow/scripts/install.js" $ARGUMENTS
   ```

   The installer can't prompt from here. If it reports tools as missing and the user
   didn't pass `--yes`, list the install commands it printed and ask whether to re-run
   with `--yes`. If the Impeccable plugin is already enabled in Claude Code, re-run with
   `--impeccable-providers=codex` so Claude doesn't load the skill twice.
2. Show the summary: what was created, merged or skipped, and the steps that need
   attention. If a `## Workflow` or `## Codex execution` section exists but differs
   from the plugin's, say so and offer `--update-sections`.
3. Read the detected checks it printed. If they're wrong or empty, propose a
   `.codex/verify.json`, and propose `alignment.riskPaths` for the project's schema,
   migration and auth paths (see the claude-codex-workflow skill, "Checks").
4. List the "Left for you" steps, and the new- or existing-project steps from the
   skill's Setup section (`/graphify .`, `/impeccable init`, `/impeccable document`).

Don't commit anything.
