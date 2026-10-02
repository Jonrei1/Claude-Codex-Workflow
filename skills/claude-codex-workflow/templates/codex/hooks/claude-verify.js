/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Codex Stop hook: when Codex has changed code since the last verified state, hand
// verification to Claude Code in the background, in two steps:
//
//   Step A  checks + mechanical fixes (Sonnet, low effort). Runs the project's checks
//           and fixes only lint, formatting and type errors. Report: .codex/verify/last.log
//   Step B  alignment review, report-only (Sonnet, medium effort; Opus for risky work).
//           Judges the change against its plan phase and ends with a VERDICT line.
//           It has no write tools. Report: .codex/verify/alignment.md
//
// Codex commits once per phase, so "changed" means the committed range since the last
// verified commit plus the working tree. The verified commit only moves forward on
// VERDICT: PASS, so a phase that needs rework is reviewed again on the next run.
//
// Checks come from .codex/verify.json ({ "checks": ["..."] }) when it exists,
// otherwise they are detected from the repo root (Node, Rust, Go, Python). The same
// file's optional "alignment" block sets the Step B model, effort, riskModel and
// riskPaths. `node .codex/hooks/claude-verify.js --print-checks [--root <dir>]` prints
// the resolved setup without starting a run.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const rootFlag = process.argv.indexOf("--root");
const repoRoot =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(__dirname, "..", "..");
const stateDir = path.join(repoRoot, ".codex", "verify");
const lockPath = path.join(stateDir, "running.lock");
const statePath = path.join(stateDir, "state.json");
const logPath = path.join(stateDir, "last.log");
const alignmentPath = path.join(stateDir, "alignment.md");
const plansDir = path.join(repoRoot, "plans");
const isWindows = process.platform === "win32";
const git = isWindows ? "git.exe" : "git";
const lockTimeoutMs = 45 * 60 * 1000;
const phaseSubject = /^phase\(([^)]+)\):\s*([\w.]+)/;

const alignmentDefaults = { model: "sonnet", effort: "medium", riskModel: "opus", riskPaths: [] };

function emitHookResult(systemMessage) {
  const payload = systemMessage ? { systemMessage } : {};
  fs.writeSync(1, JSON.stringify(payload) + "\n");
}

// Changes under these paths never trigger a verification run.
const ignored = [":!plans", ":!.codex", ":!.claude", ":!.impeccable", ":!graphify-out", ":!*.md"];

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

function gitRun(args) {
  return spawnSync(git, args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
}

function gitOut(args) {
  const result = gitRun(args);
  return result.status === 0 ? result.stdout : "";
}

function resolveCommit(ref) {
  if (!ref || ref.startsWith("<")) return "";
  return gitOut(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
}

function isAncestor(sha, of = "HEAD") {
  return Boolean(sha) && gitRun(["merge-base", "--is-ancestor", sha, of]).status === 0;
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

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(\w+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
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

function planInfo(file, phase) {
  return { file, phase, meta: frontmatter(readText(path.join("plans", file))) };
}

// The plan and phase being verified: the newest `phase(<slug>): <N>` commit in the
// range names them; otherwise the most recently edited plan, with the phase inferred.
function activePlan(base, head) {
  const subjects = base && base !== head ? gitOut(["log", "--format=%s", `${base}..${head}`]).split("\n") : [];
  subjects.push(gitOut(["log", "-1", "--format=%s", "HEAD"]));
  for (const subject of subjects) {
    const match = phaseSubject.exec(subject.trim());
    if (match && fs.existsSync(path.join(plansDir, `${match[1]}.md`))) {
      return planInfo(`${match[1]}.md`, match[2]);
    }
  }
  const file = newestPlan();
  return file ? planInfo(file, "infer") : null;
}

// Where the change under review starts: the last verified commit, unless the active
// plan's `base` is newer. On the first run: the plan's base, else the parent of a phase
// commit, else HEAD (only uncommitted changes count).
function resolveBase(state, head) {
  const verified = isAncestor(state.verifiedSha) ? state.verifiedSha : "";
  const plan = activePlan(verified || head, head);
  const planBase = resolveCommit(plan && plan.meta.base);
  const usablePlanBase = isAncestor(planBase) ? planBase : "";
  if (verified && usablePlanBase) return isAncestor(verified, usablePlanBase) ? usablePlanBase : verified;
  if (verified || usablePlanBase) return verified || usablePlanBase;
  if (phaseSubject.test(gitOut(["log", "-1", "--format=%s", "HEAD"]).trim())) {
    return resolveCommit("HEAD~1") || head;
  }
  return head;
}

// Everything that changed between `base` and the working tree, outside ignored paths.
function changes(base) {
  const hash = crypto.createHash("sha256");
  hash.update(base + "\n");
  hash.update(gitOut(["diff", base, "--", ".", ...ignored]));
  const files = new Set(gitOut(["diff", "--name-only", base, "--", ".", ...ignored]).split("\n").filter(Boolean));
  const untracked = gitOut(["ls-files", "--others", "--exclude-standard", "--", ".", ...ignored])
    .split("\n")
    .filter(Boolean);
  for (const file of untracked) {
    files.add(file);
    hash.update(file);
    try {
      hash.update(fs.readFileSync(path.join(repoRoot, file)));
    } catch {
      // File vanished between listing and reading; its name is already hashed.
    }
  }
  return { hash: hash.digest("hex"), files: [...files] };
}

function context() {
  const head = resolveCommit("HEAD");
  const state = readState();
  const base = head ? resolveBase(state, head) : "";
  const { hash, files } = base ? changes(base) : { hash: "", files: [] };
  const plan = base ? activePlan(base, head) : null;
  const config = alignmentConfig();
  let risk = "";
  if (plan && plan.meta.risk === "high") {
    risk = `plan ${plan.file} has risk: high`;
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
  return { head, state, base, hash, files, plan, config, risk };
}

function rangeText(ctx) {
  const committed = ctx.base === ctx.head ? "no new commits" : `\`git diff ${ctx.base}..HEAD\``;
  return `${committed}, plus uncommitted changes (\`git diff\` and \`git status\`)`;
}

function planLabel(ctx) {
  return ctx.plan ? `plans/${ctx.plan.file} (phase ${ctx.plan.phase})` : "(none)";
}

function checksPrompt(checks, ctx) {
  const runStep = checks.length
    ? `2. Run these checks, in order:\n${checks.map((check) => `   - \`${check}\``).join("\n")}`
    : "2. No checks are configured for this repo. Say in the report that no checks ran (add .codex/verify.json to define them).";
  return `Codex just finished a turn in this repo. Run its checks and fix only mechanical failures.
1. The change to check: ${rangeText(ctx)}. Skim it so you know what changed.
${runStep}
3. Fix only lint, formatting and type errors, then re-run the checks until they pass or only
   other failures remain. If a test, build or behavior fails for any other reason, do not fix
   it: report the command and the error. Don't revert Codex's work to make checks pass.
   If a check fails under Bash with a process-start error (such as 0xc0000142 on Windows),
   re-run that check with the PowerShell tool before treating it as a real failure.
4. If the change adds an impeccable live-mode block (\`impeccable-live-start\` markers or a
   localhost live.js script), don't remove it. Report it at the top as "must remove before commit".
5. Don't judge whether the change matches its plan. A separate review step does that.
End with a short report: each check's command and final result, the files you changed, and
the failures you left for rework.`;
}

function alignmentPrompt(ctx, checksReport) {
  const plan = ctx.plan
    ? `- Plan: plans/${ctx.plan.file}\n- Current phase: ${ctx.plan.phase === "infer" ? "not named by a commit; infer it from the plan and the diff" : ctx.plan.phase}`
    : "- Plan: none found in plans/. Review the change on its own and say so.";
  return `You are reviewing a Codex implementation against its plan. Do NOT edit any file.

Inputs:
${plan}
- Diff for this phase: ${rangeText(ctx)}
- Base commit: ${ctx.base}
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
  const tools = ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"];
  for (const check of checks) {
    tools.push(`Bash(${check}:*)`);
    if (isWindows) tools.push(`PowerShell(${check}:*)`);
  }
  return tools;
}

// Step B reads only. Write tools are denied outright, not just left off the allow list.
const alignmentTools = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)"];
const alignmentDenied = ["Edit", "Write", "NotebookEdit", "PowerShell"];

function tail(text, max) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function runVerification() {
  const checks = detectChecks();
  const ctx = context();
  const model = ctx.risk ? ctx.config.riskModel : ctx.config.model;
  const modelLine = `${model} / effort ${ctx.config.effort}${ctx.risk ? ` (risk: ${ctx.risk})` : ""}`;

  const log = fs.openSync(logPath, "w");
  fs.writeSync(log, `Claude verification started ${new Date().toISOString()}\n`);
  fs.writeSync(log, `Range: ${ctx.base.slice(0, 7)}..${ctx.head.slice(0, 7)} + working tree | Plan: ${planLabel(ctx)}\n`);
  fs.writeSync(log, `Step A checks: ${checks.length ? checks.join(" | ") : "(none configured)"}\n`);
  fs.writeSync(log, `Step B alignment: ${modelLine}\n\n`);
  const headerLines = 5;

  const stepA = spawnSync(
    "claude",
    [
      "-p",
      checksPrompt(checks, ctx),
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...checksTools(checks),
    ],
    { cwd: repoRoot, stdio: ["ignore", log, log], windowsHide: true },
  );
  fs.closeSync(log);
  if (stepA.error) {
    fs.appendFileSync(logPath, `\nFailed to start claude: ${stepA.error.message}\n`);
  }

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
      `- Range: ${ctx.base}..${ctx.head} + working tree`,
      `- Verdict: ${verdict || "none (treated as NEEDS REWORK)"}`,
      "",
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(alignmentPath, `${header}${report}\n`);
  }

  // Advance the verified commit only on PASS. Record the post-run state either way, so
  // Claude's own fixes don't trigger another run on the next Stop.
  const passed = verdict === "PASS";
  writeState({
    verifiedSha: passed ? ctx.head : ctx.state.verifiedSha || "",
    fingerprint: changes(passed ? ctx.head : ctx.base).hash,
    lastVerdict: verdict || (stepA.error ? "NOT RUN" : "NEEDS REWORK"),
    lastPlan: planLabel(ctx),
    reported: false,
  });
  fs.appendFileSync(
    logPath,
    `\nFinished ${new Date().toISOString()} (exit ${stepA.status ?? "?"}) | Alignment verdict: ${verdict || "none"}, see ${path.relative(repoRoot, alignmentPath)}\n`,
  );
  // Pre-1.1 state file; state.json replaces it.
  fs.rmSync(path.join(stateDir, "last-verified"), { force: true });
  fs.rmSync(lockPath, { force: true });
}

if (process.argv.includes("--print-checks")) {
  const checks = detectChecks();
  console.log(checks.length ? checks.join("\n") : "(no checks detected; add .codex/verify.json)");
  const ctx = context();
  const { model, effort, riskModel, riskPaths } = ctx.config;
  console.log(`\nAlignment: ${model}/${effort}, risk model ${riskModel}, risk paths: ${riskPaths.join(", ") || "(none)"}`);
  console.log(
    `Range: ${ctx.base ? `${ctx.base.slice(0, 7)}..${ctx.head.slice(0, 7)}` : "(no commits)"} + working tree, ${ctx.files.length} changed file(s)`,
  );
  console.log(`Plan: ${planLabel(ctx)}`);
  console.log(`Risk: ${ctx.risk || "normal"} -> Step B uses ${ctx.risk ? riskModel : model}`);
} else if (process.argv.includes("--run")) {
  runVerification();
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
