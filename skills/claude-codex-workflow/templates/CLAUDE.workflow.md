## Workflow

- **No agent commits:** Claude, Codex, `.codex/autopilot.js` and the headless verify runs
  never run `git commit`, `git add`, `git stash` or `git push`. Every change stays in the
  working tree, and the user reviews and commits it by hand. Progress is tracked with
  snapshots (git tree objects, which aren't commits and aren't on any branch).
- **Ask first:** Before changing any app code for a new task, Claude asks the user
  (with AskUserQuestion) which role to take. It asks no matter how small the change
  looks, and the answer holds for the rest of that task.
  - **Implement directly:** Claude edits the code itself, runs the checks below, and
    fixes failures.
  - **Orchestrator (planner):** Claude doesn't edit app code. It writes a phased plan
    to `plans/<short-task-name>.md` (see **Plans** below). In plan mode, Claude saves
    the approved plan to `plans/`, because the plan-mode file lives outside the repo
    and Codex can't see it. Then it hands off with **one paste** (the default).
  - **One-paste handoff (default):** once the user approves the plan (ExitPlanMode
    approval, or an explicit "go"), Claude saves it to `plans/<slug>.md`, runs
    `node .codex/autopilot.js check plans/<slug>.md`, and fixes the plan until it's
    runnable. Claude **always** ends that reply with the paste line for Codex, alone in
    a code block so it's one click to copy:

    ```
    Execute plans/<slug>.md
    ```

    Claude doesn't start autopilot or Codex itself. Pasted into Codex, that line runs
    the whole task (AGENTS.md "Full plan execution"): the optional plan review, every
    phase (Codex implements, `autopilot.js verify` runs the gate and the Claude
    verification, Codex reworks up to 2 times), and the task summary. Progress is in
    `.codex/autopilot/status.json`. If the user brings back a `stuck` or `failed` run,
    Claude explains the reason, fixes the plan if needed, and ends with the same paste
    line. When it's done, the user reviews and commits the changes.
  - **Manual handoff:** if the user says "manual", Claude ends its reply with
    `Execute phase 1 of plans/<slug>.md` instead, and the user hands it off one phase at
    a time.

  Claude doesn't ask when the task only reads code, answers questions, or edits docs
  and config (`*.md`, `plans/`, `.claude/`, `.codex/`), or in the headless verify run
  below, which can't ask.
- **Plans:** Orchestrator plans follow `plans/_template.md`.
  - Phases are small enough to review as one diff. Prefer 3 to 6 phases.
  - Every phase has a gate: a runnable command, not a description.
  - A phase may suggest a commit message for the user (`**Suggested commit:**`).
  - Backend phases list expected files and dependents from `graphify query`.
  - UI phases name the Impeccable command to run (only if Impeccable is installed), and
    the Playwright spec if the project has one.
  - Requested browser acceptance steps name the app startup command, URL, interactions,
    viewport sizes and expected results. Playwright MCP is available after machine
    setup; it does not create project test specs. Use executable tests for phase gates.
  - Set `risk: high` in the frontmatter for schema, auth, payments, or cross-layer
    contract changes. It switches the alignment review to Opus.
  - Phases apply to orchestrator plans only. Implement-directly tasks don't use them.
  - **Optional Codex review:** set `review: codex` for a second opinion before any code
    is written. It's on by default for `risk: high`, and skipped for small, low-risk
    tasks. The one-paste run does it first and has Claude triage the findings. In a manual handoff,
    Claude saves a copy as `plans/.<slug>.orig.md`, then ends its reply with
    `Review plans/<slug>.md` (to paste into a fresh Codex session) instead of the
    execute line. Codex appends `## Codex Findings`, and the user accepts or rejects them.
- **Verify:** Runs automatically. When the working tree changed since the last verified
  snapshot, Codex's Stop hook (`.codex/hooks/claude-verify.js`) starts two headless
  Claude runs in the background. In a one-paste run, `autopilot.js verify` calls the same
  script after each phase instead, and the Stop hook stays quiet. The
  change under review is written to `.codex/verify/phase.diff`.
  - **Step A, checks:** the script runs the project's checks (auto-detected, or `checks`
    in `.codex/verify.json`) itself. Only if one fails, Claude (Sonnet, low effort) fixes
    lint, formatting and type errors and reports other failures, then the checks re-run.
    Report: `.codex/verify/last.log`.
  - **Step B, alignment** (Sonnet, medium effort, or Opus when the plan has `risk: high`
    or the diff touches `alignment.riskPaths` in `.codex/verify.json`): report-only, with no
    write tools. It lists DONE / PARTIAL / MISSING / OUT OF SCOPE / GATE / RISKS for
    the phase and ends with `VERDICT: PASS | NEEDS REWORK`. Report:
    `.codex/verify/alignment.md`.
  - The verified snapshot only advances on PASS. When the user commits, HEAD becomes
    the new starting point.
- **Fix:** In an interactive session, Claude fixes type, lint and build failures
  directly instead of sending them back to Codex, and re-runs the checks until they
  pass. Behavior failures and NEEDS REWORK findings go back into the plan as rework
  for Codex.
- **Design:** Impeccable is optional. It is installed when `/impeccable` is available or
  the project has `.impeccable/`. If it is installed, Claude uses it for UI work
  (`/impeccable <command>`); `PRODUCT.md` and `DESIGN.md` are the design context, and as
  orchestrator Claude's UI plans name the impeccable command Codex should run and the
  DESIGN.md sections to follow. If it isn't installed, follow the project's existing
  design conventions and don't mention impeccable commands in plans. Either way, never
  commit impeccable's live-mode block (`impeccable-live-start` …
  `impeccable-live-end` in the root layout).

Use Playwright MCP for browser acceptance checks requested by the user or approved
plan. Start the app first and record the results. Headless verification does not use
MCP browser tools; Step A can run configured browser test commands. Manual testing
and providing any authenticated browser state stay with the user.

### Closing a task

A one-paste run closes the task itself (`autopilot.js close`). In a manual handoff, when the user says "close <task>":
1. Read `plans/<task>.md`, `.codex/verify/alignment.md`, and the task's changes
   (`git status` and `git diff`).
2. Write `docs/tasks/<YYYY-MM-DD>-<task>.md` from the template below. 25 lines max.
3. Fill "Deviations from the plan" by comparing the plan with the actual diff, not
   from memory.
4. Don't edit app code, and don't commit. The user commits the summary with the work.

```md
# <Task title>

- Date: <YYYY-MM-DD>
- Risk: normal | high
- Plan reviewed by Codex: yes | no
- Final verdict: PASS | PASS WITH NOTES

## What shipped
- Phase 1: <title> (<main files changed>)

## Deviations from the plan
- <what changed and why, or "none">

## Review findings that mattered
- <Codex plan findings or alignment issues that changed the work, or "none">

## Follow-ups
- <deferred work, known gaps, or "none">
```
