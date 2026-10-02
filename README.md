# Claude + Codex workflow

A Claude Code plugin that sets up this workflow in any project, new or existing, on any stack, on Windows, macOS or Linux:

- For each task, Claude asks whether to implement it directly or to act as orchestrator.
- As orchestrator, Claude writes a phased plan to `plans/<task>.md`. Every phase has a runnable gate, and Codex implements one phase per turn.
- After each phase, a Codex Stop hook starts a background Claude run in two steps. Step A (Sonnet, low) runs the project's auto-detected checks and fixes only lint, formatting and type errors. Step B (Sonnet, medium; Opus for risky plans or paths) reviews the phase against the plan without editing, and ends with `VERDICT: PASS | NEEDS REWORK`.
- Risky plans can get an optional Codex review before any code is written.
- When the task is done, Claude writes a short summary to `docs/tasks/`.
- No agent ever commits or pushes: every change stays in the working tree for you to review and commit.
- **Autopilot:** once you approve a plan, `.codex/autopilot.js` runs every phase, its verification and rework, and the task summary on its own (`codex exec` plus headless Claude). Nothing is committed or pushed.
- graphify gives both agents a knowledge graph of the codebase.
- [Impeccable](https://github.com/pbakaus/impeccable) gives both agents design skills and a hook that flags UI problems.
- caveman keeps replies short when you want to save tokens.

## Install

In Claude Code:

```
/plugin marketplace add Jonrei1/Claude-Codex-Workflow
/plugin install claude-codex-workflow@claude-codex-workflow
```

Then, in the project you want to set up, ask Claude to "set up the Claude Codex workflow", or invoke the `claude-codex-workflow` skill.

Without the plugin system, copy `skills/claude-codex-workflow/` into `~/.claude/skills/` (every project) or `<project>/.claude/skills/` (one project).

## What's inside

```
skills/claude-codex-workflow/
  SKILL.md                         # the full guide: flow, setup, checks, troubleshooting
  templates/
    CLAUDE.workflow.md             # merge into CLAUDE.md
    AGENTS.codex.md                # merge into AGENTS.md
    codex/hooks.json               # merge into .codex/hooks.json
    codex/hooks/claude-verify.js   # copy to .codex/hooks/claude-verify.js
    codex/hooks/workflow-lib.js    # copy to .codex/hooks/workflow-lib.js
    codex/autopilot.js             # copy to .codex/autopilot.js
    plans/_template.md             # copy to plans/_template.md (phased plan template)
    skills/caveman/SKILL.md        # copy to .claude/skills/caveman/ and .agents/skills/caveman/
```

## Requirements

| Tool | Install |
|---|---|
| Node and git | your OS package manager |
| Claude Code CLI | `claude` on PATH (the verify hook calls it headless) |
| Codex | CLI or app |
| graphify | `uv tool install graphifyy` (or `pip install graphifyy`) |
| Impeccable | `npx impeccable install --project` |

See [SKILL.md](skills/claude-codex-workflow/SKILL.md) for the step-by-step setup.
