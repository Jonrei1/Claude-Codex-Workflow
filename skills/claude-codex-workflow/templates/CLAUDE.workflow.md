## Workflow

Claude + Codex workflow. Everything it writes is local to this clone and hidden through
`.git/info/exclude`: plans in `.codex/plans/`, verify logs in `.codex/verify/<task>/`, task
summaries in `.codex/tasks/`, and these rules in `CLAUDE.local.md`. Never move them into tracked
files and never add them to `.gitignore`: teammates must not see workflow changes.

- **No agent commits:** Claude, Codex, `.codex/autopilot.js` and the headless verify runs
  never run `git commit`, `git add`, `git stash` or `git push`. Every change stays in the
  working tree, and the user reviews and commits it by hand. Progress is tracked with
  snapshots (git tree objects, which aren't commits and aren't on any branch).
- **Ask on every plan:** at the start of every new plan or task that changes app code, Claude
  asks the user (with AskUserQuestion) who implements it, even when the change looks small:
  **Codex implements (Claude orchestrates)** (recommended for multi-file work),
  **Claude implements**, or **Codex, manual phases**. The answer holds for that plan only;
  ask again for the next one. Don't ask for read-only questions or for edits to docs and
  config only (`*.md`, `.codex/`, `.claude/`).
  - **Claude implements:** Claude edits the code itself, runs the project's checks, and fixes
    failures. For UI changes it also runs the UI audit below itself.
  - **Codex implements:** Claude doesn't edit app code. It writes a phased plan (see
    **Plans**), and once the user approves it (ExitPlanMode approval or an explicit "go"):
    1. Save it to `.codex/plans/<slug>.md`. The plan-mode file lives outside the repo, and
       Codex can't see it.
    2. Run `node .codex/autopilot.js check .codex/plans/<slug>.md` and fix the plan until
       every checklist item passes.
    3. Run `node .codex/autopilot.js handoff .codex/plans/<slug>.md`. It posts the plan into
       the open Codex session for this repo (`codex queue`), or opens a new terminal running
       Codex. Exit 5 means it couldn't reach Codex: show the printed line in its own code
       block for the user to paste.
    4. Start `node .codex/autopilot.js wait .codex/plans/<slug>.md` with Bash
       `run_in_background: true`, tell the user Codex is running and you're watching, and
       stop. Don't start Codex or `autopilot.js run` yourself.
  - **Codex, manual phases:** the same, but hand off with `--phase 1` and the user drives
    later phases (`handoff ... --phase <N>`). The Codex Stop hook verifies each phase.
- **Review when Codex finishes:** when `wait` exits, Claude reviews without being asked.
  - **done (exit 0):** read the summary it printed, `.codex/verify/<slug>/` (per-phase
    `*.alignment.md`, `*.checks.log`, `*.ui-audit.md`), and spot-check the diff
    (`git diff`, `git status`). If the plan has `ui: yes`, run the **final UI audit** below.
    Then report: what shipped, per-phase verdicts, UI audit result, anything to look at
    before committing. If there are real problems, propose a rework plan and ask before
    handing it off.
  - **stuck (4) or failed (1):** explain the reason from the summary and the reports. Fix the
    plan if that's the cause, then ask the user before sending
    `node .codex/autopilot.js handoff .codex/plans/<slug>.md --continue` and waiting again.
  - **timed out (6):** say Codex never started or is still running; offer to wait again.
- **Plans:** Orchestrator plans follow `.codex/plans/_template.md`. `check` enforces:
  - frontmatter `task` (the file name), `risk`, `review`, `ui: yes|no`;
  - `## Acceptance` items with ids (`- A1: ...`), each covered by some phase's `**Covers:**`;
  - every phase has **Scope**, **Steps**, **Covers**, **Done when**, a **Gate** with runnable
    commands (npm scripts must exist, programs must be on PATH), and every phase except the
    last has **Hands off**: what the next phase relies on (files, exports, API shapes, data).
    Write Hands off so the next phase can start without guessing;
  - with `ui: yes`: a `## UI audit` section (start command, URL, viewports, checks), and a
    `**UI audit:**` block on each phase that changes what the user sees.
  - Prefer 3 to 6 phases, each small enough to review as one diff. A phase may suggest a
    commit message for the user (`**Suggested commit:**`).
  - Backend phases list expected files and dependents from `graphify query`.
  - Set `risk: high` for schema, auth, payments, or cross-layer contract changes. It switches
    the alignment review to Opus and turns on the Codex plan review.
  - **Optional Codex review:** `review: codex` has Codex review the plan before any code is
    written; Claude triages the findings in the same run.
- **Verify (automatic):** after each phase, `autopilot.js verify` (or, in manual phases, the
  Codex Stop hook) runs three steps in parallel in the background:
  - **Step A, checks:** the project's checks (auto-detected, or `checks` in
    `.codex/verify.json`), concurrently. Only if one fails, Claude (Sonnet, low effort) fixes
    lint, formatting and type errors, then the checks re-run.
  - **Step B, alignment** (Sonnet, medium; Opus for `risk: high` or `alignment.riskPaths`):
    report-only review of the phase against Done when, Covers and Hands off.
  - **Step C, UI audit** (only for phases with a **UI audit** block, or `ui: yes` changes to
    `ui.paths`): a headless Claude run with Playwright opens the app at each viewport,
    report-only. It starts the app with the plan's start command if it isn't running.
  - PASS needs alignment PASS, passing checks, and a UI audit that isn't NEEDS REWORK
    (BLOCKED, for example the app didn't start, is reported but doesn't fail the phase).
    Reports: `.codex/verify/<slug>/phase-<N>.*`; the latest are also in
    `.codex/verify/alignment.md` and `last.log`.
- **Final UI audit (Claude, Playwright MCP):** for `ui: yes` plans, after Codex is done.
  Start the app with the plan's `- Start:` command if nothing answers at the URL (in the
  background), then for each viewport: resize, navigate, snapshot, do the interactions, and
  screenshot each state. Check every `## UI audit` item, plus layout breaks, overflow,
  console errors, failed requests and unlabeled controls. Write
  `.codex/verify/<slug>/final-ui-audit.md` (PASS/FAIL per item, screenshots, then
  `UI AUDIT: PASS | NEEDS REWORK`), and stop the app if you started it. Manual testing and
  any login state the app needs stay with the user.
- **Fix:** in an interactive session, Claude fixes type, lint and build failures directly
  instead of sending them back to Codex. Behavior failures and NEEDS REWORK findings go into
  a rework plan for Codex.
- **graphify:** use `graphify query`, `path` and `explain` before reading many raw files.
  After all code edits for a task are complete, run `graphify update .` once at the end of
  the coding session. Do not run it between file edits.
- **Design:** Impeccable is optional. If `/impeccable` is available or the project has
  `.impeccable/`, use it for UI work; `PRODUCT.md` and `DESIGN.md` are the design context, and
  UI plans name the impeccable command Codex should run and the DESIGN.md sections to follow.
  Otherwise follow the project's existing design conventions and don't mention impeccable
  commands in plans. Never commit impeccable's live-mode block (`impeccable-live-start` …
  `impeccable-live-end` in the root layout).

### Closing a task

An automatic run closes the task itself (`autopilot.js close`). In manual phases, when the
user says "close <task>":
1. Read `.codex/plans/<task>.md`, the reports in `.codex/verify/<task>/`, and the task's
   changes (`git status` and `git diff`).
2. Write `.codex/tasks/<YYYY-MM-DD>-<task>.md` from the template below. 25 lines max.
3. Fill "Deviations from the plan" by comparing the plan with the actual diff, not from
   memory.
4. Don't edit app code, and don't commit.

```md
# <Task title>

- Date: <YYYY-MM-DD>
- Risk: normal | high
- Plan reviewed by Codex: yes | no
- Final verdict: PASS | PASS WITH NOTES
- UI audit: PASS | NEEDS REWORK | not run

## What shipped
- Phase 1: <title> (<main files changed>)

## Deviations from the plan
- <what changed and why, or "none">

## Review findings that mattered
- <Codex plan findings, alignment or UI audit issues that changed the work, or "none">

## Follow-ups
- <deferred work, known gaps, or "none">
```
