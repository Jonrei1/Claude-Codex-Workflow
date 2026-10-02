---
name: claude-codex-workflow
description: >
  Set up the Claude + Codex workflow in a project, new or existing, on any stack. Claude either
  implements tasks directly or writes phased plans for Codex. A Codex Stop hook starts a background
  Claude run that checks Codex's work, fixes mechanical failures, and reviews each phase against the
  plan without editing. graphify, Impeccable and caveman are wired in for both agents.
  Use when the user asks to set up the Claude Codex workflow, add the Codex verify hook, set up the
  orchestrator/Codex handoff, or install the caveman/graphify/Impeccable workflow in a project.
---

# Claude + Codex workflow

A reusable setup for any project, new or existing, on any stack, on Windows, macOS or Linux:
- For each task, Claude asks whether to implement it directly or to act as orchestrator.
- As orchestrator, Claude writes a phased plan (each phase with a runnable gate), and Codex implements it one phase and one commit at a time.
- After each phase, a background Claude run checks Codex's work in two steps: Step A runs the auto-detected checks and fixes only lint, formatting and type errors. Step B reviews the phase against the plan, report-only, on Sonnet (Opus for risky work).
- Risky plans can get an optional Codex review before any code is written.
- When the task is done, Claude writes a short summary to `docs/tasks/`, which is committed.
- graphify gives both agents a knowledge graph of the codebase.
- Impeccable gives both agents design skills (24 `/impeccable` commands) and a hook that flags UI problems after edits.
- caveman keeps replies short when you want to save tokens.

## When invoked

1. Check whether the project is new (no app code yet) or existing. Detect its stack from files at the repo root.
2. Copy or merge the files from `templates/` in this skill's folder, as listed in [Templates](#templates).
   Never overwrite an existing `CLAUDE.md`, `AGENTS.md` or `.codex/hooks.json`. Merge sections and entries into them.
3. Create `docs/tasks/` (with a `.gitkeep`). Add `.codex/verify/`, `graphify-out/`, `plans/*` and `!plans/_template.md` to `.gitignore`. Always ignore `plans/*`: plan files are local handoffs between Claude and Codex, not project history. The template is the one exception, so every clone has it.
4. Run `node .codex/hooks/claude-verify.js --print-checks` and show the result. If the list is wrong or empty, propose a `.codex/verify.json`. Also propose `alignment.riskPaths` for the project's schema, migration and auth paths (see [Checks](#checks)).
5. List the manual steps that are left for the user: `graphify claude install` and `graphify codex install`,
   `npx impeccable install --project`, and trusting the hooks in Codex. Then give the new- or existing-project steps from [Setup](#setup).

## Flow

1. **Plan (you + Claude):** Describe the task. Before touching app code, Claude asks which role it should take. It asks even for small changes.
   - **Implement directly:** Claude edits the code itself and runs the project's checks. Skip steps 2-6.
   - **Orchestrator (planner):** Claude only writes `plans/<task>.md` from `plans/_template.md`: frontmatter (`risk`, `review`, `base`), goal, graphify impact list, acceptance, then 3-6 phases. Each phase has a scope, steps, a runnable gate and a `phase(<slug>): N <title>` commit message. Claude ends its reply with `Execute phase 1 of plans/<task>.md`. It doesn't edit app code.
   - Claude doesn't ask for read-only questions or for doc/config-only edits (`*.md`, `plans/`, `.claude/`, `.codex/`).
   - **UI tasks:** Claude uses Impeccable (for example `/impeccable shape` to plan a screen). A UI plan names the Impeccable command Codex should run and the `DESIGN.md` sections it must follow.
2. **Optional plan review (Codex):** for `review: codex` or `risk: high`, Claude ends with `Review plans/<task>.md` instead. Paste it into a **fresh** Codex session. Codex checks the plan against the codebase and appends `## Codex Findings`, without touching the phases. Accept or reject the findings, then start execution.
3. **Handoff (you):** Review the plan, then paste `Execute phase 1 of plans/<task>.md` into Codex.
4. **Implement one phase (Codex):** Codex does exactly one phase, runs its gate, commits with the phase's message, runs `graphify update .`, and stops with `Phase N done. Gate: <command> -> pass`. For UI work it uses the Impeccable skill, and Impeccable's hook flags design problems after each edit.
5. **Automatic check (Codex Stop hook -> Claude):** When Codex's turn ends and code changed since the last verified commit (committed phases plus the working tree), two headless Claude runs start in the background, one after the other:
   - **Step A, checks** (`sonnet`, effort `low`): runs the project's checks, auto-detected or listed in `.codex/verify.json` (see [Checks](#checks)). It fixes only lint, formatting and type errors, and reports every other failure. It reports, without removing, any Impeccable live-mode block. Report: `.codex/verify/last.log`.
   - **Step B, alignment** (`sonnet`, effort `medium`; `opus` when the plan has `risk: high` or the diff touches `alignment.riskPaths`): report-only, with `Edit` and `Write` denied. It lists DONE, PARTIAL, MISSING, OUT OF SCOPE, GATE and RISKS for the phase and ends with `VERDICT: PASS | NEEDS REWORK`. Report: `.codex/verify/alignment.md`.
   - The verified commit (`.codex/verify/state.json`) only advances on PASS, so a phase that needs rework is reviewed again on the next run.
6. **Result (you):** Read `last.log` (it ends with `Finished` and the verdict) and `alignment.md`. On NEEDS REWORK, send the findings back to Codex. On PASS, paste the next phase. Step A's fixes are left uncommitted, and Codex commits them first at the start of the next phase.
7. **Close (you + Claude):** Say `close <task>`. Claude reads the plan, `alignment.md` and the phase commits, writes `docs/tasks/<YYYY-MM-DD>-<task>.md` (25 lines max, real SHAs), and commits only that file.

Rules of thumb:

- Wait for `Finished` in the log before starting another Codex turn, so two agents don't edit the same files. A run is two Claude calls, so it takes longer than a plain check.
- Some turns don't trigger a check:
  - turns that change only `plans/`, `.codex/`, `.claude/`, `.impeccable/`, `graphify-out/` or `*.md`
  - a state that was already verified (including a NEEDS REWORK state that hasn't changed since)
- Step A can only read and edit files, run git diff/status/log, and run the detected checks. Step B can only read files and run git diff/status/log/show. Neither commits, touches databases, or opens a browser.
- Both reports are overwritten on each run. They fill in when each step finishes, not line by line. The next Codex Stop after a run also shows the verdict as a system message.
- Impeccable's live mode (`/impeccable live`) injects a `<script>` into the app's root layout, between `impeccable-live-start` and `impeccable-live-end` comments. Exit live mode, or delete that block, before you commit. Otherwise it ships to production.
- Run `/impeccable doctor` when Impeccable reports that `PRODUCT.md` or `DESIGN.md` is stale.
- Type `/caveman` in Claude Code, or say "caveman mode" to Codex, for terse replies. `/caveman lite|full|ultra` sets how terse.

## Setup

### Requirements

| Tool | Install | Notes |
|---|---|---|
| Node and git | your OS package manager | Node runs the verify hook on every OS. |
| Claude Code CLI | `claude` on PATH | The verify hook calls it headless. |
| Codex | CLI or app | |
| graphify | `uv tool install graphifyy` (or `pip install graphifyy`) | Gives you the `graphify` command. |
| Impeccable | `npx impeccable install` (see step 3) | After install it runs a self-contained binary, so no Node is needed at runtime. Claude Code can use the Impeccable plugin instead (user level, covers every project). |

Per-OS notes:
- **Windows:** Codex runs `commandWindows` from `hooks.json`. If `graphify` isn't on the PATH Codex sees, use its full path (for example `C:/Users/<you>/.local/bin/graphify.EXE`). Impeccable's launcher is `impeccable.cmd`. If `npm run build` fails under Bash with `0xc0000142`, run it under PowerShell. The verify hook already allows PowerShell for its checks on Windows.
- **macOS and Linux:** Codex runs `command`. Impeccable's launcher is the `impeccable` shell script. File names are case-sensitive on Linux, so use `DESIGN.md` and `PRODUCT.md` exactly.

### Steps for every project

1. **Add the files from [Templates](#templates).** These are the `CLAUDE.md` and `AGENTS.md` sections, `.codex/hooks.json`, `.codex/hooks/claude-verify.js`, and the caveman skill. Put the caveman skill in both of these, so both agents get it:
   - `.claude/skills/caveman/SKILL.md`
   - `.agents/skills/caveman/SKILL.md`

   In an existing project, **merge** these sections into the `CLAUDE.md`, `AGENTS.md` and `.codex/hooks.json` you already have. Don't overwrite them.
2. **Install graphify for both agents** by running these in the project root:
   ```
   graphify claude install   # graphify section in CLAUDE.md + Claude Code PreToolUse hook
   graphify codex install    # graphify section in AGENTS.md
   ```
   `graphify claude install` appends its own graphify section to `CLAUDE.md`. Change its last rule to the once-per-task rule at the end of `templates/AGENTS.codex.md`.
3. **Install Impeccable for both agents.** Run this in the project root:
   ```
   npx impeccable install --project
   ```
   Choose Claude Code and Codex, or pass `--providers=<names>`. If you already use the Impeccable plugin in Claude Code, install only for Codex, so Claude doesn't load the skill twice. The installer adds the skill (Codex reads it from `.agents/skills/`) and merges its hooks into `.codex/hooks.json` next to the ones from step 1. Diff `hooks.json` afterward, and restore the verify and graphify entries if they're missing. Impeccable writes its own local-state ignores to `.git/info/exclude`.
4. **Update `.gitignore`.** Add:
   ```
   .codex/verify/
   graphify-out/
   plans/*
   !plans/_template.md
   ```
   Use `plans/*`, not `plans/`: git can't re-include a file inside an ignored directory.
   Commit `PRODUCT.md`, `DESIGN.md`, `.impeccable/config.json` and `.impeccable/design.json`. Impeccable ignores its own local files (`config.local.json`, `live/…`).
5. **Trust the hooks in Codex.** On the first Codex run in the project, Codex asks you to review and trust `.codex/hooks.json`. You can also approve them with `/hooks`. The trust is stored under `[hooks.state]` in `~/.codex/config.toml`. Any later edit to `hooks.json`, including Impeccable's install, means trusting it again.
6. **Check the detected checks:** run `node .codex/hooks/claude-verify.js --print-checks`. If the list is wrong or empty, add `.codex/verify.json` (see [Checks](#checks)). You never edit the script for this.
7. Keep `.claude/settings.json` free of hooks that block Claude from editing code. Impeccable's Claude hook only reports findings; it doesn't block.
8. **Optional: tune the models.** Step B's model, effort and risk model come from the `alignment` block in `.codex/verify.json` (see [Checks](#checks)). Step A's `--model sonnet --effort low` is in `claude-verify.js`.

### New project

1. Scaffold the app first, so there's a stack for the checks to detect. Then do the steps above.
2. Run `/impeccable init` in Claude Code. It interviews you and writes `PRODUCT.md`.
3. Once there's code, build the first graph with `/graphify .` in Claude Code. After that, `graphify update .` keeps it current; it reads the code only and makes no API calls.
4. `DESIGN.md` comes from Impeccable after the first visual build, or run `/impeccable document` later.

### Existing project

1. Do the steps above, merging into the files that are already there.
2. Build the graph with `/graphify .` in Claude Code.
3. Run `/impeccable init` to write `PRODUCT.md`, then `/impeccable document` to capture the current design system in `DESIGN.md`. If the project already had an older Impeccable setup, run `/impeccable doctor` instead to bring it up to date.
4. If the repo already has UI conventions in another file, merge them into `DESIGN.md`, or point `CLAUDE.md` and `AGENTS.md` at that file.

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

For monorepos, or checks that live in sub-packages, use `verify.json`. Each check is added to Step A's `--allowedTools` as `Bash(<check>:*)`, plus `PowerShell(<check>:*)` on Windows, so the run can't execute anything else.

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

The active plan and phase come from the newest `phase(<slug>): <N>` commit in the range (`plans/<slug>.md`). Without one, the most recently edited plan is used, and Step B infers the phase. `--print-checks` shows the resolved range, plan, phase and model.

## Templates

These files are in `templates/`, next to this `SKILL.md`. Copy them into the target project, or merge them where a file already exists.

| Template | Destination in the project | How |
|---|---|---|
| `CLAUDE.workflow.md` | `CLAUDE.md` | Merge the `## Workflow` section in. |
| `AGENTS.codex.md` | `AGENTS.md` | Merge the `## Codex execution` section in. Make sure graphify's section ends with the once-per-task rule. |
| `codex/hooks.json` | `.codex/hooks.json` | Merge its entries with any that are already there. Impeccable's installer adds its own entries next to them. |
| `codex/hooks/claude-verify.js` | `.codex/hooks/claude-verify.js` | Copy it unchanged. |
| `plans/_template.md` | `plans/_template.md` | Copy it. Every orchestrator plan starts from it. Replace the gate examples with the project's real commands. |
| `skills/caveman/SKILL.md` | `.claude/skills/caveman/SKILL.md` and `.agents/skills/caveman/SKILL.md` | Copy it to both places. |

About the hooks: the Stop hook starts the Claude check. The two PreToolUse hooks run graphify's guard, which steers Codex toward `graphify query`, `path` and `explain` before it falls back to grep or reads raw files. If `graphify` isn't on the PATH Codex sees, replace `graphify` with the full path, for example `C:/Users/<you>/.local/bin/graphify.EXE`.

Also create an empty `docs/tasks/` folder (with a `.gitkeep`) for the task summaries.

`claude-verify.js` prints a JSON object (`{}` or `{ "systemMessage": ... }`) on stdout, which is what Codex hooks expect. It works unchanged in any project. See [Checks](#checks) for how it picks commands.

## Troubleshooting

- **No log appears:** Either the Codex hooks aren't trusted or enabled (see setup step 5), or the working tree had no code changes.
- **The log says `Failed to start claude`:** `claude` isn't on the PATH that Codex sees.
- **The log lists the wrong checks, or none:** Run `node .codex/hooks/claude-verify.js --print-checks` to see what's detected, then add `.codex/verify.json`.
- **A check fails with `0xc0000142` on Windows:** Bash couldn't start a child process. The verify run retries under PowerShell. Run the check yourself in PowerShell to confirm.
- **A check never runs again:** A leftover `.codex/verify/running.lock` blocks new runs for 45 minutes. Delete it. Deleting `.codex/verify/state.json` forces a re-check, starting from the plan's `base` or the last phase commit.
- **A run reviews more than one phase:** The verified commit only advances on PASS, so after NEEDS REWORK the next run covers the old phase too. That's intended. To start fresh, set `verifiedSha` in `state.json` to the commit you trust, or delete the file.
- **`alignment.md` has no VERDICT line:** Step B failed or stopped early. The run counts as NEEDS REWORK. Check the bottom of `alignment.md` for the error.
- **Step B didn't use Opus on a risky change:** Check `--print-checks`. The plan needs `risk: high` in its frontmatter, or a changed file has to match `alignment.riskPaths`.
- **graphify guard errors in Codex:** `graphify` isn't on Codex's PATH. Use its full path in `hooks.json`.
- **The graph is stale or missing:** Run `graphify update .`, or `/graphify .` in Claude Code for a full rebuild.
- **Impeccable's hook never fires in Codex:** Approve the updated `hooks.json` with `/hooks`, then check the project's status with `/impeccable hooks status`.
- **`npx impeccable install` fails with `Could not verify skill bundle: HTTP 404`:** The server couldn't serve the skill bundle, and nothing was installed. Retry later, or follow https://github.com/pbakaus/impeccable/issues/479.
- **Impeccable's launcher fails on Windows:** Call `impeccable.cmd` instead of the `sh` launcher.
- **A `localhost:8400/live.js` script shows up in the app layout:** Live mode left its block behind. Delete everything between `impeccable-live-start` and `impeccable-live-end` before you commit.
