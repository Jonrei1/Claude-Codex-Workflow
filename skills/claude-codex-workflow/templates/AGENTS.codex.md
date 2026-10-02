## Codex execution

Codex executes plans from `plans/<task>.md`. Read the whole plan first and follow
its steps and acceptance criteria. If a step is wrong or impossible, stop and
report it; do not silently diverge from the plan.

After each phase, report the files changed. Never commit: the user commits by hand. Codex runs the phase's gate. Claude
runs the project's full checks (typecheck, lint, build) afterward in the background,
so Codex doesn't need to run those unless the gate names them.

### Phase execution

- **Never run `git commit`, `git add`, `git stash` or `git push`.** The user commits by
  hand. Leave every change in the working tree, including earlier phases' work and the
  verify run's fixes.
- Do exactly one phase per turn. Stop after it. Do not start the next phase.
- Before editing, read only the files the phase lists. Use graphify for anything else.
- Run the phase gate. If it fails, fix it within the phase. If you cannot, stop and say why.
- Do not change files outside the phase scope. If you need to, stop and report it.
- When the phase is done, write `.codex/verify/phase.json` with
  `{ "plan": "plans/<task>.md", "phase": "<N>" }`, so the verify run knows which phase
  to review.
- Run `graphify update .` once at the end of the phase.
- End your reply with: `Phase <N> done. Gate: <command> -> <pass/fail>.`
- **Autopilot runs** (the prompt says "Autopilot run"): skip `phase.json` and
  `graphify update`. `.codex/autopilot.js` runs the gate and the verification, and
  runs graphify at the end. Everything else above still applies.
- Treat accepted Codex Findings as part of the plan. Execute intermediate phases
  (for example "Phase 2.5") in order.

### Plan review (when asked "Review plans/<task>.md")

- Do not edit or reorder existing phases.
- Do not edit app code.
- Append a section `## Codex Findings` at the end of the plan.
- For each finding: the phase it affects, what is wrong or missing, evidence (file path
  or graphify result), and a proposed fix.
- If a phase needs a prerequisite step, propose an intermediate phase (for example
  "Phase 2.5") inside the findings. Do not renumber existing phases.
- Check specifically: files that do not exist, missed dependents (use `graphify query`),
  missing test gates, unclear acceptance criteria, risky ordering.
- End with: `PLAN REVIEW: APPROVE | CHANGES NEEDED`.

For UI work, use the impeccable skill and follow `PRODUCT.md` and `DESIGN.md`. Run any
impeccable command the plan names. Never commit impeccable's live-mode block
(`impeccable-live-start` … `impeccable-live-end`).

<!-- After `graphify codex install` appends its graphify section, make sure that section ends with this rule. Use the same rule in the section `graphify claude install` adds to CLAUDE.md. -->

- After all code edits for a task are complete, run `graphify update .` once at the end
  of the coding session. Do not run it between file edits.
