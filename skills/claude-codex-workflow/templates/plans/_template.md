---
task: <slug>
risk: normal            # normal | high (schema, auth, payments, cross-layer contracts)
review: none            # none | codex
ui: no                  # yes | no (yes adds the Playwright UI audit)
---

# <Task title>

## Goal
One or two sentences. What changes for the user.

## Impact (from graphify)
- Expected files: ...
- Dependents to re-test: ...
- Do not touch: ...

## Acceptance
Every item has an id, and every id is covered by at least one phase (`**Covers:**`).
- A1: <observable result, with the test command or endpoint check that proves it>
- A2: <...>

## UI audit
Only when `ui: yes`. Claude audits these with Playwright after each UI phase and once at the end.
- Start: `<app start command, e.g. npm run dev>`
- URL: <http://localhost:3000/page>
- Viewports: 375, 1280
- Checks:
  - <what the user must see or be able to do, per state>

## Phase 1: <title>
**Scope:** <files and interfaces this phase may change>
**Steps:**
1. ...
**Covers:** A1
**Done when:** <what is true when this phase is finished>
**Hands off:** <what phase 2 relies on: files, exports, API shapes, data>
**UI audit:** <only for UI phases: what the browser must show after this phase>
**Gate (must pass):**
- `<runnable command, e.g. npx tsc --noEmit>`
**Suggested commit (optional, for you):** `<type>(<slug>): <summary>`

## Phase 2: <title>
**Scope:** ...
**Steps:**
1. ...
**Covers:** A2
**Done when:** ...
**Gate (must pass):**
- `<command>`
**Suggested commit (optional, for you):** `<type>(<slug>): <summary>`
