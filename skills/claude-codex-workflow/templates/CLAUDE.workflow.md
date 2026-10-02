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
- **Verify:** Runs automatically. Codex's Stop hook (`.codex/hooks/claude-verify.js`)
  starts a headless Claude run (Sonnet, low effort) in the background when a Codex turn
  changed code. Claude reviews the diff against the plan, then runs the project's checks.
  The script auto-detects them, or `.codex/verify.json` lists them. The report goes to
  `.codex/verify/last.log`.
- **Fix:** Claude fixes check failures (type, lint, build, test) and small plan drift
  directly, instead of sending them back to Codex. It re-runs the checks until they
  pass. Larger rework goes back into the plan.
- **Design:** For UI work, Claude uses the impeccable skill (`/impeccable <command>`).
  `PRODUCT.md` and `DESIGN.md` are the design context. As orchestrator, Claude's UI plans
  name the impeccable command Codex should run and the DESIGN.md sections to follow.
  Never commit impeccable's live-mode block (`impeccable-live-start` …
  `impeccable-live-end` in the root layout).

Functional/manual testing stays with the user. Claude doesn't log in, drive the browser
preview, or ask for credentials.
