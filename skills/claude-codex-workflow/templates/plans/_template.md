---
task: <slug>
risk: normal            # normal | high (schema, auth, payments, cross-layer contracts)
review: none            # none | codex
base: <commit sha or branch the work starts from>
---

# <Task title>

## Goal
One or two sentences. What changes for the user.

## Impact (from graphify)
- Expected files: ...
- Dependents to re-test: ...
- Do not touch: ...

## Acceptance
- Backend: <test command or endpoint check>
- Frontend: <Playwright spec path, tagged @smoke if fast, if the project has Playwright>

## Phase 1: <title>
**Scope:** files and interfaces
**Steps:**
1. ...
**Gate (must pass before commit):**
- `<runnable command, e.g. npx tsc --noEmit>`
**Commit:** `phase(<slug>): 1 <title>`

## Phase 2: <title>
**Scope:** ...
**Steps:**
1. ...
**Gate (must pass before commit):**
- `<command>`
**Commit:** `phase(<slug>): 2 <title>`
