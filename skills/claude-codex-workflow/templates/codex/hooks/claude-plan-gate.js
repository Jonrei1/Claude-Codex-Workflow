/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Claude Code PostToolUse hook for ExitPlanMode, installed in .claude/settings.local.json.
// When the user approves a plan, it reminds Claude of the workflow's next steps: confirm the
// role for this plan, and as orchestrator save the plan locally, check it, hand it to Codex
// and watch the run in the background. It only adds context; it never blocks.

const fs = require("node:fs");

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch {
  // no stdin
}
let event = {};
try {
  event = JSON.parse(input || "{}");
} catch {
  event = {};
}

const approved = !event.tool_response || !/reject|denied|not approved/i.test(JSON.stringify(event.tool_response).slice(0, 2000));
if (!approved) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const context = `Claude + Codex workflow, plan approved. Before any app code changes:
1. If you haven't asked for THIS plan, ask now with AskUserQuestion who implements it: "Codex implements (Claude orchestrates)", "Claude implements", or "Codex, manual phases". Never reuse an earlier plan's answer.
2. Claude implements: edit the code yourself and run the project's checks.
3. Codex (either option): save the plan as .codex/plans/<slug>.md in the template's format (frontmatter task/risk/review/ui, Acceptance ids, per phase Scope/Steps/Covers/Done when/Hands off/Gate, UI audit when ui: yes). Run \`node .codex/autopilot.js check .codex/plans/<slug>.md\` and fix the plan until every item passes.
4. Then run \`node .codex/autopilot.js handoff .codex/plans/<slug>.md\` (add \`--phase 1\` for manual phases). Exit 5 means show the user the printed paste line.
5. Then start \`node .codex/autopilot.js wait .codex/plans/<slug>.md\` with run_in_background, tell the user you're watching, and review the result automatically when it finishes (see CLAUDE.local.md "Review when Codex finishes").`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
