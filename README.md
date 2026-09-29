# Claude + Codex workflow

A Claude Code plugin that sets up this workflow in any project, new or existing, on any stack, on Windows, macOS or Linux:

- For each task, Claude asks whether to implement it directly or to act as orchestrator.
- As orchestrator, Claude writes a plan to `plans/<task>.md` and Codex implements it.
- When a Codex turn changes code, a Codex Stop hook starts a background Claude run (Sonnet, low effort). The run reviews the diff, runs the project's auto-detected checks, and fixes failures.
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
