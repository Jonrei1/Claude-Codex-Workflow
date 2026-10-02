## Codex execution

Codex executes plans from `plans/<task>.md`. Read the whole plan first and follow
its steps and acceptance criteria. If a step is wrong or impossible, stop and
report it; do not silently diverge from the plan.

After each phase, report the files changed. Codex runs the phase's gate. Claude
runs the project's full checks (typecheck, lint, build) afterward in the background,
so Codex doesn't need to run those unless the gate names them.

### Phase execution

- Do exactly one phase per turn. Stop after it. Do not start the next phase.
- Before editing, read only the files the phase lists. Use graphify for anything else.
- If the working tree has uncommitted changes when you start, check
  `.codex/verify/last.log`. If they are the verify run's fixes, commit them first as
  `fix(<slug>): verify fixes after phase <N-1>`. If they aren't, stop and ask.
- Run the phase gate. If it fails, fix it within the phase. If you cannot, stop and say why.
- On a passing gate, commit with the phase's commit message. Do not amend earlier commits.
- Do not change files outside the phase scope. If you need to, stop and report it.
- Run `graphify update .` once at the end of the phase.
- End your reply with: `Phase <N> done. Gate: <command> -> <pass/fail>.`

For UI work, use the impeccable skill and follow `PRODUCT.md` and `DESIGN.md`. Run any
impeccable command the plan names. Never commit impeccable's live-mode block
(`impeccable-live-start` … `impeccable-live-end`).

<!-- After `graphify codex install` appends its graphify section, make sure that section ends with this rule. Use the same rule in the section `graphify claude install` adds to CLAUDE.md. -->

- After all code edits for a task are complete, run `graphify update .` once at the end
  of the coding session. Do not run it between file edits.
