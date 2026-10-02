## Workflow

- **Ask first:** Before changing any app code for a new task, Claude asks the user
  (with AskUserQuestion) which role to take. It asks no matter how small the change
  looks, and the answer holds for the rest of that task.
  - **Implement directly:** Claude edits the code itself, runs the checks below, and
    fixes failures.
  - **Orchestrator (planner):** Claude doesn't edit app code. It writes a phased plan
    to `plans/<short-task-name>.md` (see **Plans** below) and ends its reply with a
    ready-to-paste line for Codex, e.g. `Execute phase 1 of plans/<short-task-name>.md`.
    The user reviews the plan and hands it off one phase at a time. In plan mode,
    Claude also saves the approved plan to `plans/`, because the plan-mode file lives
    outside the repo and Codex can't see it.

  Claude doesn't ask when the task only reads code, answers questions, or edits docs
  and config (`*.md`, `plans/`, `.claude/`, `.codex/`), or in the headless verify run
  below, which can't ask.
- **Plans:** Orchestrator plans follow `plans/_template.md`.
  - Phases are small enough to review as one diff. Prefer 3 to 6 phases.
  - Every phase has a gate: a runnable command, not a description.
  - Every phase has a commit message: `phase(<slug>): <N> <title>`.
  - Backend phases list expected files and dependents from `graphify query`.
  - UI phases name the Impeccable command to run, and the Playwright spec if the
    project has one.
  - Set `risk: high` in the frontmatter for schema, auth, payments, or cross-layer
    contract changes. It switches the alignment review to Opus.
  - Phases apply to orchestrator plans only. Implement-directly tasks don't use them.
  - **Optional Codex review:** set `review: codex` for a second opinion before any code
    is written. It's on by default for `risk: high`, and skipped for small, low-risk
    tasks. Claude saves a copy as `plans/.<slug>.orig.md`, then ends its reply with
    `Review plans/<slug>.md` (to paste into a fresh Codex session) instead of the
    execute line. Codex appends `## Codex Findings`. The user accepts or rejects them,
    then starts with `Execute phase 1 of plans/<slug>.md`. Diffing against the `.orig`
    copy shows that the original phases weren't changed.
- **Verify:** Runs automatically. When a Codex turn changed code since the last
  verified commit (committed phases plus the working tree), Codex's Stop hook
  (`.codex/hooks/claude-verify.js`) starts two headless Claude runs in the background:
  - **Step A, checks** (Sonnet, low effort): runs the project's checks (auto-detected,
    or `checks` in `.codex/verify.json`). It fixes only lint, formatting and type
    errors, and reports other failures. Report: `.codex/verify/last.log`.
  - **Step B, alignment** (Sonnet, medium effort, or Opus when the plan has `risk: high`
    or the diff touches `alignment.riskPaths` in `.codex/verify.json`): report-only, with no
    write tools. It lists DONE / PARTIAL / MISSING / OUT OF SCOPE / GATE / RISKS for
    the phase and ends with `VERDICT: PASS | NEEDS REWORK`. Report:
    `.codex/verify/alignment.md`. The verified commit only advances on PASS.
- **Fix:** In an interactive session, Claude fixes type, lint and build failures
  directly instead of sending them back to Codex, and re-runs the checks until they
  pass. Behavior failures and NEEDS REWORK findings go back into the plan as rework
  for Codex.
- **Design:** For UI work, Claude uses the impeccable skill (`/impeccable <command>`).
  `PRODUCT.md` and `DESIGN.md` are the design context. As orchestrator, Claude's UI plans
  name the impeccable command Codex should run and the DESIGN.md sections to follow.
  Never commit impeccable's live-mode block (`impeccable-live-start` …
  `impeccable-live-end` in the root layout).

Functional/manual testing stays with the user. Claude doesn't log in, drive the browser
preview, or ask for credentials.

### Closing a task

When the user says "close <task>":
1. Read `plans/<task>.md`, `.codex/verify/alignment.md`, and the phase commits
   (`git log --oneline --grep "phase(<task>)"`).
2. Write `docs/tasks/<YYYY-MM-DD>-<task>.md` from the template below. 25 lines max,
   with real short SHAs.
3. Fill "Deviations from the plan" by comparing the plan with the actual diff, not
   from memory.
4. Don't edit app code. Commit only the summary: `docs(tasks): <task>`.

```md
# <Task title>

- Date: <YYYY-MM-DD>
- Risk: normal | high
- Plan reviewed by Codex: yes | no
- Final verdict: PASS | PASS WITH NOTES

## What shipped
- Phase 1: <title> (<short sha>)

## Deviations from the plan
- <what changed and why, or "none">

## Review findings that mattered
- <Codex plan findings or alignment issues that changed the work, or "none">

## Follow-ups
- <deferred work, known gaps, or "none">
```

