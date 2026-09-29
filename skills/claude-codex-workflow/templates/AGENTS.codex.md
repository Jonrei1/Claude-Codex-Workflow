## Codex execution

Codex executes plans from `plans/<task>.md`. Read the whole plan first and follow
its steps and acceptance criteria. If a step is wrong or impossible, stop and
report it; do not silently diverge from the plan.

After executing a plan, report the files changed. Claude runs the project's checks
(typecheck, lint, build) afterward and fixes any failures directly. Codex doesn't need to run them unless asked.

For UI work, use the impeccable skill and follow `PRODUCT.md` and `DESIGN.md`. Run any
impeccable command the plan names. Never commit impeccable's live-mode block
(`impeccable-live-start` … `impeccable-live-end`).

<!-- After `graphify codex install` appends its graphify section, make sure that section ends with this rule. Use the same rule in the section `graphify claude install` adds to CLAUDE.md. -->

- After all code edits for a task are complete, run `graphify update .` once at the end
  of the coding session. Do not run it between file edits.
