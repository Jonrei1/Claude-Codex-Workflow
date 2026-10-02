/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Autopilot: run an approved plan end to end from one pasted line.
//
// Codex drives it. The user pastes `Execute plans/<slug>.md` into Codex, and Codex
// (following AGENTS.md "Full plan execution") calls these steps from its own session:
//
//   node .codex/autopilot.js check  plans/<slug>.md       validate only (exit 1 if not runnable)
//   node .codex/autopilot.js begin  plans/<slug>.md       start snapshot, status "running"
//   node .codex/autopilot.js triage plans/<slug>.md       Claude triages ## Codex Findings
//   node .codex/autopilot.js phase  plans/<slug>.md <N>   snapshot the phase's starting tree
//   node .codex/autopilot.js verify plans/<slug>.md <N>   gate, then claude-verify.js --run
//   node .codex/autopilot.js close  plans/<slug>.md       graphify update + Claude task summary
//
// Exit codes: 0 ok / PASS, 1 failed, 2 gate failed (fix and verify again),
// 3 NEEDS REWORK (read .codex/verify/alignment.md, fix, verify again), 4 stuck (stop).
//
// `node .codex/autopilot.js run plans/<slug>.md [--resume] [--force]` is the unattended
// fallback: the driver itself calls `codex exec` per phase, with the same steps.
// `node .codex/autopilot.js plans/<slug>.md [--dry-run]` still means run [check].
//
// Nothing is committed, staged or pushed: every change is left in the working tree for
// the user to review and commit. Phases are tracked with snapshots (workflow-lib.js).
// Progress: .codex/autopilot/status.json and .codex/autopilot/<slug>.log.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("./hooks/workflow-lib");

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const commands = ["check", "begin", "triage", "phase", "verify", "close", "run"];
const command = commands.includes(positional[0]) ? positional.shift() : flags.has("--dry-run") ? "check" : "run";
const [planArg, phaseArg] = positional;
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const runDir = path.join(repoRoot, ".codex", "autopilot");
const statusPath = path.join(runDir, "status.json");
const lockPath = path.join(runDir, "running.lock");
const verifyScript = path.join(repoRoot, ".codex", "hooks", "claude-verify.js");
const verifyStatePath = path.join(repoRoot, ".codex", "verify", "state.json");
const callTimeoutMs = 30 * 60 * 1000;
const lockTimeoutMs = 6 * 60 * 60 * 1000;
const maxReworks = 2;
const exitCodes = { failed: 1, gate: 2, rework: 3, stuck: 4 };
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
  const result = run("codex", ["exec", "-s", "workspace-write", "-C", repoRoot, "-o", lastMessage, "-"], { input: prompt });
  const output = saveOutput(`codex.${name}`, result);
  if (result.error) throw new Stop("failed", `codex ${name} didn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Stop("failed", `codex ${name} exited with ${result.status}; see ${output}`);
  return readFile(lastMessage).trim();
}

function claude(prompt, name, { model, effort, tools }) {
  log(`claude (${model}/${effort}): ${name}`);
  const result = run("claude", ["-p", prompt, "--model", model, "--effort", effort, "--allowedTools", ...tools]);
  const output = saveOutput(`claude.${name}`, result);
  if (result.error) throw new Stop("failed", `claude ${name} didn't run: ${result.error.message}`);
  if (result.status !== 0) throw new Stop("failed", `claude ${name} exited with ${result.status}; see ${output}`);
  return (result.stdout || "").trim();
}

function readPlan() {
  const text = readFile(path.join(repoRoot, planRel));
  return { text, meta: lib.frontmatter(text), phases: lib.parsePhases(text) };
}

function assertPlanValid(plan) {
  const problems = lib.planProblems(slug, plan.meta, plan.phases);
  if (problems.length) throw new Stop("failed", `${planRel} isn't runnable:\n  - ${problems.join("\n  - ")}`);
}

const autopilotRules = `Autopilot run. Follow AGENTS.md "Phase execution", with these changes:
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
  return `Rework phase ${phase.id} of ${planRel}. The alignment review in .codex/verify/alignment.md returned NEEDS REWORK (rework attempt ${attempt} of ${maxReworks}).

Read the review. Fix every MISSING and PARTIAL item, and undo every change listed under OUT OF SCOPE, staying within the phase's scope. If a finding is about code this phase didn't touch, leave that code alone and say so in your reply.

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

function verify(phase, phaseBase) {
  log(`verify: phase ${phase.id}`);
  const result = run(process.execPath, [verifyScript, "--run", "--base", phaseBase, "--plan", planRel, "--phase", phase.id], {
    timeout: 2 * callTimeoutMs,
  });
  if (result.error) throw new Stop("failed", `verification didn't run: ${result.error.message}`);
  const verdict = (readJson(verifyStatePath) || {}).lastVerdict || "none";
  if (verdict === "NOT RUN") throw new Stop("failed", "the Claude verification didn't start; see .codex/verify/last.log");
  log(`verdict: ${verdict} (see .codex/verify/alignment.md)`);
  return verdict === "PASS";
}

function needsPlanReview(plan) {
  return plan.meta.review === "codex" || plan.meta.risk === "high";
}

const origRel = () => `plans/.${slug}.orig.md`;

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
    `Review ${planRel}\n\nFollow AGENTS.md "Plan review". Autopilot run: only append the \`## Codex Findings\` section to the plan. Don't edit anything else, and never commit.`,
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

For each accepted finding, update the plan itself: edit the affected phase's scope, steps or gate, or add an intermediate phase such as "## Phase 2.5: <title>" in the same format as the others (Scope, Steps, and a Gate with a runnable command). Don't renumber existing phases. Don't edit any file except ${planRel}.

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

function close() {
  setStatus({ phase: "", step: "close", attempt: 0 });
  log("--- close");
  if (run("graphify", ["update", "."]).status === 0) log("graphify update . done");
  const summary = `docs/tasks/${localDate()}-${slug}.md`;
  claude(
    `close ${slug}

Autopilot run. Follow "Closing a task" in CLAUDE.md. Write the summary to ${summary}. Don't edit any other file, and never run git commit, git add or git push: the user commits by hand.`,
    "close",
    {
      model: "sonnet",
      effort: "low",
      tools: ["Read", "Grep", "Glob", `Write(${summary})`, `Edit(${summary})`, "Bash(git status:*)", "Bash(git diff:*)"],
    },
  );
  if (!fs.existsSync(path.join(repoRoot, summary))) throw new Stop("failed", `close: ${summary} wasn't written`);
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

function printDryRun(plan, problems) {
  console.log(`Plan: ${planRel} (risk: ${plan.meta.risk || "normal"}, review: ${plan.meta.review || "none"})`);
  for (const phase of plan.phases) {
    console.log(`\nPhase ${phase.id}: ${phase.title}\n  gate: ${phase.gates.join(" && ") || "(none)"}`);
  }
  console.log(`\nPlan review: ${needsPlanReview(plan) ? "yes (Codex reviews, Claude triages)" : "no"}`);
  console.log(problems.length ? `\nNot runnable:\n  - ${problems.join("\n  - ")}` : "\nRunnable.");
}

function usage() {
  console.error(`usage:
  node .codex/autopilot.js check|begin|triage|close plans/<slug>.md
  node .codex/autopilot.js phase|verify plans/<slug>.md <N>
  node .codex/autopilot.js run plans/<slug>.md [--resume] [--force]`);
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

function cmdBegin() {
  const fresh = status.state === "running" && Date.now() - Date.parse(status.updated || 0) < lockTimeoutMs;
  if (fresh && status.slug !== slug && !flags.has("--force")) {
    throw new Usage(`another run (${status.plan}) is still marked running in ${path.relative(repoRoot, statusPath)}; pass --force if it's stale`);
  }
  const plan = readPlan();
  assertPlanValid(plan);
  const start = snapshot();
  status = {};
  setStatus({ slug, plan: planRel, driver: "codex", state: "running", reason: "", phase: "", step: "begin", attempt: 0, startTree: start });
  log(`=== autopilot start (Codex-driven): ${planRel}`);
  if (lib.changedFiles(repoRoot, lib.headTree(repoRoot) || start, start).length) {
    log("note: the working tree already had uncommitted changes; they're part of the starting snapshot and won't be reviewed");
  }
  const review = needsPlanReview(plan) && !plan.text.includes("## Codex Findings");
  if (review) saveOriginal(plan);
  console.log(`\nPhases, in order: ${plan.phases.map((phase) => phase.id).join(", ")}`);
  console.log(
    review
      ? `Plan review: yes. Append ## Codex Findings (AGENTS.md "Plan review"), then run: node .codex/autopilot.js triage ${planRel}`
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
  console.log("\nFix every MISSING and PARTIAL item and undo every OUT OF SCOPE change, within the phase's scope. Then run verify again.");
  return exitCodes.rework;
}

function cmdClose() {
  requireActive();
  close();
  setStatus({ state: "done", step: "done", phase: "" });
  log(`=== done: ${planRel}. Nothing was committed; review the changes and commit them yourself.`);
  notify(`${slug}: done. Review and commit the changes.`);
  console.log(`\nTask ${slug} done. Review and commit the changes.`);
}

// Unattended fallback: the driver calls `codex exec` for every phase itself.
function cmdRun() {
  const lockAge = fs.existsSync(lockPath) ? Date.now() - fs.statSync(lockPath).mtimeMs : Infinity;
  if (lockAge < lockTimeoutMs && !flags.has("--force")) {
    console.error(`another autopilot run holds ${path.relative(repoRoot, lockPath)}; pass --force if it's stale`);
    return exitCodes.failed;
  }
  fs.writeFileSync(lockPath, `${process.pid} ${slug}`);

  const previous = status;
  const resuming = flags.has("--resume") && previous.slug === slug && ["stuck", "failed"].includes(previous.state);
  status = resuming ? previous : {};
  setStatus({ slug, plan: planRel, driver: "run", state: "running", reason: "", ...(resuming ? {} : { phase: "", step: "preflight", attempt: 0 }) });
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
    close();
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

function main() {
  if (!planArg || (["phase", "verify"].includes(command) && !phaseArg)) usage();
  const planPath = path.resolve(planArg);
  planRel = path.relative(repoRoot, planPath).split(path.sep).join("/");
  if (!/^plans\/[^/]+\.md$/.test(planRel) || !fs.existsSync(planPath)) {
    console.error(`not a plan file under plans/: ${planArg}`);
    process.exit(exitCodes.failed);
  }
  slug = path.basename(planRel, ".md");

  if (command === "check") {
    const plan = readPlan();
    const problems = lib.planProblems(slug, plan.meta, plan.phases);
    printDryRun(plan, problems);
    process.exit(problems.length ? exitCodes.failed : 0);
  }

  fs.mkdirSync(runDir, { recursive: true });
  logPath = path.join(runDir, `${slug}.log`);
  status = readJson(statusPath) || {};
  const steps = { begin: cmdBegin, triage: cmdTriage, phase: cmdPhase, verify: cmdVerify, close: cmdClose, run: cmdRun };
  try {
    process.exitCode = steps[command]() || 0;
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
