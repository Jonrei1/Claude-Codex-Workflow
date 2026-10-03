---
name: claude-codex-workflow
description: >
  Set up the Claude + Codex workflow in a project, new or existing, on any stack, with one installer
  that also installs Claude Code, the Codex CLI, Playwright and graphify (Impeccable is optional). Claude either implements
  tasks directly or writes phased plans, then hands off with one pasted line (`Execute plans/<task>.md`)
  that has Codex run every phase, with a headless Claude run checking and reviewing each one.
  Playwright, graphify and caveman are wired in for both agents; Impeccable is optional.
  Use when the user asks to set up or install the Claude Codex workflow, add the Codex verify hook,
  set up the orchestrator/Codex handoff, or install the caveman/graphify/Impeccable workflow in a project.
---

# Claude + Codex workflow

A reusable setup for any project, new or existing, on any stack, on Windows, macOS or Linux:
- For each task, Claude asks whether to implement it directly or to act as orchestrator.
- As orchestrator, Claude writes a phased plan (each phase with a runnable gate), and Codex implements it one phase at a time.
- After each phase, a background Claude run checks Codex's work in two steps: Step A runs the auto-detected checks and fixes only lint, formatting and type errors. Step B reviews the phase against the plan, report-only, on Sonnet (Opus for risky work).
- Risky plans can get an optional Codex review before any code is written.
- When the task is done, Claude writes a short summary to `docs/tasks/`.
- **No agent ever commits or pushes.** Every change stays in the working tree for you to review and commit. Progress is tracked with snapshots (git tree objects that aren't commits and aren't on any branch).
- **One-paste execution** (the default handoff): Claude always ends an approved plan with one line, `Execute plans/<task>.md`. Paste it into Codex once, and Codex runs the whole task: plan review, every phase with its gate, Claude verification and rework, then the task summary.
- **One-command setup:** `scripts/install.js` (also `/claude-codex-workflow:setup` or `npx github:Jonrei1/Claude-Codex-Workflow`) installs the missing tools and wires everything into the project.
- graphify gives both agents a knowledge graph of the codebase.
- Playwright MCP gives both agents browser tools, with matching Chromium installed once.
  Request browser acceptance checks in the plan; the headless reviewers do not use MCP browser tools.
- Impeccable (optional, asked about at setup) gives both agents design skills (24 `/impeccable` commands) and a hook that flags UI problems after edits.
- caveman keeps replies short when you want to save tokens.

## When invoked

1. Check whether the project is new (no app code yet) or existing, and that it's a git repo (`git init` if not, after asking).
2. Run the installer from the project root: `node <this skill's folder>/scripts/install.js`. The installer can't prompt from a Claude session, so if it reports missing tools, show the install commands and ask before re-running with `--yes`. Impeccable is optional: ask the user whether to install it before running the installer, then pass `--impeccable` or `--skip-impeccable`. If graphify isn't installed (`graphify --version` fails), also ask whether to install it for the user only (recommended) or globally (system-wide pip, usually needs admin rights), then pass `--graphify-scope=user` or `--graphify-scope=global`. `--yes` doesn't install it. Use `--impeccable-providers=codex` (which implies `--impeccable`) when the Impeccable plugin is already enabled in Claude Code. If a workflow section already exists but differs, offer `--update-sections`.
3. Show the summary, and fix by hand anything it couldn't merge (for example a `hooks.json` that isn't valid JSON). See [What the installer does](#what-the-installer-does).
4. Read the checks it printed (`--print-checks`). If the list is wrong or empty, propose a `.codex/verify.json`. Also propose `alignment.riskPaths` for the project's schema, migration and auth paths (see [Checks](#checks)).
5. List the steps left for the user (trusting the hooks in Codex, letting Codex's verify commands use the network), then the new- or existing-project steps from [Setup](#setup).

## Flow

1. **Plan (you + Claude):** Describe the task. Before touching app code, Claude asks which role it should take. It asks even for small changes.
   - **Implement directly:** Claude edits the code itself and runs the project's checks. Skip steps 2-6.
   - **Orchestrator (planner):** Claude only writes `plans/<task>.md` from `plans/_template.md`: frontmatter (`risk`, `review`), goal, graphify impact list, acceptance, then 3-6 phases. Each phase has a scope, steps, a runnable gate and, optionally, a suggested commit message for you. Once you approve it, Claude runs `node .codex/autopilot.js check plans/<task>.md` and **always** ends its reply with the paste line in its own code block: `Execute plans/<task>.md`. It doesn't edit app code, and it doesn't start Codex or autopilot itself.
   - Claude doesn't ask for read-only questions or for doc/config-only edits (`*.md`, `plans/`, `.claude/`, `.codex/`).
   - **UI tasks:** if Impeccable is installed, Claude uses it (for example `/impeccable shape` to plan a screen). A UI plan names the Impeccable command Codex should run and the `DESIGN.md` sections it must follow.
2. **Handoff (you):** Copy the line and paste it into Codex. That's the only paste: Codex runs the whole task, as described in [One-paste execution](#one-paste-execution). Steps 3 to 7 below describe the **manual** handoff (say "manual" to Claude), where you paste one phase at a time.
3. **Manual: optional plan review (Codex):** for `review: codex` or `risk: high`, Claude ends with `Review plans/<task>.md` instead. Paste it into a **fresh** Codex session. Codex checks the plan against the codebase and appends `## Codex Findings`, without touching the phases. Accept or reject the findings, then paste `Execute phase 1 of plans/<task>.md`.
4. **Manual: implement one phase (Codex):** Codex does exactly one phase, runs its gate, writes `.codex/verify/phase.json` (which plan and phase it just did), runs `graphify update .`, and stops with `Phase N done. Gate: <command> -> pass`. It never commits. For UI work with Impeccable installed it uses that skill, and Impeccable's hook flags design problems after each edit.
5. **Manual: automatic check (Codex Stop hook -> Claude):** When Codex's turn ends and the working tree changed since the last verified snapshot, two headless Claude runs start in the background, one after the other. Both read the change from `.codex/verify/phase.diff`:
   - **Step A, checks:** the script runs the project's checks itself, auto-detected or listed in `.codex/verify.json` (see [Checks](#checks)). If they all pass, no model is called. If one fails, a headless Claude run (`sonnet`, effort `low`) gets the failing output, fixes only lint, formatting and type errors, and reports every other failure; the script then runs the checks again for the final result. The script, not a model, flags any Impeccable live-mode block the change adds. Report: `.codex/verify/last.log`.
   - **Step B, alignment** (`sonnet`, effort `medium`; `opus` when the plan has `risk: high` or the diff touches `alignment.riskPaths`): report-only, with `Edit` and `Write` denied. It lists DONE, PARTIAL, MISSING, OUT OF SCOPE, GATE and RISKS for the phase and ends with `VERDICT: PASS | NEEDS REWORK`. Report: `.codex/verify/alignment.md`.
   - The verified snapshot (`.codex/verify/state.json`) only advances on PASS, so a phase that needs rework is reviewed again on the next run. When you commit, HEAD becomes the new starting point.
6. **Manual: result (you):** Read `last.log` (it ends with `Finished` and the verdict) and `alignment.md`. On NEEDS REWORK, send the findings back to Codex. On PASS, paste the next phase. Commit whenever you like: after each phase, or once at the end.
7. **Manual: close (you + Claude):** Say `close <task>`. Claude reads the plan, `alignment.md` and the diff, and writes `docs/tasks/<YYYY-MM-DD>-<task>.md` (25 lines max). You commit it with the work.

## One-paste execution

After you approve a plan, Claude ends its reply with this line, in its own code block:

```
Execute plans/<slug>.md
```

Paste it into Codex once. Codex follows AGENTS.md "Full plan execution" and runs the whole task in that session, calling `.codex/autopilot.js` for everything that isn't implementation:

```
node .codex/autopilot.js check  plans/<slug>.md       # validate (every phase needs a real gate)
node .codex/autopilot.js begin  plans/<slug>.md       # starting snapshot, status "running"
node .codex/autopilot.js triage plans/<slug>.md       # Claude triages Codex's plan findings
node .codex/autopilot.js phase  plans/<slug>.md <N>   # snapshot the phase's starting tree
node .codex/autopilot.js verify plans/<slug>.md <N>   # gate, then Step A + Step B
node .codex/autopilot.js close  plans/<slug>.md       # graphify update + task summary
```

What happens:

1. **Preflight.** `check` validates the plan. `begin` snapshots the working tree. Uncommitted changes you already had become part of that starting snapshot, so they aren't reviewed as the task's work.
2. **Plan review**, for `review: codex` or `risk: high`.
   - Codex appends `## Codex Findings`, following "Plan review".
   - `triage` checks that the phases above the findings weren't changed. Then a headless Claude run (Sonnet, medium effort) marks each finding ACCEPTED or REJECTED and folds the accepted ones into the plan. It can only edit that plan file.
3. **Each phase:**
   - `phase N` snapshots the working tree, then Codex implements the phase.
   - `verify N` runs the gate. If it fails (exit 2), Codex fixes it and runs `verify` again.
   - Then it runs `claude-verify.js --run` against the phase's starting snapshot (Step A, then Step B) and prints the verdict.
   - On NEEDS REWORK (exit 3), the output includes `alignment.md`. Codex reworks and runs `verify` again, up to 2 times. A third NEEDS REWORK stops the run as `stuck` (exit 4).
4. **Close.** `close` runs `graphify update .`, then a headless Claude run (Sonnet, low effort) writes `docs/tasks/<date>-<slug>.md`. It can only write that file. Codex ends with `Task <slug> done. Review and commit the changes.`

Nothing is committed, staged or pushed at any point. When the run is done, review the working tree and commit it yourself, in one commit or per phase (each phase may suggest a message). Progress is in `.codex/autopilot/status.json` (`running`, `done`, `stuck` or `failed`, with the phase, step and reason). The step-by-step log is `.codex/autopilot/<slug>.log`. A Windows balloon notification (or a terminal bell elsewhere) fires when the run ends or stops.

- **`stuck`** means a decision is needed: a phase still fails review after 2 reworks, or the plan changed during review. Read `alignment.md`, fix the plan or the code (or ask Claude to), then tell Codex to continue. It runs the step that stopped again.
- **`failed`** means a step broke: a Claude call that didn't start, crashed or timed out (30 minutes per call), or a git error. Fix the cause, then tell Codex to continue.
- `verify`, `triage` and `close` start headless Claude runs. Inside Codex they need network access and a long command timeout. Approve them when Codex asks to run them outside the sandbox.
- While a Codex-driven run is unfinished (`running`, `stuck` or `failed`), the Codex Stop hook stays quiet, because `verify` does the checking.
- **Manual handoff** still works. Say "manual" when Claude finishes the plan, and paste the phases yourself as in the Flow above.
- **Unattended fallback:** `node .codex/autopilot.js run plans/<slug>.md [--resume] [--force]` does the same loop without an open Codex session: the driver calls `codex exec -s workspace-write` for each phase, gate fix and rework itself (`CODEX_AUTOPILOT=1` keeps the Stop hook quiet). Each Codex and Claude call saves its output next to the log.

Rules of thumb:

- In a manual handoff, wait for `Finished` in the log before starting another Codex turn, so two agents don't edit the same files. A run is two Claude calls, so it takes longer than a plain check.
- Some turns don't trigger a check:
  - turns that change only `plans/`, `.codex/`, `.claude/`, `.impeccable/`, `graphify-out/` or `*.md`
  - a state that was already verified (including a NEEDS REWORK state that hasn't changed since)
- Step A can only read and edit files, run git diff/status, and run the detected checks. Step B can only read files and run git diff/status/show. Neither commits, touches databases, or opens a browser.
- Both reports are overwritten on each run. They fill in when each step finishes, not line by line. The next Codex Stop after a run also shows the verdict as a system message.
- Impeccable's live mode (`/impeccable live`) injects a `<script>` into the app's root layout, between `impeccable-live-start` and `impeccable-live-end` comments. Exit live mode, or delete that block, before you commit. Otherwise it ships to production.
- Run `/impeccable doctor` when Impeccable reports that `PRODUCT.md` or `DESIGN.md` is stale.
- Type `/caveman` in Claude Code, or say "caveman mode" to Codex, for terse replies. `/caveman lite|full|ultra` sets how terse.

## Setup

### One command

Run one of these from the project root (it must be a git repo):

```
/claude-codex-workflow:setup                                   # in Claude Code, with the plugin
npx github:Jonrei1/Claude-Codex-Workflow                       # anywhere, no plugin needed
node <skill folder>/scripts/install.js                         # from a copy of this skill
```

Flags: `--yes` (approve missing global tools and Playwright setup), `--dry-run`, `--tools-only`, `--project-only`, `--update-sections`, `--impeccable`, `--impeccable-providers=codex`, `--graphify-scope=user|global`, `--skip-graphify`, `--skip-impeccable`, `--skip-playwright`, `--root <dir>`. Re-running keeps existing Playwright registrations and upgrades the `.codex/` scripts to the plugin's version. `--project-only` skips global tools, Chromium and MCP registration.

### What the installer does

**Tools.** It checks each one and installs it if it's missing. Global installs ask first (in a terminal) or need `--yes`.

| Tool | Install if missing | Notes |
|---|---|---|
| Node 18+ and git | your OS package manager (not automatic) | Node runs the hooks and the helper on every OS. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | The verify step calls it headless. |
| Codex CLI | `npm install -g @openai/codex` | Then `codex login` if `codex login status` fails. |
| Playwright MCP + Chromium | `npm install -g @playwright/mcp`, then its bundled Playwright CLI's `install chromium` | Registers missing `playwright` servers in Claude user scope and Codex user config, using absolute Node, server and Chromium paths with `--headless --isolated`. Existing entries are kept. Use `--skip-playwright` to opt out. |
| graphify | `uv tool install graphifyy`, else `pipx install graphifyy`, else `pip install --user graphifyy` | If it lands outside PATH, the installer uses its full path. |
| Impeccable (optional) | nothing global | Only with `--impeccable` or a yes at the prompt. Runs through `npx`. Claude Code can use the Impeccable plugin instead (then pass `--impeccable-providers=codex`). |

**Project.** It never overwrites `CLAUDE.md`, `AGENTS.md` or `.codex/hooks.json`; it merges into them.

1. Copies `.codex/hooks/claude-verify.js`, `.codex/hooks/workflow-lib.js` and `.codex/autopilot.js` (always the plugin's version).
2. Creates `plans/_template.md`, the caveman skill in `.claude/skills/caveman/` and `.agents/skills/caveman/`, and `docs/tasks/.gitkeep`, if they're missing.
3. Appends the `## Workflow` section to `CLAUDE.md` and the `## Codex execution` section to `AGENTS.md`. If a section exists and differs, it says so; `--update-sections` replaces it.
4. Adds the verify and graphify hooks to `.codex/hooks.json`, keeping every existing entry.
5. Adds `.codex/verify/`, `.codex/autopilot/`, `graphify-out/`, `plans/*` and `!plans/_template.md` to `.gitignore`. Plans are local handoffs, not history; `plans/*` (not `plans/`) lets the template be re-included.
6. Runs `graphify claude install` and `graphify codex install`, then makes sure both files end with the once-per-task graphify rule.
7. Only if you opted in (`--impeccable`, or yes at the prompt), runs `npx -y impeccable install --project --providers=claude,codex`, then re-adds the verify and graphify hooks if Impeccable's merge dropped them. Impeccable writes its own local-state ignores to `.git/info/exclude`.
8. Prints the detected checks (`node .codex/hooks/claude-verify.js --print-checks`).

### Left for you

1. **Trust the hooks in Codex.** On the first Codex run in the project, Codex asks you to review and trust `.codex/hooks.json`, or approve them with `/hooks`. The trust is stored under `[hooks.state]` in `~/.codex/config.toml`. Any later edit to `hooks.json` means trusting it again.
2. **Let the verify step run from Codex.** `autopilot.js verify`, `triage` and `close` start headless Claude runs, which need the network and several minutes. Approve them when Codex asks to run them outside the sandbox.
3. If the detected checks are wrong or empty, add `.codex/verify.json` (see [Checks](#checks)). You never edit the script for this.
4. Commit `PRODUCT.md`, `DESIGN.md`, `.impeccable/config.json` and `.impeccable/design.json` when they exist.
5. Keep `.claude/settings.json` free of hooks that block Claude from editing code. Impeccable's Claude hook only reports findings; it doesn't block.
6. **Optional: tune the models.** Step B's model, effort and risk model come from the `alignment` block in `.codex/verify.json` (see [Checks](#checks)). The model for Step A's fix step (`--model sonnet --effort low`) is in `claude-verify.js`. `node .codex/autopilot.js usage [plans/<task>.md]` sums the tokens and list-price cost of every headless call, from `.codex/verify/usage.jsonl`.
7. **Restart both clients and check `/mcp` for Playwright.** Start the application before
   requesting browser checks. Browser binaries are cached per user; Linux may also need
   system dependencies. See the [README](../../README.md#playwright-browser-tools) for
   browser setup, limitations and troubleshooting, and its [usage guide](../../README.md#token-usage-for-claude-and-codex)
   for separate Claude/Codex consumption and the per-phase review overhead.

Per-OS notes:
- **Windows:** Codex runs `commandWindows` from `hooks.json`. Impeccable's launcher is `impeccable.cmd`. If `npm run build` fails under Bash with `0xc0000142`, run it under PowerShell. The verify hook already allows PowerShell for its checks on Windows.
- **macOS and Linux:** Codex runs `command`. Impeccable's launcher is the `impeccable` shell script. File names are case-sensitive on Linux, so use `DESIGN.md` and `PRODUCT.md` exactly.

### New project

1. Scaffold the app first, so there's a stack for the checks to detect. Then run the installer.
2. Run `/impeccable init` in Claude Code. It interviews you and writes `PRODUCT.md`.
3. Once there's code, build the first graph with `/graphify .` in Claude Code. After that, `graphify update .` keeps it current; it reads the code only and makes no API calls.
4. `DESIGN.md` comes from Impeccable after the first visual build, or run `/impeccable document` later.

### Existing project

1. Run the installer. It merges into the files that are already there.
2. Build the graph with `/graphify .` in Claude Code.
3. Run `/impeccable init` to write `PRODUCT.md`, then `/impeccable document` to capture the current design system in `DESIGN.md`. If the project already had an older Impeccable setup, run `/impeccable doctor` instead to bring it up to date.
4. If the repo already has UI conventions in another file, merge them into `DESIGN.md`, or point `CLAUDE.md` and `AGENTS.md` at that file.
5. Upgrading from an earlier version of this workflow: re-run the installer with `--update-sections` so `CLAUDE.md` and `AGENTS.md` get the one-paste handoff.

## Checks

`claude-verify.js` decides which commands the background Claude runs, in this order:

1. **`.codex/verify.json`**, if it exists, is used exactly as written:
   ```json
   { "checks": ["npm run typecheck", "npm run lint", "npm test"] }
   ```
   An empty list means no checks; the run only reviews the diff.
2. Otherwise the checks are **detected from markers at the repo root.** Every stack found is included, in this order:

| Marker | Checks |
|---|---|
| `package.json` | The package manager comes from the lockfile: pnpm, yarn, bun, or npm by default. Checks: the `typecheck` script, or `tsc --noEmit` if there's a `tsconfig.json`; the `lint` script; the `build` script; the `test` script, unless it's npm's placeholder or runs in watch mode. |
| `Cargo.toml` | `cargo check`, `cargo test` |
| `go.mod` | `go vet ./...`, `go build ./...`, `go test ./...` |
| `pyproject.toml`, `setup.cfg`, `requirements*.txt` | `ruff check .` (ruff config), `mypy .` (mypy config), `pytest -q` (pytest config or `tests/`) |

For monorepos, or checks that live in sub-packages, use `verify.json`. The script runs each check through the shell. For the fix step, each check is also added to `--allowedTools` as `Bash(<check>:*)`, plus `PowerShell(<check>:*)` on Windows, so that run can't execute anything else.

### Headless call settings

Every headless Claude call gets only the built-in tools it needs and no MCP servers, which cuts each call's fixed input. The optional `headless` block in `.codex/verify.json` can also skip user-level settings, plugins and hooks. This is off by default, because user settings can carry authentication or proxy environment:

```json
{ "headless": { "settingSources": "project,local" } }
```

### Alignment settings

The optional `alignment` block in `.codex/verify.json` configures Step B. Every key is optional. These are the defaults, except `riskPaths`, which defaults to none:

```json
{
  "alignment": {
    "model": "sonnet",
    "effort": "medium",
    "riskModel": "opus",
    "riskPaths": ["**/migrations/**", "**/auth/**", "prisma/schema.prisma"]
  }
}
```

Step B switches to `riskModel` when the active plan's frontmatter says `risk: high`, or when a changed file matches a `riskPaths` glob (`**` for any depth, `*` and `?` within a path segment). A `verify.json` with only an `alignment` block keeps the auto-detected checks.

The active plan and phase come from `.codex/verify/phase.json`, which Codex writes after a phase (`autopilot.js verify` passes them directly). Without it, the most recently edited plan is used, and Step B infers the phase. `--print-checks` shows the resolved range, plan, phase and model.

## Templates

These files are in `templates/`, next to this `SKILL.md`. `scripts/install.js` copies or merges them for you; this table is what it does, for doing it by hand.

| Template | Destination in the project | How |
|---|---|---|
| `CLAUDE.workflow.md` | `CLAUDE.md` | Merge the `## Workflow` section in. |
| `AGENTS.codex.md` | `AGENTS.md` | Merge the `## Codex execution` section in. Make sure graphify's section ends with the once-per-task rule. |
| `codex/hooks.json` | `.codex/hooks.json` | Merge its entries with any that are already there. Impeccable's installer adds its own entries next to them. |
| `codex/hooks/claude-verify.js` | `.codex/hooks/claude-verify.js` | Copy it unchanged. |
| `codex/hooks/workflow-lib.js` | `.codex/hooks/workflow-lib.js` | Copy it unchanged. Both scripts use it for plan parsing and snapshots. |
| `codex/autopilot.js` | `.codex/autopilot.js` | Copy it unchanged. |
| `plans/_template.md` | `plans/_template.md` | Copy it. Every orchestrator plan starts from it. Replace the gate examples with the project's real commands. |
| `skills/caveman/SKILL.md` | `.claude/skills/caveman/SKILL.md` and `.agents/skills/caveman/SKILL.md` | Copy it to both places. |

About the hooks: the Stop hook starts the Claude check. The two PreToolUse hooks run graphify's guard, which steers Codex toward `graphify query`, `path` and `explain` before it falls back to grep or reads raw files. If `graphify` isn't on the PATH Codex sees, replace `graphify` with the full path, for example `C:/Users/<you>/.local/bin/graphify.EXE`.

Also create an empty `docs/tasks/` folder (with a `.gitkeep`) for the task summaries.

`claude-verify.js` prints a JSON object (`{}` or `{ "systemMessage": ... }`) on stdout, which is what Codex hooks expect. It works unchanged in any project. See [Checks](#checks) for how it picks commands.

## Troubleshooting

- **The installer says a tool is missing but doesn't install it:** It only installs global tools after asking in a terminal, or with `--yes`. From Claude, re-run with `--yes`.
- **The installer says a section "exists and differs":** The project has an older `## Workflow` or `## Codex execution` section. Re-run with `--update-sections` to replace just that section.
- **`verify` fails inside Codex with `Failed to start claude` or a network error:** The Codex sandbox blocked the headless Claude run. Approve running the command outside the sandbox, and make sure `claude` is on the PATH Codex sees.
- **Codex's `verify` command gets cut off:** Its shell timeout is shorter than the Claude run. Ask Codex to run it with a 30-minute timeout; it's safe to run `verify` again for the same phase.
- **`begin` says another run is still marked running:** `.codex/autopilot/status.json` is left over from a run that never finished. If no run is going, pass `--force`.
- **Unattended `run` says another run holds the lock:** `.codex/autopilot/running.lock` is left over from a run that was killed. If no run is going, pass `--force` or delete the file.
- **Your own edits got mixed into an autopilot phase:** Edits you make while autopilot runs land in the phase's diff and can fail review. Leave the working tree alone until the run is done.
- **Unattended `run` stops with `codex ... exited`:** Open the matching `.codex/autopilot/<slug>.codex.*.out.log`. Common causes: `codex` isn't logged in, or the workspace-write sandbox blocked a command the phase needs.

- **No log appears:** Either the Codex hooks aren't trusted or enabled (see [Left for you](#left-for-you)), or the working tree had no code changes.
- **The log says `Failed to start claude`:** `claude` isn't on the PATH that Codex sees.
- **The log lists the wrong checks, or none:** Run `node .codex/hooks/claude-verify.js --print-checks` to see what's detected, then add `.codex/verify.json`.
- **A check fails with `0xc0000142` on Windows:** Bash couldn't start a child process. The verify run retries under PowerShell. Run the check yourself in PowerShell to confirm.
- **A check never runs again:** A leftover `.codex/verify/running.lock` blocks new runs for 45 minutes. Delete it. Deleting `.codex/verify/state.json` forces a re-check of everything since HEAD.
- **A run reviews more than one phase:** The verified snapshot only advances on PASS, so after NEEDS REWORK the next run covers the old phase too. That's intended. To start fresh, commit what you trust (HEAD becomes the new start), or delete `state.json`.
- **`alignment.md` has no VERDICT line:** Step B failed or stopped early. The run counts as NEEDS REWORK. Check the bottom of `alignment.md` for the error.
- **Step B didn't use Opus on a risky change:** Check `--print-checks`. The plan needs `risk: high` in its frontmatter, or a changed file has to match `alignment.riskPaths`.
- **graphify guard errors in Codex:** `graphify` isn't on Codex's PATH. Use its full path in `hooks.json`.
- **The graph is stale or missing:** Run `graphify update .`, or `/graphify .` in Claude Code for a full rebuild.
- **Impeccable's hook never fires in Codex:** Approve the updated `hooks.json` with `/hooks`, then check the project's status with `/impeccable hooks status`.
- **`npx impeccable install` fails with `Could not verify skill bundle: HTTP 404`:** The server couldn't serve the skill bundle, and nothing was installed. Retry later, or follow https://github.com/pbakaus/impeccable/issues/479.
- **Impeccable's launcher fails on Windows:** Call `impeccable.cmd` instead of the `sh` launcher.
- **A `localhost:8400/live.js` script shows up in the app layout:** Live mode left its block behind. Delete everything between `impeccable-live-start` and `impeccable-live-end` before you commit.
