# Claude + Codex workflow

A Claude Code plugin that sets up this workflow in any project, new or existing, on any stack, on Windows, macOS or Linux:

- **One-command setup:** one installer installs the missing tools (Claude Code, the Codex CLI, graphify, Impeccable) and wires the workflow into the project.
- For each task, Claude asks whether to implement it directly or to act as orchestrator.
- As orchestrator, Claude writes a phased plan to `plans/<task>.md`. Every phase has a runnable gate.
- **One-paste execution:** Claude always ends an approved plan with one line, `Execute plans/<task>.md`. Paste it into Codex, and Codex runs every phase: it implements, then `.codex/autopilot.js verify` runs the gate and a headless Claude check. Codex reworks on findings, and the run ends with a task summary in `docs/tasks/`.
- Each check has two steps. Step A (Sonnet, low) runs the project's auto-detected checks and fixes only lint, formatting and type errors. Step B (Sonnet, medium; Opus for risky plans or paths) reviews the phase against the plan without editing, and ends with `VERDICT: PASS | NEEDS REWORK`.
- Risky plans get a Codex plan review, triaged by Claude, before any code is written.
- No agent ever commits or pushes: every change stays in the working tree for you to review and commit.
- graphify gives both agents a knowledge graph of the codebase.
- [Impeccable](https://github.com/pbakaus/impeccable) gives both agents design skills and a hook that flags UI problems.
- caveman keeps replies short when you want to save tokens.

## Install

In Claude Code:

```
/plugin marketplace add Jonrei1/Claude-Codex-Workflow
/plugin install claude-codex-workflow@claude-codex-workflow
```

Then, in the project you want to set up (a git repo):

```
/claude-codex-workflow:setup
```

Or without the plugin, from the project root:

```
npx github:Jonrei1/Claude-Codex-Workflow
```

Useful flags: `--yes` (install missing global tools without asking), `--dry-run`, `--project-only`, `--update-sections` (refresh the `CLAUDE.md`/`AGENTS.md` sections after an upgrade), `--impeccable-providers=codex` (if you already use the Impeccable plugin in Claude Code).

After setup, trust `.codex/hooks.json` in Codex (`/hooks`), and let Codex run `node .codex/autopilot.js verify|triage|close` outside the sandbox when it asks: those start headless Claude runs.

## Daily use

1. Describe the task to Claude, and choose **Orchestrator**.
2. Approve the plan. Claude ends with:
   ```
   Execute plans/<task>.md
   ```
3. Paste that line into Codex. Wait for `Task <task> done. Review and commit the changes.`
4. Review the working tree and commit.

Say "manual" to Claude to hand off one phase at a time instead.

## What's inside

```
commands/setup.md                  # /claude-codex-workflow:setup
package.json                       # npx entry point for the installer
skills/claude-codex-workflow/
  SKILL.md                         # the full guide: flow, setup, checks, troubleshooting
  scripts/install.js               # installs tools and sets up the project
  templates/
    CLAUDE.workflow.md             # merged into CLAUDE.md
    AGENTS.codex.md                # merged into AGENTS.md
    codex/hooks.json               # merged into .codex/hooks.json
    codex/hooks/claude-verify.js   # copied to .codex/hooks/claude-verify.js
    codex/hooks/workflow-lib.js    # copied to .codex/hooks/workflow-lib.js
    codex/autopilot.js             # copied to .codex/autopilot.js (the step helper Codex calls)
    plans/_template.md             # copied to plans/_template.md (phased plan template)
    skills/caveman/SKILL.md        # copied to .claude/skills/caveman/ and .agents/skills/caveman/
```

See [SKILL.md](skills/claude-codex-workflow/SKILL.md) for the full flow and troubleshooting.
