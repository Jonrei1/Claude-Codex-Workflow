/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Autopilot: run an approved plan end to end, handed to Codex automatically.
//
// Claude saves the plan to .codex/plans/<slug>.md, runs `check`, then `handoff`, which posts
// `Execute .codex/plans/<slug>.md ...` into the open Codex session for this repo (waiting for
// one to appear, else printing the line to paste). Claude then runs `wait` in the background and reviews the
// result when the run ends. Codex (following .codex/workflow/CODEX.md "Full plan
// execution") calls the other steps from its own session:
//
//   node .codex/autopilot.js check   .codex/plans/<slug>.md      planning checklist (exit 1 if not runnable)
//   node .codex/autopilot.js handoff .codex/plans/<slug>.md      send the plan to Codex [--phase N] [--continue]
//                                                                 [--thread <id>] [--wait <s>] [--new-terminal] [--print]
//   node .codex/autopilot.js wait    .codex/plans/<slug>.md      block until the run is done, stuck or failed
//   node .codex/autopilot.js begin   .codex/plans/<slug>.md      start snapshot, status "running"
//   node .codex/autopilot.js triage  .codex/plans/<slug>.md      Claude triages ## Codex Findings
//   node .codex/autopilot.js phase   .codex/plans/<slug>.md <N>  snapshot the phase's starting tree
//   node .codex/autopilot.js verify  .codex/plans/<slug>.md <N>  gate, then claude-verify.js --run
//   node .codex/autopilot.js close   .codex/plans/<slug>.md      graphify update + Claude task summary
//   node .codex/autopilot.js usage  [.codex/plans/<slug>.md]     headless Claude token usage so far
//
// Exit codes: 0 ok / PASS, 1 failed, 2 gate failed (fix and verify again),
// 3 NEEDS REWORK (read .codex/verify/alignment.md, fix, verify again), 4 stuck (stop),
// 5 handoff couldn't reach Codex (paste the printed line), 6 wait timed out.
//
// `node .codex/autopilot.js run .codex/plans/<slug>.md [--resume] [--force]` is the
// unattended fallback: the driver itself calls `codex exec` per phase, with the same steps.
//
// Nothing is committed, staged or pushed: every change is left in the working tree for
// the user to review and commit. Phases are tracked with snapshots (workflow-lib.js).
// Progress: .codex/autopilot/status.json and .codex/autopilot/<slug>.log.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./hooks/workflow-lib");

const valueFlags = new Set(["--thread", "--phase", "--since", "--timeout", "--wait"]);
const args = process.argv.slice(2);
const flags = new Set();
const flagValues = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const [name, inline] = arg.split(/=(.*)/s);
  flags.add(name);
  if (inline !== undefined) flagValues[name] = inline;
  else if (valueFlags.has(name) && args[i + 1] !== undefined) flagValues[name] = args[++i];
}
const flagValue = (name) => flagValues[name] || "";
const commands = ["check", "handoff", "wait", "begin", "triage", "phase", "verify", "close", "run", "usage"];
const command = commands.includes(positional[0]) ? positional.shift() : flags.has("--dry-run") ? "check" : "run";
const [planArg, phaseArg] = positional;
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const runDir = path.join(repoRoot, ".codex", "autopilot");
const statusPath = path.join(runDir, "status.json");
const handoffPath = path.join(runDir, "handoff.json");
const lockPath = path.join(runDir, "running.lock");
const verifyScript = path.join(repoRoot, ".codex", "hooks", "claude-verify.js");
const verifyStatePath = path.join(repoRoot, ".codex", "verify", "state.json");
const callTimeoutMs = 30 * 60 * 1000;
const lockTimeoutMs = 6 * 60 * 60 * 1000;
const maxReworks = 2;
const exitCodes = { failed: 1, gate: 2, rework: 3, stuck: 4, manual: 5, timeout: 6 };
const childEnv = { ...process.env, CODEX_AUTOPILOT: "1" };

// A deliberate stop: state is "stuck" (needs a human decision) or "failed" (broken step).
class Stop extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
  }
}

// A wrong call (bad phase, step out of order). It doesn't change the run's state.
class Usage extends Error {}

let slug = "";
let planRel = "";
let logPath = "";
let status = {};

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFile(file));
  } catch {
    return null;
  }
}

function tail(text, max) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  if (logPath) fs.appendFileSync(logPath, stamped + "\n");
}

function setStatus(fields) {
  status = { ...status, ...fields, updated: new Date().toISOString() };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: callTimeoutMs,
    env: childEnv,
    ...options,
  });
}

// Windows starts codex through a .cmd shim, which needs a shell. Arguments are quoted, and
// the messages this script sends contain no shell metacharacters.
function quoteArg(arg) {
  return /[\s()]/.test(arg) ? `"${arg}"` : arg;
}

function runCodex(commandArgs, options = {}) {
  if (!isWindows) return run("codex", commandArgs, options);
  return run(["codex", ...commandArgs].map(quoteArg).join(" "), [], { shell: true, ...options });
}

function snapshot() {
  return lib.snapshot(repoRoot);
}

function saveOutput(name, result) {
  const file = path.join(runDir, `${slug}.${name}.out.log`);
  fs.writeFileSync(file, `${result.stdout || ""}\n${result.stderr || ""}`);
  return path.relative(repoRoot, file);
}

function codex(prompt, name) {
  const lastMessage = path.join(runDir, `${slug}.${name}.md`);
  log(`codex: ${name}`);
  const result = runCodex(["exec", "-s", "workspace-write", "-C", repoRoot, "-o", lastMessage, "-"], { input: prompt });
  const output = saveOutput(`codex.${name}`, result);
  if (result.error) throw new Stop("failed", `codex ${name} didn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Stop("failed", `codex ${name} exited with ${result.status}; see ${output}`);
  return readFile(lastMessage).trim();
}

function claude(prompt, name, { model, effort, tools }) {
  log(`claude (${model}/${effort}): ${name}`);
  const result = lib.runClaude(repoRoot, { name, task: slug, prompt, model, effort, allowed: tools, env: childEnv, timeout: callTimeoutMs });
  const output = saveOutput(`claude.${name}`, { stdout: result.text, stderr: result.stderr });
  if (result.error) throw new Stop("failed", `claude ${name} didn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Stop("failed", `claude ${name} exited with ${result.status}; see ${output}`);
  return result.text;
}

function readPlan() {
  const text = readFile(path.join(repoRoot, planRel));
  return { text, meta: lib.frontmatter(text), phases: lib.parsePhases(text) };
}

function assertPlanValid(plan) {
  const problems = lib.planProblems(repoRoot, slug, plan.text);
  if (problems.length) throw new Stop("failed", `${planRel} isn't runnable:\n  - ${problems.join("\n  - ")}`);
}

const autopilotRules = `Autopilot run. Follow ${lib.codexRulesRel} "Phase execution", with these changes:
- Never run git commit, git add, git stash or git push, and don't run \`graphify update\`. The user commits by hand; the driver runs the gate and the verification.
- Work on this phase only. Do not start the next phase.
- Run the phase gate yourself before you finish, and fix failures within the phase.`;

function implementPrompt(phase, resuming) {
  const resume = resuming
    ? "\nAn earlier autopilot run was interrupted. Some of this phase's work may already be in the working tree; continue from it.\n"
    : "";
  return `Execute phase ${phase.id} of ${planRel}.
${resume}
${autopilotRules}

End with: \`Phase ${phase.id} done. Gate: <command> -> <pass/fail>.\``;
}

function gateFixPrompt(phase, failure) {
  return `The gate for phase ${phase.id} of ${planRel} failed:

$ ${failure.gate}
${failure.output}

Fix it within the phase's scope.

${autopilotRules}`;
}

function reworkPrompt(phase, attempt) {
  return `Rework phase ${phase.id} of ${planRel}. The verification in .codex/verify/alignment.md returned NEEDS REWORK (rework attempt ${attempt} of ${maxReworks}).

Read the report. Fix every MISSING and PARTIAL item, every check that still fails and every UI audit FAIL, and undo every change listed under OUT OF SCOPE, staying within the phase's scope. If a finding is about code this phase didn't touch, leave that code alone and say so in your reply.

${autopilotRules}`;
}

function runGates(phase) {
  for (const gate of phase.gates) {
    log(`gate: ${gate}`);
    const result = spawnSync(gate, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: callTimeoutMs,
      env: childEnv,
    });
    if (result.status !== 0) {
      const output = tail(`${result.stdout || ""}\n${result.stderr || ""}`.trim(), 3000);
      log(`gate failed (exit ${result.status ?? "timeout"}): ${gate}`);
      return { ok: false, gate, output };
    }
  }
  return { ok: true };
}

function gateWithFix(phase, name) {
  let result = runGates(phase);
  if (result.ok) return;
  codex(gateFixPrompt(phase, result), `phase${phase.id}.${name}.gatefix`);
  result = runGates(phase);
  if (!result.ok) {
    throw new Stop("failed", `phase ${phase.id}: gate \`${result.gate}\` still fails after one fix attempt:\n${result.output}`);
  }
}

// Steps A (checks), B (alignment) and C (UI audit) run in parallel inside claude-verify.js.
function verify(phase, phaseBase) {
  log(`verify: phase ${phase.id} (checks, alignment and UI audit in parallel)`);
  const gateNote = `passed (run by autopilot): ${phase.gates.join(" && ")}`;
  const result = run(process.execPath, [verifyScript, "--run", "--base", phaseBase, "--plan", planRel, "--phase", phase.id, "--gate", gateNote], {
    timeout: 2 * callTimeoutMs,
  });
  if (result.error) throw new Stop("failed", `verification didn't run: ${result.error.message}`);
  const state = readJson(verifyStatePath) || {};
  const verdict = state.lastVerdict || "none";
  if (verdict === "NOT RUN") throw new Stop("failed", "the Claude verification didn't start; see .codex/verify/last.log");
  log(`verdict: ${verdict} (alignment ${state.lastAlignment || "?"}, checks ${state.lastChecks || "?"}, UI audit ${state.lastUiAudit || "?"}; see .codex/verify/alignment.md)`);
  const phases = { ...(status.phases || {}) };
  phases[phase.id] = { verdict, alignment: state.lastAlignment, checks: state.lastChecks, ui: state.lastUiAudit, reports: `${state.lastReports || ""}/phase-${phase.id}.*` };
  setStatus({ phases });
  return verdict === "PASS";
}

function needsPlanReview(plan) {
  return plan.meta.review === "codex" || plan.meta.risk === "high";
}

const origRel = () => `${lib.plansRel}/.${slug}.orig.md`;

function saveOriginal(plan) {
  fs.writeFileSync(path.join(repoRoot, origRel()), plan.text);
}

// Unattended mode: Codex reviews the plan through `codex exec`, then Claude triages.
function planReview() {
  const plan = readPlan();
  if (!needsPlanReview(plan)) return;
  if (plan.text.includes("## Codex Findings")) {
    log("plan review: findings already present, skipping");
    return;
  }
  setStatus({ step: "plan-review" });
  saveOriginal(plan);
  const reply = codex(
    `Review ${planRel}\n\nFollow ${lib.codexRulesRel} "Plan review". Autopilot run: only append the \`## Codex Findings\` section to the plan. Don't edit anything else, and never commit.`,
    "plan-review",
  );
  triageFindings(reply);
}

// Checks that Codex only appended findings, then has a headless Claude run accept or
// reject each one and fold the accepted ones into the plan.
function triageFindings(reply = "") {
  const reviewed = readFile(path.join(repoRoot, planRel));
  const findingsAt = reviewed.indexOf("## Codex Findings");
  if (findingsAt === -1) throw new Stop("failed", "plan review: the plan has no ## Codex Findings section");
  const original = readFile(path.join(repoRoot, origRel()));
  if (original && reviewed.slice(0, findingsAt).trimEnd() !== original.trimEnd()) {
    throw new Stop("stuck", `plan review: the plan changed above its findings; compare ${planRel} with ${origRel()}`);
  }
  if (/PLAN REVIEW:\s*APPROVE/.test(reviewed.slice(findingsAt) + reply)) {
    log("plan review: APPROVE");
    return;
  }
  setStatus({ step: "plan-triage" });
  claude(
    `You are triaging Codex's review of ${planRel}. Under "## Codex Findings", mark each finding ACCEPTED or REJECTED with a one-line reason. Judge each against the real codebase; use \`graphify query\` when it helps.

For each accepted finding, update the plan itself: edit the affected phase's Scope, Steps, Covers, Done when, Hands off or Gate, or add an intermediate phase such as "## Phase 2.5: <title>" in the same format as the others (every field, and a Gate with a runnable command). Don't renumber existing phases. Don't edit any file except ${planRel}.

End with one line: TRIAGE: <n> accepted, <n> rejected.`,
    "plan-triage",
    {
      model: "sonnet",
      effort: "medium",
      tools: ["Read", "Grep", "Glob", `Edit(${planRel})`, "Bash(graphify query:*)", "Bash(graphify explain:*)", "Bash(graphify path:*)"],
    },
  );
  assertPlanValid(readPlan());
  log("plan review: triaged");
}

function runPhase(phase, resume) {
  const verifyOnly = resume && ["verify", "rework"].includes(resume.step) && lib.treeExists(repoRoot, resume.phaseBase);
  const phaseBase = verifyOnly ? resume.phaseBase : snapshot();
  setStatus({ phase: phase.id, step: "implement", attempt: 0, phaseBase });
  log(`--- phase ${phase.id}: ${phase.title} (starting snapshot ${phaseBase.slice(0, 7)})`);

  if (!verifyOnly) {
    codex(implementPrompt(phase, Boolean(resume)), `phase${phase.id}`);
    gateWithFix(phase, "implement");
    if (lib.changedFiles(repoRoot, phaseBase, snapshot()).length === 0 && !resume) {
      throw new Stop("failed", `phase ${phase.id}: Codex made no changes`);
    }
  }

  for (let attempt = 1; ; attempt++) {
    setStatus({ step: "verify", attempt: attempt - 1 });
    if (verify(phase, phaseBase)) return;
    if (attempt > maxReworks) {
      throw new Stop("stuck", `phase ${phase.id} still needs rework after ${maxReworks} attempts; see .codex/verify/alignment.md`);
    }
    setStatus({ step: "rework", attempt });
    const before = snapshot();
    codex(reworkPrompt(phase, attempt), `phase${phase.id}.rework${attempt}`);
    gateWithFix(phase, `rework${attempt}`);
    if (snapshot() === before) {
      throw new Stop("stuck", `phase ${phase.id}: Codex made no changes for rework attempt ${attempt}; see .codex/verify/alignment.md`);
    }
  }
}

function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function summaryRel() {
  return `${lib.tasksRel}/${localDate()}-${slug}.md`;
}

// graphify update and the task summary don't depend on each other, so they run together.
async function close() {
  setStatus({ phase: "", step: "close", attempt: 0 });
  log("--- close (graphify update and task summary in parallel)");
  const summary = summaryRel();
  fs.mkdirSync(path.join(repoRoot, lib.tasksRel), { recursive: true });
  const graphify = new Promise((resolve) => {
    const child = spawn("graphify", ["update", "."], { cwd: repoRoot, shell: isWindows, windowsHide: true, stdio: "ignore", env: childEnv });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  log("claude (sonnet/low): close");
  const [graphOk, result] = await Promise.all([
    graphify,
    lib.runClaudeAsync(repoRoot, {
      name: "close",
      task: slug,
      prompt: `close ${slug}

Autopilot run. Follow "Closing a task" in CLAUDE.local.md. Read ${planRel}, the reports in .codex/verify/${slug}/ and the task's changes. Write the summary to ${summary}. Don't edit any other file, and never run git commit, git add or git push: the user commits by hand.`,
      model: "sonnet",
      effort: "low",
      allowed: ["Read", "Grep", "Glob", `Write(${summary})`, `Edit(${summary})`, "Bash(git status:*)", "Bash(git diff:*)"],
      env: childEnv,
      timeout: callTimeoutMs,
    }),
  ]);
  if (graphOk) log("graphify update . done");
  const output = saveOutput("claude.close", { stdout: result.text, stderr: result.stderr });
  if (result.error) throw new Stop("failed", `claude close didn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Stop("failed", `claude close exited with ${result.status}; see ${output}`);
  if (!fs.existsSync(path.join(repoRoot, summary))) throw new Stop("failed", `close: ${summary} wasn't written`);
  setStatus({ summary });
  log(`summary written: ${summary}`);
}

function notify(message) {
  process.stdout.write("\x07");
  if (isWindows) {
    const text = message.replace(/'/g, "''").slice(0, 200);
    const script = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(10000,'Autopilot','${text}','Info');Start-Sleep -Seconds 6;$n.Dispose()`;
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000 });
  }
}

function printChecklist(plan) {
  const items = lib.planChecklist(repoRoot, slug, plan.text);
  console.log(`Plan: ${planRel} (risk: ${plan.meta.risk || "?"}, review: ${plan.meta.review || "none"}, ui: ${plan.meta.ui || "?"})\n`);
  for (const item of items) console.log(`  [${item.ok ? "x" : " "}] ${item.item}${item.ok || !item.detail ? "" : ` -- ${item.detail}`}`);
  for (const phase of plan.phases) {
    console.log(`\nPhase ${phase.id}: ${phase.title}\n  covers: ${(phase.covers || []).join(", ") || "(none)"}\n  gate: ${phase.gates.join(" && ") || "(none)"}${phase.uiAudit ? "\n  UI audit: yes" : ""}`);
  }
  const failed = items.filter((item) => !item.ok);
  console.log(`\nPlan review: ${needsPlanReview(plan) ? "yes (Codex reviews, Claude triages)" : "no"}`);
  console.log(failed.length ? `\nNot runnable: ${failed.length} item(s) to fix.` : "\nRunnable.");
  return failed.length;
}

function usage() {
  console.error(`usage:
  node .codex/autopilot.js check|begin|triage|close .codex/plans/<slug>.md
  node .codex/autopilot.js handoff .codex/plans/<slug>.md [--phase N | --continue] [--thread <id>] [--wait <seconds>] [--new-terminal] [--print]
  node .codex/autopilot.js wait .codex/plans/<slug>.md [--since <iso>] [--timeout <seconds>]
  node .codex/autopilot.js phase|verify .codex/plans/<slug>.md <N>
  node .codex/autopilot.js run .codex/plans/<slug>.md [--resume] [--force]
  node .codex/autopilot.js usage [.codex/plans/<slug>.md]   headless Claude token usage`);
  process.exit(exitCodes.failed);
}

function findPhase(id) {
  const phase = readPlan().phases.find((candidate) => candidate.id === id);
  if (!phase) throw new Usage(`${planRel} has no phase ${id}`);
  return phase;
}

// Codex-driven steps are separate processes that share .codex/autopilot/status.json.
function requireActive() {
  if (status.slug !== slug || !["running", "stuck", "failed"].includes(status.state)) {
    throw new Usage(`no active run for ${planRel}; run \`node .codex/autopilot.js begin ${planRel}\` first`);
  }
  setStatus({ state: "running", reason: "" });
}

// ---- handoff: send the plan to Codex ----

// No quotes, semicolons or other shell metacharacters: the message goes through cmd.exe,
// Windows Terminal, AppleScript and sh unchanged.
function handoffMessage() {
  if (flags.has("--continue")) {
    return `Continue ${planRel}: read .codex/autopilot/status.json and re-run the step that stopped, then carry on. Follow ${lib.codexRulesRel}, section Full plan execution.`;
  }
  const phase = flagValue("--phase");
  return phase
    ? `Execute phase ${phase} of ${planRel}. Follow ${lib.codexRulesRel}, section Phase execution, single-phase mode.`
    : `Execute ${planRel}. Follow ${lib.codexRulesRel}, section Full plan execution.`;
}

function shQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// Opens a new terminal window in the repo running `codex "<message>"`. True when one started.
function openTerminal(message) {
  const detached = (cmd, cmdArgs, options = {}) => {
    try {
      const child = spawn(cmd, cmdArgs, { cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: false, ...options });
      child.on("error", () => {});
      child.unref();
      return Boolean(child.pid);
    } catch {
      return false;
    }
  };
  if (isWindows) {
    const hasWt = spawnSync("where", ["wt.exe"], { windowsHide: true, stdio: "ignore" }).status === 0;
    const line = hasWt
      ? `wt.exe -d "${repoRoot}" cmd /k codex "${message}"`
      : `start "Codex" /D "${repoRoot}" cmd /k codex "${message}"`;
    return detached(line, [], { shell: true });
  }
  const inner = `cd ${shQuote(repoRoot)} && codex ${shQuote(message)}`;
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script "${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const result = spawnSync("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], { stdio: "ignore" });
    return result.status === 0;
  }
  const shell = `${inner}; exec $SHELL`;
  const candidates = [
    process.env.TERMINAL ? [process.env.TERMINAL, ["-e", "sh", "-c", shell]] : null,
    ["x-terminal-emulator", ["-e", "sh", "-c", shell]],
    ["gnome-terminal", ["--", "sh", "-c", shell]],
    ["konsole", ["-e", "sh", "-c", shell]],
    ["xterm", ["-e", "sh", "-c", shell]],
  ].filter(Boolean);
  for (const [cmd, cmdArgs] of candidates) {
    if (spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0 && detached(cmd, cmdArgs)) return true;
  }
  return false;
}

function recordHandoff(via, thread, message) {
  fs.writeFileSync(handoffPath, JSON.stringify({ slug, plan: planRel, via, thread: thread || "", message, at: new Date().toISOString() }, null, 2) + "\n");
}

// Codex writes a session's rollout file only after its first message, so an idle Codex
// terminal can't be found yet. Poll until the user sends it something or the time runs out.
async function waitForSession(seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const session = lib.findCodexSession(repoRoot);
    if (session || Date.now() >= deadline) return session;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
}

function queueInto(thread, message) {
  const result = runCodex(["queue", "--thread", thread, "--message", message], { timeout: 60 * 1000, env: process.env });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!result.error && result.status === 0 && !/^Error:/m.test(output)) {
    recordHandoff("codex queue", thread, message);
    console.log(`\nSent to Codex session ${thread}:\n  ${message}`);
    return true;
  }
  console.log(`\ncodex queue to ${thread} failed${output ? `: ${tail(output, 500)}` : ""}.`);
  return false;
}

async function cmdHandoff() {
  const plan = readPlan();
  if (!flags.has("--continue") && printChecklist(plan)) {
    console.log("\nNot handed off: fix the plan until `check` is clean.");
    return exitCodes.failed;
  }
  const message = handoffMessage();
  const paste = () => {
    recordHandoff("print", "", message);
    console.log(`\nPaste this into Codex:\n\n${message}\n`);
    return exitCodes.manual;
  };
  if (flags.has("--print")) return paste();

  // A new terminal window only on request: the user usually has Codex open in their IDE.
  if (flags.has("--new-terminal")) {
    if (openTerminal(message)) {
      recordHandoff("new terminal", "", message);
      console.log(`\nOpened a new terminal running Codex with:\n  ${message}`);
      return 0;
    }
    console.log("\nCouldn't open a new terminal.");
    return paste();
  }

  const config = lib.verifyConfig(repoRoot).handoff || {};
  let thread = flagValue("--thread") || config.thread || "";
  if (!thread) {
    let session = lib.findCodexSession(repoRoot);
    if (!session) {
      const seconds = Number(flagValue("--wait") || (config.waitSeconds ?? 90)) || 0;
      if (seconds > 0) {
        console.log(`\nNo Codex session for this repo yet. Send any message in your Codex terminal (e.g. "ready") and the plan will be queued into it. Waiting up to ${seconds}s...`);
        session = await waitForSession(seconds);
      }
    }
    if (session) thread = session.id;
    else console.log("\nNo Codex session found for this repo.");
  }
  if (thread && queueInto(thread, message)) return 0;
  return paste();
}

// ---- wait: block until the run ends, then print what Claude needs to review ----

function waitSummary(current) {
  const lines = [`\nRun ${slug}: ${current.state.toUpperCase()}${current.reason ? ` -- ${current.reason}` : ""}`];
  const phases = current.phases || {};
  for (const phase of readPlan().phases) {
    const result = phases[phase.id];
    lines.push(`  Phase ${phase.id} (${phase.title}): ${result ? `${result.verdict} (alignment ${result.alignment || "?"}, checks ${result.checks || "?"}, UI audit ${result.ui || "?"})` : "not verified"}`);
  }
  lines.push(`Reports: .codex/verify/${slug}/  (latest: .codex/verify/alignment.md, .codex/verify/last.log)`);
  lines.push(`Log: .codex/autopilot/${slug}.log`);
  if (current.summary) lines.push(`Task summary: ${current.summary}`);
  if (current.startTree && lib.treeExists(repoRoot, current.startTree)) {
    const files = lib.changedFiles(repoRoot, current.startTree, snapshot(), lib.workflowPaths);
    lines.push(`Changed files (${files.length}):${files.length ? `\n  ${files.join("\n  ")}` : " none"}`);
  }
  const plan = readPlan();
  if (current.state === "done" && plan.meta.ui === "yes") {
    lines.push(`\nNext (Claude): final UI audit with Playwright MCP from the plan's ## UI audit section; write .codex/verify/${slug}/final-ui-audit.md`);
  } else if (current.state === "done") {
    lines.push("\nNext (Claude): review the reports and the diff, then report to the user.");
  } else {
    lines.push(`\nNext (Claude): explain why it stopped. After a fix, send it back with: node .codex/autopilot.js handoff ${planRel} --continue`);
  }
  return lines.join("\n");
}

async function cmdWait() {
  const handoff = readJson(handoffPath) || {};
  const sinceText = flagValue("--since") || (handoff.slug === slug ? handoff.at : "") || new Date().toISOString();
  const since = Date.parse(sinceText);
  const timeoutMs = Number(flagValue("--timeout") || 6 * 60 * 60) * 1000;
  const started = Date.now();
  let last = "";
  console.log(`Waiting for ${planRel} (since ${sinceText})...`);
  for (;;) {
    const current = readJson(statusPath) || {};
    const mine = current.slug === slug && Date.parse(current.updated || 0) >= since;
    if (mine) {
      const line = `${current.state} | phase ${current.phase || "-"} | ${current.step || "-"}`;
      if (line !== last) console.log(`[${new Date().toISOString()}] ${line}`);
      last = line;
      if (["done", "stuck", "failed"].includes(current.state)) {
        console.log(waitSummary(current));
        return { done: 0, stuck: exitCodes.stuck, failed: exitCodes.failed }[current.state];
      }
    }
    if (Date.now() - started > timeoutMs) {
      console.log(`\nStopped waiting after ${Math.round(timeoutMs / 60000)} min. ${mine ? `Last state: ${last}` : "Codex hasn't started the run yet (no `begin`)."}`);
      return exitCodes.timeout;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

// ---- Codex-driven steps ----

function cmdBegin() {
  const fresh = status.state === "running" && Date.now() - Date.parse(status.updated || 0) < lockTimeoutMs;
  if (fresh && status.slug !== slug && !flags.has("--force")) {
    throw new Usage(`another run (${status.plan}) is still marked running in ${path.relative(repoRoot, statusPath)}; pass --force if it's stale`);
  }
  const plan = readPlan();
  assertPlanValid(plan);
  const start = snapshot();
  status = {};
  setStatus({ slug, plan: planRel, driver: "codex", state: "running", reason: "", phase: "", step: "begin", attempt: 0, startTree: start, phases: {} });
  log(`=== autopilot start (Codex-driven): ${planRel}`);
  if (lib.changedFiles(repoRoot, lib.headTree(repoRoot) || start, start).length) {
    log("note: the working tree already had uncommitted changes; they're part of the starting snapshot and won't be reviewed");
  }
  const review = needsPlanReview(plan) && !plan.text.includes("## Codex Findings");
  if (review) saveOriginal(plan);
  console.log(`\nPhases, in order: ${plan.phases.map((phase) => phase.id).join(", ")}`);
  console.log(
    review
      ? `Plan review: yes. Append ## Codex Findings (${lib.codexRulesRel} "Plan review"), then run: node .codex/autopilot.js triage ${planRel}`
      : `Plan review: no. Next: node .codex/autopilot.js phase ${planRel} ${plan.phases[0].id}`,
  );
}

function cmdTriage() {
  requireActive();
  triageFindings();
  assertPlanValid(readPlan());
  setStatus({ step: "triaged" });
  log("plan review: triaged");
  console.log(`\nRe-read ${planRel}. Phases, in order: ${readPlan().phases.map((phase) => phase.id).join(", ")}`);
}

function cmdPhase() {
  requireActive();
  const phase = findPhase(phaseArg);
  const phaseBase = snapshot();
  setStatus({ phase: phase.id, step: "implement", attempt: 0, phaseBase });
  log(`--- phase ${phase.id}: ${phase.title} (starting snapshot ${phaseBase.slice(0, 7)})`);
  console.log(`Implement phase ${phase.id}, then run: node .codex/autopilot.js verify ${planRel} ${phase.id}`);
}

function cmdVerify() {
  requireActive();
  const phase = findPhase(phaseArg);
  if (status.phase !== phase.id || !lib.treeExists(repoRoot, status.phaseBase)) {
    throw new Usage(`phase ${phase.id} wasn't started; run \`node .codex/autopilot.js phase ${planRel} ${phase.id}\` first`);
  }
  const gate = runGates(phase);
  if (!gate.ok) {
    setStatus({ step: "gate-failed" });
    console.log(`\nGATE FAILED: ${gate.gate}\n${gate.output}\n\nFix it within the phase's scope, then run verify again.`);
    return exitCodes.gate;
  }
  setStatus({ step: "verify" });
  if (verify(phase, status.phaseBase)) {
    setStatus({ step: "verified" });
    const phases = readPlan().phases;
    const next = phases[phases.findIndex((candidate) => candidate.id === phase.id) + 1];
    console.log(`\nVERDICT: PASS\nNext: node .codex/autopilot.js ${next ? `phase ${planRel} ${next.id}` : `close ${planRel}`}`);
    return 0;
  }
  const attempt = (status.attempt || 0) + 1;
  if (attempt > maxReworks) {
    throw new Stop("stuck", `phase ${phase.id} still needs rework after ${maxReworks} attempts; see .codex/verify/alignment.md`);
  }
  setStatus({ step: "rework", attempt });
  console.log(`\nVERDICT: NEEDS REWORK (rework attempt ${attempt} of ${maxReworks})\n`);
  console.log(readFile(path.join(repoRoot, ".codex", "verify", "alignment.md")));
  console.log("\nFix every MISSING and PARTIAL item, every failing check and every UI audit FAIL, and undo every OUT OF SCOPE change, within the phase's scope. Then run verify again.");
  return exitCodes.rework;
}

async function cmdClose() {
  requireActive();
  await close();
  setStatus({ state: "done", step: "done", phase: "" });
  log(`=== done: ${planRel}. Nothing was committed; review the changes and commit them yourself.`);
  notify(`${slug}: done. Claude is reviewing.`);
  console.log(`\nTask ${slug} done. Claude reviews it next; then review and commit the changes.`);
}

// Unattended fallback: the driver calls `codex exec` for every phase itself.
async function cmdRun() {
  const lockAge = fs.existsSync(lockPath) ? Date.now() - fs.statSync(lockPath).mtimeMs : Infinity;
  if (lockAge < lockTimeoutMs && !flags.has("--force")) {
    console.error(`another autopilot run holds ${path.relative(repoRoot, lockPath)}; pass --force if it's stale`);
    return exitCodes.failed;
  }
  fs.writeFileSync(lockPath, `${process.pid} ${slug}`);

  const previous = status;
  const resuming = flags.has("--resume") && previous.slug === slug && ["stuck", "failed"].includes(previous.state);
  status = resuming ? previous : {};
  setStatus({ slug, plan: planRel, driver: "run", state: "running", reason: "", ...(resuming ? {} : { phase: "", step: "preflight", attempt: 0, phases: {} }) });
  log(`=== autopilot ${resuming ? "resume" : "start"}: ${planRel}`);

  try {
    if (!resuming) {
      const start = snapshot();
      setStatus({ startTree: start });
      if (lib.changedFiles(repoRoot, lib.headTree(repoRoot) || start, start).length) {
        log("note: the working tree already had uncommitted changes; they're part of the starting snapshot and won't be reviewed");
      }
    }
    planReview();
    const phases = readPlan().phases;
    assertPlanValid(readPlan());
    let startIndex = 0;
    if (resuming && previous.step === "close") startIndex = phases.length;
    else if (resuming && previous.phase) startIndex = Math.max(0, phases.findIndex((phase) => phase.id === previous.phase));
    for (let i = startIndex; i < phases.length; i++) {
      runPhase(phases[i], resuming && i === startIndex && previous.phase ? previous : null);
    }
    await close();
    setStatus({ state: "done", step: "done", phase: "" });
    log(`=== done: ${planRel}. Nothing was committed; review the changes and commit them yourself.`);
    notify(`${slug}: done. Review and commit the changes.`);
    return 0;
  } catch (error) {
    if (error instanceof Stop) log(`resume with: node .codex/autopilot.js run ${planRel} --resume`);
    throw error;
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

async function main() {
  if (command === "usage") {
    const slugArg = planArg ? path.basename(planArg, ".md") : "";
    console.log(lib.usageSummary(repoRoot, slugArg));
    return;
  }
  if (!planArg || (["phase", "verify"].includes(command) && !phaseArg)) usage();
  const planPath = path.resolve(planArg);
  planRel = path.relative(repoRoot, planPath).split(path.sep).join("/");
  if (!lib.planPattern.test(planRel) || !fs.existsSync(planPath)) {
    console.error(`not a plan file under ${lib.plansRel}/: ${planArg}`);
    process.exit(exitCodes.failed);
  }
  slug = path.basename(planRel, ".md");

  if (command === "check") {
    process.exit(printChecklist(readPlan()) ? exitCodes.failed : 0);
  }

  fs.mkdirSync(runDir, { recursive: true });
  if (command === "handoff" || command === "wait") {
    process.exitCode = command === "handoff" ? await cmdHandoff() : await cmdWait();
    return;
  }

  logPath = path.join(runDir, `${slug}.log`);
  status = readJson(statusPath) || {};
  const steps = { begin: cmdBegin, triage: cmdTriage, phase: cmdPhase, verify: cmdVerify, close: cmdClose, run: cmdRun };
  try {
    process.exitCode = (await steps[command]()) || 0;
  } catch (error) {
    if (error instanceof Usage) {
      console.error(error.message);
      process.exitCode = exitCodes.failed;
      return;
    }
    const stop = error instanceof Stop ? error : new Stop("failed", error.stack || String(error));
    setStatus({ state: stop.state, reason: stop.message });
    log(`=== ${stop.state}: ${stop.message}`);
    notify(`${slug}: ${stop.state}`);
    console.error(`\n${stop.state.toUpperCase()}: ${stop.message}`);
    process.exitCode = exitCodes[stop.state] || exitCodes.failed;
  }
}

main();
