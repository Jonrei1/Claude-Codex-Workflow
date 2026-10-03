---
task: <slug>
risk: normal            # normal | high (schema, auth, payments, cross-layer contracts)
review: none            # none | codex
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
- Browser inspection (if requested): <app startup command, URL, viewports, interactions and expected results using Playwright MCP; executable gates still need test commands>

## Phase 1: <title>
**Scope:** files and interfaces
**Steps:**
1. ...
**Gate (must pass):**
- `<runnable command, e.g. npx tsc --noEmit>`
**Suggested commit (optional, for you):** `<type>(<slug>): <summary>`

## Phase 2: <title>
**Scope:** ...
**Steps:**
1. ...
**Gate (must pass):**
- `<command>`
**Suggested commit (optional, for you):** `<type>(<slug>): <summary>`
