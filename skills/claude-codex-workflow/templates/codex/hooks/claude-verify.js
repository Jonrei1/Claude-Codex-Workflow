/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Codex Stop hook: when the working tree changed since the last verified snapshot, hand
// verification to Claude Code in the background, in two steps:
//
//   Step A  checks + mechanical fixes (Sonnet, low effort). Runs the project's checks
//           and fixes only lint, formatting and type errors. Report: .codex/verify/last.log
//   Step B  alignment review, report-only (Sonnet, medium effort; Opus for risky work).
//           Judges the change against its plan phase and ends with a VERDICT line.
//           It has no write tools. Report: .codex/verify/alignment.md
//
// Nobody but the user commits, so progress is tracked with snapshots (see workflow-lib.js).
// The change under review is the diff from the last verified snapshot to the current
// working tree, written to .codex/verify/phase.diff. The verified snapshot only moves
// forward on VERDICT: PASS, so a phase that needs rework is reviewed again next time.
// When the user commits, HEAD becomes the new starting point.
//
// The plan and phase come from .codex/verify/phase.json ({ "plan": "plans/x.md",
// "phase": "2" }, written by Codex after a phase), else the newest plan in plans/.
//
// Checks come from .codex/verify.json ({ "checks": ["..."] }) when it exists,
// otherwise they are detected from the repo root (Node, Rust, Go, Python). The same
// file's optional "alignment" block sets the Step B model, effort, riskModel and
// riskPaths. `node .codex/hooks/claude-verify.js --print-checks [--root <dir>]` prints
// the resolved setup without starting a run. `--run [--base <tree>] [--plan <path>]
// [--phase <id>]` verifies synchronously; .codex/autopilot.js uses it after each phase.
// Under autopilot (CODEX_AUTOPILOT=1, or .codex/autopilot/status.json says "running")
// the Stop hook itself does nothing.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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
const plansDir = path.join(repoRoot, "plans");
const isWindows = process.platform === "win32";
const lockTimeoutMs = 45 * 60 * 1000;
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

function nodeChecks() {
  const pkg = readJson("package.json");
  if (!pkg) return [];
  const scripts = pkg.scripts || {};
  const pm = exists("pnpm-lock.yaml")
    ? "pnpm"
    : exists("yarn.lock")
      ? "yarn"
      : exists("bun.lock") || exists("bun.lockb")
        ? "bun"
        : "npm";
  const run = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" }[pm];
  const exec = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm];

  const checks = [];
  if (scripts.typecheck) checks.push(`${run} typecheck`);
  else if (exists("tsconfig.json")) checks.push(`${exec} tsc --noEmit`);
  if (scripts.lint) checks.push(`${run} lint`);
  if (scripts.build) checks.push(`${run} build`);
  const test = scripts.test || "";
  if (test && !test.includes("no test specified") && !test.includes("watch")) {
    checks.push(`${run} test`);
  }
  return checks;
}

function pythonChecks() {
  const hasPython =
    exists("pyproject.toml") ||
    exists("setup.cfg") ||
    fs.readdirSync(repoRoot).some((file) => /^requirements.*\.txt$/.test(file));
  if (!hasPython) return [];
  const pyproject = readText("pyproject.toml");
  const checks = [];
  if (pyproject.includes("[tool.ruff") || exists("ruff.toml") || exists(".ruff.toml")) {
    checks.push("ruff check .");
  }
  if (pyproject.includes("[tool.mypy") || exists("mypy.ini")) checks.push("mypy .");
  if (pyproject.includes("[tool.pytest") || exists("pytest.ini") || exists("tests")) {
    checks.push("pytest -q");
  }
  return checks;
}

function detectChecks() {
  const override = readJson(path.join(".codex", "verify.json"));
  if (override && Array.isArray(override.checks)) {
    return override.checks.filter((check) => typeof check === "string" && check.trim());
  }
  return [
    ...nodeChecks(),
    ...(exists("Cargo.toml") ? ["cargo check", "cargo test"] : []),
    ...(exists("go.mod") ? ["go vet ./...", "go build ./...", "go test ./..."] : []),
    ...pythonChecks(),
  ];
}

function alignmentConfig() {
  const override = readJson(path.join(".codex", "verify.json"));
  const config = { ...alignmentDefaults, ...((override && override.alignment) || {}) };
  config.riskPaths = Array.isArray(config.riskPaths) ? config.riskPaths : [];
  return config;
}

// Minimal glob support for riskPaths: `**` (any depth), `*` and `?` (within a segment).
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
// (`Execute plans/<task>.md`) that stopped as stuck or failed is resumed by rerunning
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
  return { rel, phase: phase || "infer", meta: lib.frontmatter(readText(rel)) };
}

// The plan and phase under review: explicit flags, then Codex's phase marker, then the
// most recently edited plan with the phase inferred.
function activePlan() {
  if (flagValue("--plan")) return planInfo(flagValue("--plan"), flagValue("--phase"));
  const marker = readJson(path.join(".codex", "verify", "phase.json"));
  if (marker && typeof marker.plan === "string" && exists(marker.plan)) return planInfo(marker.plan, String(marker.phase || ""));
  const file = newestPlan();
  return file ? planInfo(`plans/${file}`, "") : null;
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
  return { head, state, base, current, files, hash: `${base.tree}:${current}`, plan, config, risk };
}

function writeDiff(base, current) {
  fs.writeFileSync(diffPath, lib.diffText(repoRoot, base, current) || "(no changes outside workflow paths)\n");
}

const diffNote = `The change is in ${diffRel}: a diff from the last verified snapshot to the current working tree, new files included and workflow paths (plans/, .codex/, .claude/, .impeccable/, graphify-out/) left out. Read all of it. Nothing is committed during the workflow, so don't look for commits.`;

function planLabel(ctx) {
  return ctx.plan ? `${ctx.plan.rel} (phase ${ctx.plan.phase})` : "(none)";
}

function checksPrompt(checks) {
  const runStep = checks.length
    ? `2. Run these checks, in order:\n${checks.map((check) => `   - \`${check}\``).join("\n")}`
    : "2. No checks are configured for this repo. Say in the report that no checks ran (add .codex/verify.json to define them).";
  return `Codex just finished a turn in this repo. Run its checks and fix only mechanical failures.
1. ${diffNote} Skim it so you know what changed.
${runStep}
3. Fix only lint, formatting and type errors, then re-run the checks until they pass or only
   other failures remain. If a test, build or behavior fails for any other reason, do not fix
   it: report the command and the error. Don't revert Codex's work to make checks pass.
   If a check fails under Bash with a process-start error (such as 0xc0000142 on Windows),
   re-run that check with the PowerShell tool before treating it as a real failure.
4. If the change adds an impeccable live-mode block (\`impeccable-live-start\` markers or a
   localhost live.js script), don't remove it. Report it at the top as "must remove before commit".
5. Don't judge whether the change matches its plan. A separate review step does that.
6. Never run git commit, git add or git push. The user commits by hand.
End with a short report: each check's command and final result, the files you changed, and
the failures you left for rework.`;
}

function alignmentPrompt(ctx, checksReport) {
  const plan = ctx.plan
    ? `- Plan: ${ctx.plan.rel}\n- Current phase: ${ctx.plan.phase === "infer" ? "not named; infer it from the plan and the diff" : ctx.plan.phase}`
    : "- Plan: none found in plans/. Review the change on its own and say so.";
  return `You are reviewing a Codex implementation against its plan. Do NOT edit any file.

Inputs:
${plan}
- Diff for this phase: ${diffNote}
- Report from the checks step that just ran (it may have fixed lint or type errors):
"""
${checksReport || "(no report)"}
"""

For the current phase, report:
1. DONE: acceptance items clearly satisfied, with file:line evidence.
2. PARTIAL: items started but incomplete.
3. MISSING: items in the plan with no evidence in the diff.
4. OUT OF SCOPE: changed files or behavior the plan did not ask for.
5. GATE: did the phase's test gate pass? Quote the command and result.
6. RISKS: contract mismatches (API shape vs frontend types), migrations, auth changes.

Judge from the diff and the files, not from Codex's own summary.
End with exactly one line: VERDICT: PASS | NEEDS REWORK`;
}

function checksTools(checks) {
  const tools = ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)"];
  for (const check of checks) {
    tools.push(`Bash(${check}:*)`);
    if (isWindows) tools.push(`PowerShell(${check}:*)`);
  }
  return tools;
}

// Step B reads only. Write tools are denied outright, not just left off the allow list.
const alignmentTools = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)"];
const alignmentDenied = ["Edit", "Write", "NotebookEdit", "PowerShell"];

function tail(text, max) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function runVerification() {
  fs.mkdirSync(stateDir, { recursive: true });
  const checks = detectChecks();
  const ctx = context();
  const model = ctx.risk ? ctx.config.riskModel : ctx.config.model;
  const modelLine = `${model} / effort ${ctx.config.effort}${ctx.risk ? ` (risk: ${ctx.risk})` : ""}`;
  const range = `${ctx.base.tree.slice(0, 7)} (${ctx.base.from}) -> working tree`;
  writeDiff(ctx.base.tree, ctx.current);

  const log = fs.openSync(logPath, "w");
  fs.writeSync(log, `Claude verification started ${new Date().toISOString()}\n`);
  fs.writeSync(log, `Range: ${range} | Plan: ${planLabel(ctx)}\n`);
  fs.writeSync(log, `Step A checks: ${checks.length ? checks.join(" | ") : "(none configured)"}\n`);
  fs.writeSync(log, `Step B alignment: ${modelLine}\n\n`);
  const headerLines = 5;

  const stepA = spawnSync(
    "claude",
    ["-p", checksPrompt(checks), "--model", "sonnet", "--effort", "low", "--permission-mode", "acceptEdits", "--allowedTools", ...checksTools(checks)],
    { cwd: repoRoot, stdio: ["ignore", log, log], windowsHide: true },
  );
  fs.closeSync(log);
  if (stepA.error) {
    fs.appendFileSync(logPath, `\nFailed to start claude: ${stepA.error.message}\n`);
  }

  // Step B reviews the tree as Step A left it.
  const reviewed = lib.snapshot(repoRoot);
  writeDiff(ctx.base.tree, reviewed);

  let verdict = "";
  if (!stepA.error) {
    const checksReport = tail(readFile(logPath).split("\n").slice(headerLines).join("\n"), 3000);
    const stepB = spawnSync(
      "claude",
      [
        "-p",
        alignmentPrompt(ctx, checksReport),
        "--model",
        model,
        "--effort",
        ctx.config.effort,
        "--allowedTools",
        ...alignmentTools,
        "--disallowedTools",
        ...alignmentDenied,
      ],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    const report =
      (stepB.stdout || "").trim() ||
      (stepB.error ? `Failed to start claude: ${stepB.error.message}` : (stepB.stderr || "").trim());
    const verdicts = [...report.matchAll(/^[\s*_`>]*VERDICT:\s*(PASS|NEEDS REWORK)/gim)];
    verdict = verdicts.length ? verdicts[verdicts.length - 1][1].toUpperCase() : "";
    const header = [
      "# Alignment review",
      "",
      `- Run: ${new Date().toISOString()}`,
      `- Model: ${modelLine}`,
      `- Plan: ${planLabel(ctx)}`,
      `- Range: ${ctx.base.tree} (${ctx.base.from}) -> ${reviewed} (working tree)`,
      `- Verdict: ${verdict || "none (treated as NEEDS REWORK)"}`,
      "",
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(alignmentPath, `${header}${report}\n`);
  }

  // Advance the verified snapshot only on PASS; otherwise keep this run's base, so the same
  // phase is reviewed again. Record the post-run state either way, so Claude's own fixes
  // don't trigger another run on the next Stop.
  const passed = verdict === "PASS";
  const nextBase = passed ? reviewed : ctx.base.tree;
  writeState({
    verifiedTree: nextBase,
    verifiedHead: ctx.head,
    fingerprint: `${nextBase}:${reviewed}`,
    lastVerdict: verdict || (stepA.error ? "NOT RUN" : "NEEDS REWORK"),
    lastPlan: planLabel(ctx),
    reported: false,
  });
  fs.appendFileSync(
    logPath,
    `\nFinished ${new Date().toISOString()} (exit ${stepA.status ?? "?"}) | Alignment verdict: ${verdict || "none"}, see ${path.relative(repoRoot, alignmentPath)}\n`,
  );
  fs.rmSync(lockPath, { force: true });
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
} else if (process.argv.includes("--run")) {
  runVerification();
  emitHookResult();
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
