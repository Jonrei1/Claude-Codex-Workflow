---
name: claude-codex-workflow
description: >
  Set up the Claude + Codex workflow in a project, new or existing, on any stack, with one installer
  that also installs Claude Code, the Codex CLI, Playwright and graphify (Impeccable is optional).
  Everything is local to the clone (no tracked file changes, no merge conflicts). For every plan Claude
  asks whether it implements or orchestrates; as orchestrator it checks the plan against a criteria
  checklist, sends it to the open Codex session itself, and reviews the result automatically when Codex
  finishes, with parallel background checks, alignment review and a Playwright UI audit per phase.
  Use when the user asks to set up or install the Claude Codex workflow, add the Codex verify hook,
  set up the orchestrator/Codex handoff, or install the caveman/graphify/Impeccable workflow in a project.
---

# Claude + Codex workflow

A reusable setup for any project, new or existing, on any stack, on Windows, macOS or Linux:
- **Local only.** Plans (`.codex/plans/`), verify logs (`.codex/verify/<task>/`), task summaries (`.codex/tasks/`), the Claude rules (`CLAUDE.local.md`) and the Codex rules (`.codex/workflow/CODEX.md`) are hidden through `.git/info/exclude`. Setup never edits a tracked file, so teammates see no diff and there are no merge conflicts. `--shared` restores the old team-wide layout.
- **Ask on every plan.** For every new plan that changes app code, Claude asks: Codex implements (Claude orchestrates), Claude implements, or Codex with manual phases.
- **Criteria-checked plans.** As orchestrator, Claude writes a phased plan whose acceptance items have ids, and whose phases each declare Scope, Steps, Covers, Done when, Hands off (what the next phase relies on) and a runnable Gate. UI plans also carry a UI audit section. `autopilot.js check` enforces all of it before handoff.
- **Automatic handoff.** `autopilot.js handoff` posts `Execute .codex/plans/<task>.md ...` into the Codex session open in the repo (terminal or IDE) with `codex queue`, and says which session it used. Nothing to paste.
- **Failure baseline.** `begin` runs every gate and check on the untouched tree. Failures that were already there (errors in files the task never touches, a missing dependency) don't block gates or checks later; only new output lines do. `"baseline": false` in `.codex/verify.json` turns it off.
- **No silent stops.** Codex runs `autopilot.js stop --reason "..."` when it can't go on, the 3rd gate failure in a row stops the run, and `wait` marks the run stuck (with Codex's last message) if Codex's turn ends or its session closes mid-run.
- **Automatic review.** Claude runs `autopilot.js wait` in the background. When Codex finishes, Claude reads the per-phase reports, runs a final Playwright UI audit for UI plans, and reports, without being asked.
- **Parallel verification.** After each phase, Step A (checks, plus fixes for lint and type errors), Step B (alignment review) and Step C (Playwright UI audit, for UI phases) run at the same time in the background.
- **No agent ever commits or pushes.** Every change stays in the working tree for you to review and commit. Progress is tracked with snapshots (git tree objects that aren't commits and aren't on any branch).
- **One-command setup:** `scripts/install.js` (also `/claude-codex-workflow:setup` or `npx github:Jonrei1/Claude-Codex-Workflow`) installs the missing tools and wires everything into the project.
- graphify gives both agents a knowledge graph of the codebase. Playwright MCP is registered for Claude, which does the UI audits (`--playwright-codex` adds it to Codex). Impeccable (optional) adds design skills. caveman keeps replies short.

## When invoked

1. Check whether the project is new (no app code yet) or existing, and that it's a git repo (`git init` if not, after asking).
2. Run the installer from the project root: `node <this skill's folder>/scripts/install.js`.
   - The installer can't prompt from a Claude session. If it reports missing tools, show the install commands and ask before re-running with `--yes`.
   - Impeccable is optional: ask the user whether to install it before running the installer, then pass `--impeccable` or `--skip-impeccable`. Use `--impeccable-providers=codex` (which implies `--impeccable`) when the Impeccable plugin is already enabled in Claude Code. Mention that Impeccable's own installer writes shared project files.
   - If graphify isn't installed (`graphify --version` fails), ask whether to install it for the user only (recommended) or globally (system-wide pip, usually needs admin rights), then pass `--graphify-scope=user` or `--graphify-scope=global`. `--yes` doesn't install it.
   - Don't pass `--shared` unless the user asks for a team-wide setup.
3. Show the summary, and fix by hand anything it couldn't merge (for example a `hooks.json` that isn't valid JSON). See [What the installer does](#what-the-installer-does). Confirm `git status` shows no workflow files.
4. Read the checks it printed (`--print-checks`). If the list is wrong or empty, propose a `.codex/verify.json`. Also propose `alignment.riskPaths` for the project's schema, migration and auth paths, and a `ui` block (start command, URL, viewports, UI paths) for apps with a UI (see [Checks](#checks)).
5. List the steps left for the user (restart Claude Code, trust the hooks in Codex, let Codex's verify commands use the network, keep a Codex session open in the repo), then the new- or existing-project steps from [Setup](#setup).

## Flow

1. **Plan (you + Claude).** Describe the task. Before touching app code, Claude asks who implements **this** plan, even for small changes. It doesn't ask for read-only questions or doc/config-only edits.
   - **Claude implements:** Claude edits the code itself and runs the project's checks. For UI changes it runs the UI audit itself. Skip the rest.
   - **Codex implements (Claude orchestrates):** Claude writes `.codex/plans/<task>.md` from `.codex/plans/_template.md`:
     - frontmatter `task`, `risk`, `review`, `ui`;
     - the goal and the graphify impact list;
     - acceptance items `A1`, `A2`…;
     - for `ui: yes`, a `## UI audit` section;
     - 3-6 phases.

     When you approve, Claude runs `node .codex/autopilot.js check .codex/plans/<task>.md` and fixes the plan until every checklist item passes.
   - **Codex, manual phases:** the same plan, but Codex runs one phase per handoff, and the Codex Stop hook verifies each one.
   - **UI tasks:** if Impeccable is installed, Claude uses it (for example `/impeccable shape`). The plan names the Impeccable command Codex should run and the `DESIGN.md` sections to follow.
2. **Handoff (automatic).** Claude runs `node .codex/autopilot.js handoff .codex/plans/<task>.md`:
   - It asks the Codex app-server daemon, which every Codex TUI (terminal or IDE) runs on, for the sessions open right now (`codex app-server proxy`, then `thread/loaded/list` and `thread/read`). It takes the newest one whose folder is this repo, skipping `codex exec` runs, subagents and Codex's side threads, and posts the execute line into it with `codex queue`. A session counts as soon as Codex starts. No first message is needed.
   - The output names the session (`Sent to Codex session <id> (vscode, idle) in <folder>`). If several are open, it lists the others.
   - With no session open, it waits up to 90 s for one (`--wait <seconds>`, or `handoff.waitSeconds` in `.codex/verify.json`).
   - If no session appears, the app-server can't be reached, or `queue` fails, it prints the line to paste. It never opens a window on its own.
   - Exit 5 means it couldn't reach Codex and printed the line to paste.
   - `--thread <id>` (or `handoff.thread` in `.codex/verify.json`) pins the session, and `--new-terminal` skips the lookup and opens a new terminal running `codex "<line>"` (Windows Terminal or cmd, macOS Terminal, or `$TERMINAL`/x-terminal-emulator/gnome-terminal/konsole/xterm). `--phase N` sends a single phase (manual mode), and `--continue` resumes a stopped run.
   - It records what it did in `.codex/autopilot/handoff.json`.
3. **Watch (automatic).** Claude starts `node .codex/autopilot.js wait .codex/plans/<task>.md` in the background and tells you Codex is running. `wait` polls `.codex/autopilot/status.json` until the run is `done` (exit 0), `stuck` (4) or `failed` (1), or it times out (6, default 6 hours). It then prints the per-phase verdicts, report paths and changed files.
4. **Execute (Codex).** Codex follows `.codex/workflow/CODEX.md` "Full plan execution" (see [Codex execution](#codex-execution)).
5. **Review (automatic).** When `wait` returns, Claude reviews without being asked.
   - On `done`: Claude reads `.codex/verify/<task>/`, spot-checks the diff, runs the **final UI audit** for `ui: yes` plans (written to `.codex/verify/<task>/final-ui-audit.md`), and reports. If there are real problems, it proposes a rework plan and asks before handing it off.
   - On `stuck` or `failed`: Claude explains why and fixes the plan if needed. It asks before sending `handoff --continue`.
6. **Commit (you).** Review the working tree and commit, in one commit or per phase. Each phase may suggest a commit message.

## Codex execution

The handoff line has Codex run the whole task in its session, calling `.codex/autopilot.js` for everything that isn't implementation:

```
node .codex/autopilot.js check  .codex/plans/<slug>.md       # criteria checklist
node .codex/autopilot.js begin  .codex/plans/<slug>.md       # starting snapshot, status "running"
node .codex/autopilot.js triage .codex/plans/<slug>.md       # Claude triages Codex's plan findings
node .codex/autopilot.js phase  .codex/plans/<slug>.md <N>   # snapshot the phase's starting tree
node .codex/autopilot.js verify .codex/plans/<slug>.md <N>   # gate, then Steps A, B and C in parallel
node .codex/autopilot.js stop   .codex/plans/<slug>.md --reason "<why>"   # Codex can't go on: run marked stuck
node .codex/autopilot.js close  .codex/plans/<slug>.md       # graphify update + task summary, in parallel
```

1. **Preflight.** `check` validates the plan, and `begin` snapshots the working tree. Uncommitted changes you already had become part of that starting snapshot, so they aren't reviewed as the task's work.
2. **Plan review**, for `review: codex` or `risk: high`.
   - Codex appends `## Codex Findings`.
   - `triage` checks that the phases above the findings weren't changed. Then a headless Claude run (Sonnet, medium effort) marks each finding ACCEPTED or REJECTED and folds the accepted ones into the plan. It can only edit that plan file.
3. **Each phase:**
   - `phase N` snapshots the working tree, then Codex implements the phase.
   - `verify N` runs the gate. Failures that match the baseline don't count. If the gate has new failures (exit 2), Codex fixes them and runs `verify` again. The 3rd failure in a row stops the run as stuck. If the fix is out of the phase's reach, Codex runs `stop --reason`.
   - When the gate passes, `verify` runs `claude-verify.js --run` against the phase's starting snapshot. On NEEDS REWORK (exit 3) the output includes the combined report. Codex reworks and verifies again, up to 2 times. A third NEEDS REWORK stops the run as `stuck` (exit 4).
4. **Close.** `close` runs `graphify update .` while a headless Claude run (Sonnet, low effort) writes `.codex/tasks/<date>-<slug>.md`. Codex ends with `Task <slug> done. Claude is reviewing it.`

Nothing is committed, staged or pushed at any point. Progress is in `.codex/autopilot/status.json`: the state (`running`, `done`, `stuck` or `failed`), plus the phase, step, reason and per-phase verdicts. The step-by-step log is `.codex/autopilot/<slug>.log`. A Windows balloon notification (or a terminal bell elsewhere) fires when the run ends or stops.

- **`stuck`** means a decision is needed: a phase still fails review after 2 reworks, or the plan changed during review.
- **`failed`** means a step broke: a Claude call didn't start, crashed or timed out (30 minutes per call), or git failed.
- `verify`, `triage` and `close` start headless Claude runs. Inside Codex they need network access and a long command timeout. Approve them when Codex asks to run them outside the sandbox.
- While a Codex-driven run is unfinished, the Codex Stop hook stays quiet, because `verify` does the checking.
- **Unattended fallback:** `node .codex/autopilot.js run .codex/plans/<slug>.md [--resume] [--force]` does the same loop without an open Codex session. The driver calls `codex exec -s workspace-write` for each phase, gate fix and rework itself (`CODEX_AUTOPILOT=1` keeps the Stop hook quiet).

### Verification (Steps A, B and C, in parallel)

Each step's report is kept per task, in `.codex/verify/<slug>/phase-<N>.*`. Copies of the latest run are in `.codex/verify/last.log`, `alignment.md` and `phase.diff`.

- **Step A, checks.** The script runs the project's checks itself, auto-detected or listed in `.codex/verify.json` (see [Checks](#checks)). They run concurrently, except that build checks run last, on their own; `"parallelChecks": false` runs them one at a time.
  - If they all pass, no model is called.
  - If one fails, a headless Claude run (`sonnet`, effort `low`) fixes only lint, formatting and type errors, and the checks run again.
  - The script, not a model, flags any Impeccable live-mode block the change adds.
- **Step B, alignment** (`sonnet`, effort `medium`; `opus` when the plan has `risk: high` or the diff touches `alignment.riskPaths`).
  - It is report-only, with `Edit` and `Write` denied.
  - It lists DONE (against **Done when** and **Covers**), PARTIAL, MISSING, OUT OF SCOPE, HANDS OFF, GATE and RISKS, and ends with `VERDICT: PASS | NEEDS REWORK`.
- **Step C, UI audit.** It runs only when the phase has a `**UI audit:**` block, or when the plan has `ui: yes` and the change touches `ui.paths`.
  - The script reuses the app if something answers at the URL. Otherwise it starts the plan's `- Start:` command, after Step A's checks unless `ui.parallelWithChecks` is set, waits for the URL, and stops the app at the end.
  - A headless Claude run gets a Playwright MCP server: the global `@playwright/mcp` with its Chromium, `--headless --isolated`, and screenshots in `phase-<N>.ui/`. It audits each viewport, report-only, and ends with `UI AUDIT: PASS | NEEDS REWORK | BLOCKED`.
- **Verdict.** PASS needs all three:
  - alignment PASS;
  - checks passing after Step A;
  - a UI audit that isn't NEEDS REWORK. BLOCKED (for example, the app didn't start) is reported but doesn't fail the phase.

  The verified snapshot (`.codex/verify/state.json`) only advances on PASS. When you commit, HEAD becomes the new starting point.
- **Manual phases.** When a Codex turn ends and the working tree changed since the last verified snapshot, the Codex Stop hook runs the same verification in the background. Wait for `Finished` in `last.log` before starting another Codex turn.
- **Ignored changes.** Changes only to `.codex/`, `.claude/`, `.impeccable/`, `graphify-out/`, `CLAUDE.local.md` or `*.md` don't trigger a check.
- **Impeccable.** Live mode (`/impeccable live`) injects a `<script>` between `impeccable-live-start` and `impeccable-live-end`. Remove it before you commit. Run `/impeccable doctor` when Impeccable reports that `PRODUCT.md` or `DESIGN.md` is stale.
- **caveman.** Type `/caveman` in Claude Code, or say "caveman mode" to Codex, for terse replies.

## Setup

### One command

Run one of these from the project root (it must be a git repo):

```
/claude-codex-workflow:setup                                   # in Claude Code, with the plugin
npx github:Jonrei1/Claude-Codex-Workflow                       # anywhere, no plugin needed
node <skill folder>/scripts/install.js                         # from a copy of this skill
```

Flags:
- `--yes`: approve missing global tools and Playwright setup.
- `--dry-run`, `--tools-only`, `--project-only`.
- `--shared`: the team-wide layout in tracked files. `--update-sections` only applies with `--shared`.
- `--impeccable`, `--impeccable-providers=codex`, `--skip-impeccable`.
- `--graphify-scope=user|global`, `--skip-graphify`.
- `--skip-playwright`, `--playwright-codex`.
- `--root <dir>`.

Re-running keeps existing Playwright registrations and upgrades the `.codex/` scripts, `.codex/workflow/CODEX.md` and the `CLAUDE.local.md` section to the plugin's version. It also deletes files an earlier version installed that this one dropped (`.codex/workflow-manifest.json` records what it installed), and refreshes the plan template and caveman skills while you haven't edited them. After a plugin update, the plugin's SessionStart hook runs `install.js --sync` in projects that already have a manifest, so no re-run is needed; `--sync` is files-only and quiet. `--project-only` skips global tools, Chromium and MCP registration.

### What the installer does

**Tools.** It checks each one and installs it if it's missing. Global installs ask first (in a terminal) or need `--yes`.

| Tool | Install if missing | Notes |
|---|---|---|
| Node 18+ and git | your OS package manager (not automatic) | Node runs the hooks and the helper on every OS. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | The verify step calls it headless. |
| Codex CLI | `npm install -g @openai/codex` | Then `codex login` if `codex login status` fails. `codex queue` (used by the handoff) needs a recent Codex CLI. |
| Playwright MCP + Chromium | `npm install -g @playwright/mcp`, then its bundled Playwright CLI's `install chromium` | Registers a missing `playwright` server for Claude in user scope (and for Codex with `--playwright-codex`), using absolute Node, server and Chromium paths with `--headless --isolated`. The UI audit step uses the same installation. |
| graphify | `uv tool install graphifyy`, else `pipx install graphifyy`, else `pip install --user graphifyy` | If it lands outside PATH, the installer uses its full path. |
| Impeccable (optional) | nothing global | Only with `--impeccable` or a yes at the prompt. Runs through `npx`. |

**Project.** Setup never writes a file git tracks: such a step is reported and skipped. Everything below is local.

1. Copies `.codex/hooks/claude-verify.js`, `workflow-lib.js` and `claude-plan-gate.js`, `.codex/autopilot.js`, and writes the Codex rules to `.codex/workflow/CODEX.md`. These files always get the plugin's version.
2. Creates `.codex/plans/_template.md` and the caveman skill in `.claude/skills/caveman/` and `.agents/skills/caveman/`, if they're missing. It moves untracked plans from an old `plans/` folder into `.codex/plans/`.
3. Merges the `## Workflow` section into `CLAUDE.local.md`. Claude Code loads that file next to `CLAUDE.md`.
4. Adds a `PostToolUse` hook for `ExitPlanMode` to `.claude/settings.local.json`. After you approve a plan, it reminds Claude to confirm the role and to check, hand off and watch the plan.
5. Adds the verify and graphify hooks to `.codex/hooks.json`, keeping every existing entry, and upgrades an older workflow Stop hook in place. If the team tracks `.codex/hooks.json`, it's left alone, and only the Stop hook goes into the user-level `$CODEX_HOME/hooks.json`. That hook does nothing in repos without the workflow.
6. Hides all of it through `.git/info/exclude` (found with `git rev-parse --git-path`, so worktrees work). It never touches `.gitignore`.
7. Points out, without editing them, sections that an older version left in tracked `CLAUDE.md`, `AGENTS.md` or `.gitignore`. Remove them with your team in a normal commit.
8. graphify's own `graphify claude install` and `graphify codex install` edit `CLAUDE.md` and `AGENTS.md`, so they only run with `--shared`. The graphify rules are in `CLAUDE.local.md` and `CODEX.md` instead.
9. Only if you opted in, runs `npx -y impeccable install --project --providers=claude,codex`, then re-adds the workflow hooks if Impeccable's merge dropped them. Impeccable writes shared files of its own; review them before committing.
10. Prints the detected checks (`node .codex/hooks/claude-verify.js --print-checks`).

With `--shared`, the old layout is used instead:
- the sections go into `CLAUDE.md` and `AGENTS.md`;
- `.gitignore` gets the workflow-state entries;
- graphify's project installers run.

### Left for you

1. **Restart Claude Code.** It loads `CLAUDE.local.md` and the plan hook at start.
2. **Trust the hooks in Codex.** On the first Codex run in the project, Codex asks you to review and trust the hooks, or approve them with `/hooks`. Any later edit to a hooks file means trusting it again.
3. **Keep a Codex session open in the repo.** That's where the handoff posts plans. An IDE terminal is fine, and it doesn't need a message first. With none open, the handoff waits for one, then prints the line to paste.
4. **Let the verify step run from Codex.** `autopilot.js verify`, `triage` and `close` start headless Claude runs, which need the network and several minutes. Approve them when Codex asks to run them outside the sandbox.
5. If the detected checks are wrong or empty, add `.codex/verify.json` (see [Checks](#checks)). For UI work, add its `ui` block.
6. Commit `PRODUCT.md`, `DESIGN.md`, `.impeccable/config.json` and `.impeccable/design.json` when they exist, if your team wants them shared.
7. **Optional: tune the models.**
   - Step B's model, effort and risk model come from the `alignment` block in `.codex/verify.json`.
   - The UI audit's model and effort come from `ui.model` and `ui.effort`.
   - `node .codex/autopilot.js usage [.codex/plans/<task>.md]` sums the tokens and list-price cost of every headless call.
8. **Check `/mcp` in Claude for Playwright.** See the [README](../../README.md#playwright-browser-tools) for browser setup, limitations and troubleshooting.

Per-OS notes:
- **Windows:** Codex runs `commandWindows` from `hooks.json`. Impeccable's launcher is `impeccable.cmd`. If `npm run build` fails under Bash with `0xc0000142`, run it under PowerShell. The verify hook already allows PowerShell for its checks on Windows. `codex` is started through its `.cmd` shim, and `--new-terminal` prefers Windows Terminal (`wt.exe`).
- **macOS and Linux:** Codex runs `command`. Impeccable's launcher is the `impeccable` shell script. File names are case-sensitive on Linux, so use `DESIGN.md` and `PRODUCT.md` exactly.

### New project

1. Scaffold the app first, so there's a stack for the checks to detect. Then run the installer.
2. Run `/impeccable init` in Claude Code, if you installed Impeccable. It interviews you and writes `PRODUCT.md`.
3. Once there's code, build the first graph with `/graphify .` in Claude Code. After that, `graphify update .` keeps it current.

### Existing project

1. Run the installer. Check that `git status` stays clean.
2. Build the graph with `/graphify .` in Claude Code.
3. With Impeccable, run `/impeccable init`, then `/impeccable document` to capture the design system in `DESIGN.md`.
4. Upgrading from an earlier version: re-run the installer. It moves untracked plans to `.codex/plans/`, upgrades the Stop hook, and points out old sections in tracked files.

## Checks

`claude-verify.js` decides which commands Step A runs, in this order:

1. **`.codex/verify.json`**, if it has a `checks` list, is used exactly as written. An empty list means no checks.
2. Otherwise the checks are **detected from markers at the repo root.** Every stack found is included, in this order:

| Marker | Checks |
|---|---|
| `package.json` | The package manager comes from the lockfile: pnpm, yarn, bun, or npm by default. Checks: the `typecheck` script, or `tsc --noEmit` if there's a `tsconfig.json`; the `lint` script; the `build` script; the `test` script, unless it's npm's placeholder or runs in watch mode. |
| `Cargo.toml` | `cargo check`, `cargo test` |
| `go.mod` | `go vet ./...`, `go build ./...`, `go test ./...` |
| `pyproject.toml`, `setup.cfg`, `requirements*.txt` | `ruff check .` (ruff config), `mypy .` (mypy config), `pytest -q` (pytest config or `tests/`) |

For monorepos, or checks that live in sub-packages, use `verify.json`. For the fix step, each check is also added to `--allowedTools` as `Bash(<check>:*)`, plus `PowerShell(<check>:*)` on Windows.

The full `.codex/verify.json` (every block optional):

```json
{
  "checks": ["npm run typecheck", "npm run lint", "npm test"],
  "parallelChecks": true,
  "alignment": { "model": "sonnet", "effort": "medium", "riskModel": "opus", "riskPaths": ["**/migrations/**", "**/auth/**"] },
  "ui": {
    "startCommand": "npm run dev",
    "url": "http://localhost:3000",
    "readyTimeoutSec": 90,
    "viewports": [375, 1280],
    "paths": ["src/components/**", "app/**"],
    "parallelWithChecks": false,
    "model": "sonnet",
    "effort": "medium"
  },
  "handoff": { "thread": "" },
  "headless": { "settingSources": "project,local" }
}
```

- **`alignment`:** Step B switches to `riskModel` when the plan has `risk: high`, or when a changed file matches a `riskPaths` glob (`**` for any depth, `*` and `?` within a path segment).
- **`ui`:** the defaults for Step C and the plan checklist. A plan's `## UI audit` section (`- Start:`, `- URL:`, `- Viewports:`) overrides them.
- **`handoff.thread`:** pins the Codex session that plans are posted into.
- **`headless.settingSources`:** skips user-level settings, plugins and hooks in headless calls. It's off by default, because user settings can carry authentication or proxy environment.
- **Built-in tools only.** Every headless call gets only the built-in tools it needs and no MCP servers, except Step C's Playwright server.

The active plan and phase come from `.codex/verify/phase.json`, which Codex writes after a manual phase (`autopilot.js verify` passes them directly). Without it, the most recently edited plan in `.codex/plans/` is used. `--print-checks` shows the resolved range, plan, phase, model and UI audit settings.

## Plan checklist

`autopilot.js check` (and `handoff`, which refuses a plan that fails) prints a ✓/✗ list:

- **Frontmatter:** `task` matches the file name, `risk` is `normal|high`, `review` is `none|codex`, `ui` is `yes|no`.
- **Coverage:** `## Acceptance` items have ids (`- A1: ...`). Every id is covered by some phase's `**Covers:**`, and every Covers id exists.
- **Every phase:** has a title, **Scope**, **Steps**, **Covers**, **Done when**, and at least one **Gate** command. Every phase except the last has **Hands off**.
- **Runnable gates:**
  - an `npm run x`/`pnpm x`/`yarn x`/`bun run x` gate must name a script that exists in `package.json` (or a local binary);
  - any other program must be on PATH or in `node_modules/.bin`;
  - placeholders fail.
- **`ui: yes`:** needs a `## UI audit` section with checks, a URL and a start command (from the plan or from `verify.json` `ui`), and at least one phase with a `**UI audit:**` block.

## Templates

These files are in `templates/`, next to this `SKILL.md`. `scripts/install.js` copies or merges them for you.

| Template | Destination in the project | How |
|---|---|---|
| `CLAUDE.workflow.md` | `CLAUDE.local.md` (`CLAUDE.md` with `--shared`) | Merge the `## Workflow` section in. |
| `AGENTS.codex.md` | `.codex/workflow/CODEX.md` (also the `## Codex execution` section of `AGENTS.md` with `--shared`) | Written whole, without the HTML comment. |
| `codex/hooks.json` | `.codex/hooks.json` (or the Stop group into `$CODEX_HOME/hooks.json`) | Merge its entries with any that are already there. |
| `codex/hooks/claude-verify.js` | `.codex/hooks/claude-verify.js` | Copy it unchanged. |
| `codex/hooks/workflow-lib.js` | `.codex/hooks/workflow-lib.js` | Copy it unchanged. Shared by every script. |
| `codex/hooks/claude-plan-gate.js` | `.codex/hooks/claude-plan-gate.js` | Copy it unchanged; `.claude/settings.local.json` runs it after `ExitPlanMode`. |
| `codex/autopilot.js` | `.codex/autopilot.js` | Copy it unchanged. |
| `plans/_template.md` | `.codex/plans/_template.md` | Copy it. Every orchestrator plan starts from it. |
| `skills/caveman/SKILL.md` | `.claude/skills/caveman/SKILL.md` and `.agents/skills/caveman/SKILL.md` | Copy it to both places. |

About the hooks:
- **The Stop hook** starts the Claude check in manual phases. Its command does nothing when the repo has no `.codex/hooks/claude-verify.js`.
- **The two PreToolUse hooks** run graphify's guard, which steers Codex toward `graphify query`, `path` and `explain`. If `graphify` isn't on the PATH Codex sees, replace it with the full path.

## Troubleshooting

- **The installer says a tool is missing but doesn't install it:** It only installs global tools after asking in a terminal, or with `--yes`. From Claude, re-run with `--yes`.
- **The project still follows an old workflow, or an old `autopilot.js` runs:** Update the plugin and start a new session (its SessionStart hook runs `install.js --sync`), or run `/claude-codex-workflow:setup --project-only`. Both replace the scripts and rules and delete stale files. A project without `.codex/workflow-manifest.json` is only hinted at; run setup once. Then restart Claude Code and Codex. If the manifest shows a newer version than the plugin, update the plugin.
- **A Codex hook fails on every event (Stop or PostToolUse, "Design deep pass" / "Checking UI changes"):** Impeccable's installer writes a Windows hook command, `if exist "...impeccable.cmd" (... hook & exit /b)`, that is a syntax error when Codex runs it through PowerShell. Setup and the SessionStart sync (`install.js --sync`) rewrite it to `cmd.exe /d /c "if exist ... hook"`, which works in PowerShell and cmd, in the project's `.codex/hooks.json` and in `~/.codex/hooks.json`. If the project's file is tracked, it is fixed anyway (only the `commandWindows` line changes); commit it so teammates get the fix, and trust the hooks again in Codex (`/hooks`). Re-installing Impeccable rewrites the broken form; the next session's sync fixes it again.
- **A step says "tracked by git, left unchanged":** the file is committed in this repo. Nothing else is needed; the workflow uses its local equivalent. Use `--shared` only if the team wants the workflow committed.
- **The plan didn't reach Codex:** `handoff` only posts to a Codex session that is open right now in this repo, as reported by the Codex app-server daemon.
  - Start Codex there, or pin one with `--thread <id>` or `handoff.thread`. If it says it couldn't ask the app-server, check `codex app-server daemon version`.
  - If `codex queue` isn't available in your Codex CLI, update Codex. `--new-terminal` works without it.
  - Exit 5 printed the line to paste.
- **`wait` timed out (exit 6):** Codex never ran `begin`, or is still running. Check the Codex session, then wait again.
- **Claude didn't ask who implements the plan:** restart Claude Code so it loads `CLAUDE.local.md` and `.claude/settings.local.json`. Check that `/hooks` shows the ExitPlanMode hook.
- **`verify` fails inside Codex with `Failed to start claude` or a network error:** The Codex sandbox blocked the headless Claude run. Approve running the command outside the sandbox, and make sure `claude` is on the PATH Codex sees.
- **Codex's `verify` command gets cut off:** Its shell timeout is shorter than the Claude runs. Ask Codex to run it with a 30-minute timeout; it's safe to run `verify` again for the same phase.
- **UI audit is BLOCKED:** no app answered at the URL, the start command failed or timed out (see `.codex/verify/<task>/phase-<N>.app.log`), or the global Playwright MCP or Chromium is missing (re-run setup). Pages behind a login need state you provide.
- **Checks fail only when run together:** set `"parallelChecks": false` in `.codex/verify.json`.
- **`begin` says another run is still marked running:** `.codex/autopilot/status.json` is left over from a run that never finished. If no run is going, pass `--force`.
- **Unattended `run` says another run holds the lock:** `.codex/autopilot/running.lock` is left over. If no run is going, pass `--force` or delete the file.
- **Your own edits got mixed into an autopilot phase:** Edits you make while autopilot runs land in the phase's diff and can fail review. Leave the working tree alone until the run is done.
- **No log appears (manual phases):** Either the Codex hooks aren't trusted or enabled, or the working tree had no code changes.
- **A check never runs again:** A leftover `.codex/verify/running.lock` blocks new runs for 45 minutes. Delete it. Deleting `.codex/verify/state.json` forces a re-check of everything since HEAD.
- **A run reviews more than one phase:** The verified snapshot only advances on PASS, so after NEEDS REWORK the next run covers the old phase too. That's intended.
- **`alignment.md` has no VERDICT line:** Step B failed or stopped early. The run counts as NEEDS REWORK.
- **Step B didn't use Opus on a risky change:** Check `--print-checks`. The plan needs `risk: high`, or a changed file has to match `alignment.riskPaths`.
- **graphify guard errors in Codex:** `graphify` isn't on Codex's PATH. Use its full path in `hooks.json`.
- **Impeccable's launcher fails on Windows:** Re-run the workflow installer to repair existing Impeccable hooks.
- **A `localhost:8400/live.js` script shows up in the app layout:** Live mode left its block behind. Delete everything between `impeccable-live-start` and `impeccable-live-end` before you commit.
