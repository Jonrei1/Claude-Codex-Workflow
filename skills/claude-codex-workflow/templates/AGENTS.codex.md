## Codex execution

Codex executes plans from `.codex/plans/<task>.md`. These plans, the verify reports and this
file are local to this clone (hidden through `.git/info/exclude`); never add them to git or
`.gitignore`. Read the whole plan first and follow its steps, **Covers**, **Done when** and
**Hands off** for each phase. If a step is wrong or impossible, stop and report it; do not
silently diverge from the plan.

After each phase, report the files changed. Never commit: the user commits by hand. Codex
runs the phase's gate. Claude runs the project's full checks, the alignment review and, for UI
phases, a Playwright UI audit afterward, in parallel in the background, so Codex doesn't need
to run those unless the gate names them.

### Full plan execution (when asked "Execute .codex/plans/<task>.md")

This is the default handoff: Claude posts one line into this session, and you run the whole
plan here. `.codex/autopilot.js` does the snapshots, gates, Claude verification and the task
summary; you do the implementation and the fixes.

1. `node .codex/autopilot.js check .codex/plans/<task>.md`. If it isn't runnable, stop and
   report the problems. Then `node .codex/autopilot.js begin .codex/plans/<task>.md`.
2. If `begin` says plan review is on, do the "Plan review" below (append
   `## Codex Findings` only), then run `node .codex/autopilot.js triage .codex/plans/<task>.md`
   and re-read the plan: Claude may have added phases or changed gates.
3. For each phase, in document order (including phases like "Phase 2.5"):
   1. `node .codex/autopilot.js phase .codex/plans/<task>.md <N>`
   2. Implement the phase following "Phase execution" below.
   3. `node .codex/autopilot.js verify .codex/plans/<task>.md <N>`, then act on its exit code:
      - **0 (PASS):** go to the next phase.
      - **2 (gate failed):** fix the failure within the phase, then run verify again.
      - **3 (NEEDS REWORK):** the output includes `.codex/verify/alignment.md`. Fix every
        MISSING and PARTIAL item, every check that still fails and every UI audit FAIL, and
        undo every OUT OF SCOPE change, within the phase. If a finding is about code the
        phase didn't touch, leave it and say so. Then run verify again.
      - **1 or 4 (failed or stuck):** stop and report the reason the command printed.
4. `node .codex/autopilot.js close .codex/plans/<task>.md`. It runs `graphify update .` and has
   Claude write `.codex/tasks/<date>-<task>.md`.
5. End your reply with: `Task <task> done. Claude is reviewing it.`

Rules for this mode:
- Don't stop between phases to ask; keep going until `close`, a failure or a stuck run.
- `verify`, `triage` and `close` start headless Claude runs: they need network access
  and take several minutes. Run them with a long timeout (30 minutes) and request
  permission to run outside the sandbox if the sandbox blocks them.
- Don't write `.codex/verify/phase.json` and don't run `graphify update` yourself; the
  helper does both.
- When asked to "Continue .codex/plans/<task>.md", read `.codex/autopilot/status.json` and
  run the step that stopped again (for example `verify` for the same phase), then carry on.

### Phase execution

- **Never run `git commit`, `git add`, `git stash` or `git push`.** The user commits by
  hand. Leave every change in the working tree, including earlier phases' work and the
  verify run's fixes.
- Do exactly one phase per turn. Stop after it. Do not start the next phase.
- Before editing, read only the files the phase lists. Use graphify for anything else.
- Deliver what the phase's **Hands off** promises; the next phase is written against it.
- Run the phase gate. If it fails, fix it within the phase. If you cannot, stop and say why.
- Do not change files outside the phase scope. If you need to, stop and report it.
- **Single-phase mode** (asked "Execute phase <N> of .codex/plans/<task>.md"): the steps
  below this one apply only here, not in a full plan execution.
- When the phase is done, write `.codex/verify/phase.json` with
  `{ "plan": ".codex/plans/<task>.md", "phase": "<N>" }`, so the verify run knows which
  phase to review.
- Run `graphify update .` once at the end of the phase.
- End your reply with: `Phase <N> done. Gate: <command> -> <pass/fail>.`
- **Full plan execution and autopilot runs** (the prompt says "Autopilot run"): skip
  `phase.json`, `graphify update` and the end line above. `.codex/autopilot.js` runs the
  gate and the verification, and runs graphify at the end.
- Treat accepted Codex Findings as part of the plan. Execute intermediate phases
  (for example "Phase 2.5") in order.

### Plan review (when asked "Review .codex/plans/<task>.md")

- Do not edit or reorder existing phases.
- Do not edit app code.
- Append a section `## Codex Findings` at the end of the plan.
- For each finding: the phase it affects, what is wrong or missing, evidence (file path
  or graphify result), and a proposed fix.
- If a phase needs a prerequisite step, propose an intermediate phase (for example
  "Phase 2.5") inside the findings. Do not renumber existing phases.
- Check specifically: files that do not exist, missed dependents (use `graphify query`),
  missing test gates, unclear acceptance criteria, a **Hands off** the next phase can't rely
  on, risky ordering.
- End with: `PLAN REVIEW: APPROVE | CHANGES NEEDED`.

If the impeccable skill is installed, use it for UI work and follow `PRODUCT.md` and
`DESIGN.md`; run any impeccable command the plan names. If it isn't installed, follow the
project's existing design conventions. Never commit impeccable's live-mode block
(`impeccable-live-start` … `impeccable-live-end`).

Browser checks are Claude's job: the verify step audits UI phases with Playwright, and Claude
does a final UI audit after the run. Run existing Playwright specs only when a gate names them.

Use `graphify query`, `path` and `explain` before reading many raw files.

<!-- After `graphify codex install` appends its graphify section (only with --shared), make sure that section ends with this rule. Use the same rule in the section `graphify claude install` adds to CLAUDE.md. -->

- After all code edits for a task are complete, run `graphify update .` once at the end
  of the coding session. Do not run it between file edits.
