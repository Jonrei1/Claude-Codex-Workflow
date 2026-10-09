/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Codex Stop hook: when the working tree changed since the last verified snapshot, hand
// verification to Claude Code in the background. Three steps run side by side, so a
// phase's verification takes as long as the slowest step, not their sum:
//
//   Step A  checks + mechanical fixes. This script runs the project's checks itself
//           (concurrently; build checks run last, on their own); when all pass, no model is
//           called. When one fails, Claude (Sonnet, low effort) gets the failing output and
//           fixes only lint, formatting and type errors, then the checks run again.
//   Step B  alignment review, report-only (Sonnet, medium effort; Opus for risky work).
//           Judges the change against its plan phase. It has no write tools.
//   Step C  UI audit, report-only, only for UI phases: a headless Claude run with the
//           Playwright MCP server opens the app and checks the phase's **UI audit** items
//           at each viewport. It starts the app when it isn't already running (after Step A's
//           checks, so a build and a dev server don't fight over the same output).
//
// The verdict is PASS only when Step B says PASS, the checks pass after Step A, and the UI
// audit isn't NEEDS REWORK. Reports are kept per task in .codex/verify/<task>/
// (phase-<N>.checks.log, phase-<N>.alignment.md, phase-<N>.ui-audit.md, phase-<N>.ui/ for
// screenshots); .codex/verify/last.log and alignment.md are copies of the latest run.
//
// Nobody but the user commits, so progress is tracked with snapshots (see workflow-lib.js).
// The change under review is the diff from the last verified snapshot to the current
// working tree, written to .codex/verify/phase.diff. The verified snapshot only moves
// forward on PASS, so a phase that needs rework is reviewed again next time. When the user
// commits, HEAD becomes the new starting point.
//
// The plan and phase come from .codex/verify/phase.json ({ "plan": ".codex/plans/x.md",
// "phase": "2" }, written by Codex after a phase), else the newest plan in .codex/plans/.
//
// Checks come from .codex/verify.json ({ "checks": ["..."] }) when it exists, otherwise
// they are detected from the repo root (Node, Rust, Go, Python). The same file's optional
// "alignment" block sets the Step B model, effort, riskModel and riskPaths, "ui" sets the
// UI audit, and "parallelChecks": false runs the checks one at a time.
// `node .codex/hooks/claude-verify.js --print-checks [--root <dir>]` prints the resolved
// setup without starting a run. `--run [--base <tree>] [--plan <path>] [--phase <id>]
// [--gate <note>]` verifies synchronously; .codex/autopilot.js uses it after each phase.
// Under autopilot (CODEX_AUTOPILOT=1, or .codex/autopilot/status.json says "running")
// the Stop hook itself does nothing.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const lib = require("./workflow-lib");

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

const repoRoot = flagValue("--root") ? path.resolve(flagValue("--root")) : path.resolve(__dirname, "..", "..");
const stateDir = path.join(repoRoot, ".codex", "verify");
const lockPath = path.join(stateDir, "running.lock");
const statePath = path.join(stateDir, "state.json");
const logPath = path.join(stateDir, "last.log");
const alignmentPath = path.join(stateDir, "alignment.md");
const diffPath = path.join(stateDir, "phase.diff");
const diffRel = ".codex/verify/phase.diff";
const plansDir = path.join(repoRoot, ".codex", "plans");
const isWindows = process.platform === "win32";
const lockTimeoutMs = 45 * 60 * 1000;
const checkTimeoutMs = 15 * 60 * 1000;
const uiAuditTimeoutMs = 20 * 60 * 1000;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const alignmentDefaults = { model: "sonnet", effort: "medium", riskModel: "opus", riskPaths: [] };

function emitHookResult(systemMessage) {
  const payload = systemMessage ? { systemMessage } : {};
  fs.writeSync(1, JSON.stringify(payload) + "\n");
}

function exists(name) {
  return fs.existsSync(path.join(repoRoot, name));
}

function readText(name) {
  try {
    return fs.readFileSync(path.join(repoRoot, name), "utf8");
  } catch {
    return "";
  }
}

function readJson(name) {
  try {
    return JSON.parse(readText(name));
  } catch {
    return null;
  }
}

function detectChecks() {
  return lib.detectChecks(repoRoot);
}

function alignmentConfig() {
  const override = readJson(path.join(".codex", "verify.json"));
  const config = { ...alignmentDefaults, ...((override && override.alignment) || {}) };
  config.riskPaths = Array.isArray(config.riskPaths) ? config.riskPaths : [];
  return config;
}

// Minimal glob support for riskPaths and ui.paths: `**` (any depth), `*` and `?` (within a segment).
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readState() {
  try {
    return JSON.parse(readFile(statePath)) || {};
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

// An unfinished autopilot run verifies each phase itself. A Codex-driven run
// (`Execute .codex/plans/<task>.md`) that stopped as stuck or failed is resumed by rerunning
// its step, so it stays quiet too.
function autopilotActive() {
  try {
    const status = JSON.parse(readFile(path.join(repoRoot, ".codex", "autopilot", "status.json")));
    const states = status.driver === "codex" ? ["running", "stuck", "failed"] : ["running"];
    return states.includes(status.state) && Date.now() - Date.parse(status.updated) < 6 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function newestPlan() {
  try {
    return fs
      .readdirSync(plansDir)
      .filter((file) => file.endsWith(".md") && !file.startsWith("_") && !file.startsWith("."))
      .map((file) => ({ file, mtime: fs.statSync(path.join(plansDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.file;
  } catch {
    return undefined;
  }
}

function planInfo(rel, phase) {
  const text = readText(rel);
  return { rel, phase: phase || "infer", text, meta: lib.frontmatter(text) };
}

// The plan and phase under review: explicit flags, then Codex's phase marker, then the
// most recently edited plan with the phase inferred.
function activePlan() {
  if (flagValue("--plan")) return planInfo(flagValue("--plan"), flagValue("--phase"));
  const marker = readJson(path.join(".codex", "verify", "phase.json"));
  if (marker && typeof marker.plan === "string" && exists(marker.plan)) return planInfo(marker.plan, String(marker.phase || ""));
  const file = newestPlan();
  return file ? planInfo(`${lib.plansRel}/${file}`, "") : null;
}

// Where the change under review starts: --base, else the last verified snapshot while
// HEAD hasn't moved since, else HEAD's tree (a user commit accepts what it contains).
function resolveBase(state, head) {
  const override = flagValue("--base");
  if (override && lib.treeExists(repoRoot, override)) return { tree: override, from: "autopilot phase start" };
  if (state.verifiedTree && state.verifiedHead === head && lib.treeExists(repoRoot, state.verifiedTree)) {
    return { tree: state.verifiedTree, from: "last verified snapshot" };
  }
  return { tree: lib.headTree(repoRoot) || emptyTree, from: head ? "HEAD" : "empty repo" };
}

function context() {
  const head = lib.gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const state = readState();
  const base = resolveBase(state, head);
  const current = lib.snapshot(repoRoot);
  const files = lib.changedFiles(repoRoot, base.tree, current);
  const plan = activePlan();
  const config = alignmentConfig();
  let risk = "";
  if (plan && plan.meta.risk === "high") {
    risk = `${plan.rel} has risk: high`;
  } else {
    const patterns = config.riskPaths.map((glob) => ({ glob, re: globToRegExp(glob) }));
    for (const file of files) {
      const hit = patterns.find(({ re }) => re.test(file));
      if (hit) {
        risk = `${file} matches risk path ${hit.glob}`;
        break;
      }
    }
  }
  return { head, state, base, current, files, hash: `${base.tree}:${current}`, plan, config, risk, ui: uiNeeded(plan, files) };
}

// Step C runs when the phase has a **UI audit:** block, or the plan has `ui: yes` and the
// change touches one of verify.json's ui.paths.
function uiNeeded(plan, files) {
  if (!plan || !plan.text) return null;
  const ui = lib.uiSettings(repoRoot, plan.text);
  const phase = lib.parsePhases(plan.text).find((candidate) => candidate.id === plan.phase);
  const items = phase && phase.uiAudit && !lib.isPlaceholder(phase.uiAudit) ? phase.uiAudit : "";
  const patterns = ui.paths.map(globToRegExp);
  const touches = plan.meta.ui === "yes" && files.some((file) => patterns.some((re) => re.test(file)));
  if (!items && !touches) return null;
  return { ...ui, items, reason: items ? `phase ${phase.id} has a UI audit block` : "the change touches ui.paths" };
}

function writeDiff(base, current) {
  fs.writeFileSync(diffPath, lib.diffText(repoRoot, base, current) || "(no changes outside workflow paths)\n");
}

const diffNote = `The change is in ${diffRel}: a diff from the last verified snapshot to the current working tree, new files included and workflow paths (.codex/, .claude/, .impeccable/, graphify-out/, CLAUDE.local.md) left out. Read all of it. Nothing is committed during the workflow, so don't look for commits.`;

function planLabel(ctx) {
  return ctx.plan ? `${ctx.plan.rel} (phase ${ctx.plan.phase})` : "(none)";
}

// Step A runs the checks itself, in Node, and only calls Claude when one fails: a passing
// run costs no model tokens. Claude then gets just the failing commands and their output.
// During an autopilot run, a check whose failures were all there before the task started
// (the run's baseline) counts as passing and isn't sent to Claude.
function fixPrompt(failures) {
  const failed = failures
    .map((f) => {
      const fresh = f.newLines && f.newLines.length ? `New since the task started (fix these):\n${f.newLines.slice(0, 80).join("\n")}\n\nFull output:\n` : "";
      return `### \`${f.cmd}\` (${f.status})\n${fresh}${f.tail || "(no output)"}`;
    })
    .join("\n\n");
  const baselineNote = failures.some((f) => f.newLines && f.newLines.length)
    ? "\n   Errors not listed under \"New since the task started\" were already in the repo before the task\n   began. Leave them and their files alone."
    : "";
  return `Codex just finished a turn in this repo and these project checks failed:

${failed}

1. ${diffNote} Read only the parts you need to fix a failure.
2. Fix only lint, formatting and type errors, then re-run only the failing commands until they
   pass or only other failures remain. If a test, build or behavior fails for any other reason,
   do not fix it: report the command and the error. Don't revert Codex's work to make checks pass.
   If a check fails under Bash with a process-start error (such as 0xc0000142 on Windows),
   re-run that check with the PowerShell tool before treating it as a real failure.${baselineNote}
3. Don't judge whether the change matches its plan. A separate review step does that.
4. Never run git commit, git add or git push. The user commits by hand.
End with a short report: each command you re-ran and its result, the files you changed, and
the failures you left for rework.`;
}

function tail(text, max) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

// The baseline of the autopilot run that is verifying this task, if any.
function taskBaseline(task) {
  if (!task || !autopilotActive()) return null;
  const status = readJson(path.join(".codex", "autopilot", "status.json")) || {};
  return status.slug === task ? lib.readBaseline(repoRoot, task) : null;
}

// Concurrent by default (builds last); "parallelChecks": false in verify.json runs them one
// at a time.
async function runChecks(checks, baseline) {
  const results = await lib.runCommandsAsync(repoRoot, checks, { timeout: checkTimeoutMs });
  return results.map((result) => {
    if (result.ok) return { cmd: result.cmd, ok: true, status: result.status, tail: "" };
    const { preexisting, newLines } = lib.classifyFailure(baseline, result.cmd, result.output);
    return { cmd: result.cmd, ok: preexisting, preexisting, newLines, status: result.status, tail: tail(result.output, 2500) };
  });
}

function checksReport(results, fixerReport) {
  const verdict = (r) => (r.preexisting ? `PASS (pre-existing failures only: ${r.status}, already failing before the task started)` : r.ok ? "PASS" : `FAIL (${r.status})`);
  const lines = results.length
    ? results.map((r) => `- \`${r.cmd}\`: ${verdict(r)}${(r.ok && !r.preexisting) || !r.tail ? "" : `\n${r.tail.replace(/^/gm, "    ")}`}`)
    : ["- No checks are configured for this repo, so none ran (add .codex/verify.json to define them)."];
  return [`Checks run by the verify script:`, ...lines, ...(fixerReport ? ["", "Claude fix step:", fixerReport] : [])].join("\n");
}

// Deterministic: flag an Impeccable live-mode block the change adds, in the diff's added lines.
function addsLiveBlock(diff) {
  return diff.split("\n").some((line) => line.startsWith("+") && /impeccable-live-start|localhost[^\s"']*\/live\.js/.test(line));
}

function checksTools(checks) {
  const tools = ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)"];
  for (const check of checks) {
    tools.push(`Bash(${check}:*)`);
    if (isWindows) tools.push(`PowerShell(${check}:*)`);
  }
  return tools;
}

async function stepChecks(checks, task) {
  const baseline = taskBaseline(task);
  let results = await runChecks(checks, baseline);
  let fixerReport = "";
  let fixerError = null;
  if (results.some((r) => !r.ok)) {
    const fix = await lib.runClaudeAsync(repoRoot, {
      name: "checks-fix",
      task,
      prompt: fixPrompt(results.filter((r) => !r.ok)),
      model: "sonnet",
      effort: "low",
      permissionMode: "acceptEdits",
      allowed: checksTools(checks),
    });
    fixerError = fix.error || null;
    fixerReport = fixerError ? `Failed to start claude: ${fixerError.message}` : tail(fix.text, 1500);
    if (!fixerError) results = await runChecks(checks, baseline);
  }
  return { results, fixerReport, ok: results.every((r) => r.ok) };
}

function alignmentPrompt(ctx, gateNote) {
  const plan = ctx.plan
    ? `- Plan: ${ctx.plan.rel}\n- Current phase: ${ctx.plan.phase === "infer" ? "not named; infer it from the plan and the diff" : ctx.plan.phase}`
    : "- Plan: none found in .codex/plans/. Review the change on its own and say so.";
  return `You are reviewing a Codex implementation against its plan. Do NOT edit any file.

Inputs:
${plan}
- Diff for this phase: ${diffNote}
- Phase gate: ${gateNote || "not run by the verify script; report the gate command from the plan and whether the diff gives evidence it passes"}
- The project's checks (typecheck, lint, build, tests) and, for UI phases, a browser audit run
  in parallel with you and are reported separately. Don't run them.

For the current phase, report:
1. DONE: **Done when** and **Covers** items clearly satisfied, with file:line evidence.
2. PARTIAL: items started but incomplete.
3. MISSING: items in the plan with no evidence in the diff.
4. OUT OF SCOPE: changed files or behavior the plan did not ask for.
5. HANDS OFF: does the change provide what the phase's **Hands off** says the next phase relies on?
6. GATE: the gate result above.
7. RISKS: contract mismatches (API shape vs frontend types), migrations, auth changes.

Judge from the diff and the files, not from Codex's own summary.
End with exactly one line: VERDICT: PASS | NEEDS REWORK`;
}

// Step B reads only. Write tools are denied outright, not just left off the allow list.
const alignmentTools = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)"];
const alignmentDenied = ["Edit", "Write", "NotebookEdit", "PowerShell"];

async function stepAlignment(ctx, model, task, gateNote) {
  const result = await lib.runClaudeAsync(repoRoot, {
    name: "alignment",
    task,
    prompt: alignmentPrompt(ctx, gateNote),
    model,
    effort: ctx.config.effort,
    allowed: alignmentTools,
    denied: alignmentDenied,
  });
  const report = result.text || (result.error ? `Failed to start claude: ${result.error.message}` : result.stderr);
  const verdicts = [...report.matchAll(/^[\s*_`>]*VERDICT:\s*(PASS|NEEDS REWORK)/gim)];
  return { started: !result.error, verdict: verdicts.length ? verdicts[verdicts.length - 1][1].toUpperCase() : "", report };
}

// ---- Step C: UI audit ----

const uiTools = [
  "Read",
  "Grep",
  "Glob",
  ...["navigate", "navigate_back", "snapshot", "take_screenshot", "resize", "click", "type", "hover", "press_key", "select_option", "console_messages", "network_requests", "wait_for", "close"].map(
    (tool) => `mcp__playwright__browser_${tool}`,
  ),
];
const uiDenied = ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "mcp__playwright__browser_evaluate", "mcp__playwright__browser_run_code"];

async function responds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

// Reuses an app already answering on the URL; otherwise starts it and waits until it answers.
async function ensureApp(ui, logFile) {
  if (await responds(ui.url)) return { ok: true, note: `app already running at ${ui.url}` };
  if (!ui.startCommand) return { ok: false, note: `nothing answers at ${ui.url} and no start command is set (plan "- Start:" or verify.json ui.startCommand)` };
  const out = fs.openSync(logFile, "w");
  const child = spawn(ui.startCommand, { cwd: repoRoot, shell: true, windowsHide: true, detached: !isWindows, stdio: ["ignore", out, out] });
  const deadline = Date.now() + ui.readyTimeoutSec * 1000;
  let exited = false;
  child.on("exit", () => (exited = true));
  while (Date.now() < deadline && !exited) {
    if (await responds(ui.url)) return { ok: true, child, note: `started \`${ui.startCommand}\`` };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  lib.killTree(child.pid);
  return { ok: false, note: `\`${ui.startCommand}\` ${exited ? "exited" : `didn't answer at ${ui.url} within ${ui.readyTimeoutSec}s`}; see ${path.relative(repoRoot, logFile)}` };
}

function uiPrompt(ctx, ui, outDir) {
  const design = exists("DESIGN.md") ? "\n- Follow DESIGN.md (read it first) for the expected visual system." : "";
  return `You are auditing the UI of a Codex implementation in a real browser, using the Playwright tools. Do NOT edit any file.

- Plan: ${ctx.plan.rel}, phase ${ctx.plan.phase}
- App URL: ${ui.url}
- Viewports (width in px): ${ui.viewports.join(", ")}
- What this phase must show:
${ui.items || "(no phase-specific items)"}
- Plan-wide UI checks:
${ui.checks.length ? ui.checks.map((check) => `  - ${check}`).join("\n") : "  (none)"}${design}

For each viewport: resize, navigate, take a snapshot, and do the interactions the items need.
Take a screenshot of each state you judge (they are saved in ${path.relative(repoRoot, outDir)}).
Check the items above, plus: layout breaks, overflow and clipped text, overlapping elements,
console errors, failed network requests, missing focus states and unlabeled controls.

Report each item as PASS or FAIL with what you saw, then any other problems found.
If the page can't be loaded at all, say so and use BLOCKED.
End with exactly one line: UI AUDIT: PASS | NEEDS REWORK | BLOCKED`;
}

async function stepUiAudit(ctx, task, taskDir, tag, checksDone) {
  const ui = ctx.ui;
  if (!ui) return { status: "not run", report: "" };
  if (!ui.url) return { status: "BLOCKED", report: "No UI audit URL: set `- URL:` in the plan's ## UI audit section or ui.url in .codex/verify.json." };
  const outDir = path.join(taskDir, `${tag}.ui`);
  fs.mkdirSync(outDir, { recursive: true });
  const mcp = lib.playwrightMcpConfig(outDir);
  if (!mcp) return { status: "BLOCKED", report: "Playwright MCP or its Chromium isn't installed globally; re-run the workflow setup." };
  const mcpFile = path.join(taskDir, `${tag}.playwright.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));

  // A dev server and a build share output folders, so wait for Step A before starting the app
  // (unless ui.parallelWithChecks is set). An app that is already running is used right away.
  if (!(await responds(ui.url)) && lib.verifyConfig(repoRoot).ui?.parallelWithChecks !== true) await checksDone;
  const app = await ensureApp(ui, path.join(taskDir, `${tag}.app.log`));
  if (!app.ok) return { status: "BLOCKED", report: app.note };
  try {
    const config = lib.verifyConfig(repoRoot).ui || {};
    const result = await lib.runClaudeAsync(repoRoot, {
      name: "ui-audit",
      task,
      prompt: uiPrompt(ctx, ui, outDir),
      model: config.model || "sonnet",
      effort: config.effort || "medium",
      allowed: uiTools,
      denied: uiDenied,
      mcpConfig: mcpFile,
      timeout: uiAuditTimeoutMs,
    });
    const report = result.text || (result.error ? `Failed to start claude: ${result.error.message}` : result.stderr);
    const verdicts = [...report.matchAll(/^[\s*_`>]*UI AUDIT:\s*(PASS|NEEDS REWORK|BLOCKED)/gim)];
    const status = verdicts.length ? verdicts[verdicts.length - 1][1].toUpperCase() : result.error ? "BLOCKED" : "NEEDS REWORK";
    return { status, report: `${app.note}\n\n${report}` };
  } finally {
    if (app.child) lib.killTree(app.child.pid);
  }
}

function runTag(ctx) {
  const phase = ctx.plan && ctx.plan.phase && ctx.plan.phase !== "infer" ? ctx.plan.phase : "";
  return phase ? `phase-${phase}` : `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function runVerification() {
  fs.mkdirSync(stateDir, { recursive: true });
  const checks = detectChecks();
  const ctx = context();
  const task = ctx.plan ? path.basename(ctx.plan.rel, ".md") : "";
  const taskDir = lib.taskVerifyDir(repoRoot, task);
  fs.mkdirSync(taskDir, { recursive: true });
  const tag = runTag(ctx);
  const model = ctx.risk ? ctx.config.riskModel : ctx.config.model;
  const modelLine = `${model} / effort ${ctx.config.effort}${ctx.risk ? ` (risk: ${ctx.risk})` : ""}`;
  const range = `${ctx.base.tree.slice(0, 7)} (${ctx.base.from}) -> working tree`;
  writeDiff(ctx.base.tree, ctx.current);
  fs.copyFileSync(diffPath, path.join(taskDir, `${tag}.diff`));

  fs.writeFileSync(
    logPath,
    [
      `Claude verification started ${new Date().toISOString()}`,
      `Range: ${range} | Plan: ${planLabel(ctx)}`,
      `Step A checks: ${checks.length ? checks.join(" | ") : "(none configured)"}`,
      `Step B alignment: ${modelLine}`,
      `Step C UI audit: ${ctx.ui ? `${ctx.ui.url || "(no URL)"} at ${ctx.ui.viewports.join(", ")} (${ctx.ui.reason})` : "not needed for this phase"}`,
      "Steps A, B and C run in parallel.",
      "",
      "",
    ].join("\n"),
  );

  const liveBlock = addsLiveBlock(lib.diffText(repoRoot, ctx.base.tree, ctx.current));
  const checksPromise = stepChecks(checks, task);
  const [checksResult, alignment, uiAudit] = await Promise.all([
    checksPromise,
    stepAlignment(ctx, model, task, flagValue("--gate")),
    stepUiAudit(ctx, task, taskDir, tag, checksPromise),
  ]);

  const checksText = [liveBlock ? "MUST REMOVE BEFORE COMMIT: the change adds an Impeccable live-mode block.\n" : "", checksReport(checksResult.results, checksResult.fixerReport)].join("");
  fs.appendFileSync(logPath, `${checksText}\n`);
  const carried = checksResult.results.filter((r) => r.preexisting).map((r) => r.cmd);
  const checksStatus = checks.length === 0 ? "none" : !checksResult.ok ? "fail" : carried.length ? `pass (pre-existing failures: ${carried.join(", ")})` : "pass";

  const reviewed = lib.snapshot(repoRoot);
  const passed = alignment.verdict === "PASS" && checksResult.ok && uiAudit.status !== "NEEDS REWORK";
  const verdict = !alignment.started ? "NOT RUN" : passed ? "PASS" : "NEEDS REWORK";
  const reasons = [
    alignment.verdict !== "PASS" ? `alignment ${alignment.verdict || "gave no verdict"}` : "",
    checksResult.ok ? "" : "checks still fail after the fix step",
    uiAudit.status === "NEEDS REWORK" ? "UI audit NEEDS REWORK" : "",
  ].filter(Boolean);

  const header = [
    "# Verification",
    "",
    `- Run: ${new Date().toISOString()}`,
    `- Plan: ${planLabel(ctx)}`,
    `- Range: ${ctx.base.tree} (${ctx.base.from}) -> ${reviewed} (working tree)`,
    `- Verdict: ${verdict}${reasons.length && verdict !== "NOT RUN" ? ` (${reasons.join("; ")})` : ""}`,
    `- Alignment (${modelLine}): ${alignment.verdict || (alignment.started ? "none (treated as NEEDS REWORK)" : "claude did not start")}`,
    `- Checks: ${checksStatus}`,
    `- UI audit: ${uiAudit.status}`,
    "",
    "---",
    "",
    "## Alignment",
    "",
    alignment.report,
    ...(checksResult.ok ? [] : ["", "## Checks that still fail", "", checksText]),
    ...(uiAudit.report ? ["", "## UI audit", "", uiAudit.report] : []),
    "",
  ].join("\n");
  fs.writeFileSync(alignmentPath, header);
  fs.copyFileSync(alignmentPath, path.join(taskDir, `${tag}.alignment.md`));
  if (uiAudit.report) fs.writeFileSync(path.join(taskDir, `${tag}.ui-audit.md`), `# UI audit: ${uiAudit.status}\n\n${uiAudit.report}\n`);

  // Advance the verified snapshot only on PASS; otherwise keep this run's base, so the same
  // phase is reviewed again. Record the post-run state either way, so Claude's own fixes
  // don't trigger another run on the next Stop.
  const nextBase = passed ? reviewed : ctx.base.tree;
  writeState({
    verifiedTree: nextBase,
    verifiedHead: ctx.head,
    fingerprint: `${nextBase}:${reviewed}`,
    lastVerdict: verdict,
    lastAlignment: alignment.verdict || "none",
    lastChecks: checksStatus,
    lastUiAudit: uiAudit.status,
    lastPlan: planLabel(ctx),
    lastTask: task,
    lastReports: path.relative(repoRoot, taskDir).split(path.sep).join("/"),
    reported: false,
  });
  fs.appendFileSync(
    logPath,
    `\nFinished ${new Date().toISOString()} | Checks: ${checksStatus} | Alignment: ${alignment.verdict || "none"} | UI audit: ${uiAudit.status} | Verdict: ${verdict}, see ${path.relative(repoRoot, alignmentPath)}\n`,
  );
  fs.copyFileSync(logPath, path.join(taskDir, `${tag}.checks.log`));
}

if (process.argv.includes("--print-checks")) {
  const checks = detectChecks();
  console.log(checks.length ? checks.join("\n") : "(no checks detected; add .codex/verify.json)");
  const ctx = context();
  const { model, effort, riskModel, riskPaths } = ctx.config;
  console.log(`\nAlignment: ${model}/${effort}, risk model ${riskModel}, risk paths: ${riskPaths.join(", ") || "(none)"}`);
  console.log(`Range: ${ctx.base.tree.slice(0, 7)} (${ctx.base.from}) -> working tree, ${ctx.files.length} changed file(s)`);
  console.log(`Plan: ${planLabel(ctx)}`);
  console.log(`Risk: ${ctx.risk || "normal"} -> Step B uses ${ctx.risk ? riskModel : model}`);
  const ui = lib.uiSettings(repoRoot, "");
  console.log(`UI audit: ${ui.url ? `${ui.url}, start \`${ui.startCommand || "(already running)"}\`, viewports ${ui.viewports.join(", ")}` : "no ui.url in .codex/verify.json (a plan's ## UI audit section can set it)"}`);
} else if (process.argv.includes("--run")) {
  runVerification()
    .catch((error) => {
      fs.appendFileSync(logPath, `\nVerification crashed: ${error.stack || error}\n`);
      writeState({ ...readState(), lastVerdict: "NOT RUN", reported: false });
    })
    .finally(() => {
      fs.rmSync(lockPath, { force: true });
      emitHookResult();
    });
} else if (process.env.CODEX_AUTOPILOT === "1" || autopilotActive()) {
  // Autopilot runs verification itself after each phase; don't start an overlapping run.
  emitHookResult();
} else {
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx = context();
  const messages = [];
  if (ctx.state.lastVerdict && ctx.state.reported === false) {
    messages.push(`Last Claude verification: ${ctx.state.lastVerdict} for ${ctx.state.lastPlan}; see .codex/verify/alignment.md`);
    writeState({ ...ctx.state, reported: true });
  }
  const lockAgeMs = fs.existsSync(lockPath) ? Date.now() - fs.statSync(lockPath).mtimeMs : Infinity;

  if (ctx.files.length === 0 || ctx.hash === ctx.state.fingerprint || lockAgeMs < lockTimeoutMs) {
    emitHookResult(messages.join("\n"));
    process.exit(0);
  }

  fs.writeFileSync(lockPath, String(Date.now()));
  spawn(process.execPath, [__filename, "--run"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  messages.push(`Claude verification started in the background; see ${path.relative(repoRoot, logPath)}`);
  emitHookResult(messages.join("\n"));
}
