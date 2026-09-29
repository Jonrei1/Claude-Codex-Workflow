/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Codex Stop hook: when Codex has changed code since the last verified state, hand
// verification to Claude Code in the background. Claude runs the project's checks
// and fixes any failures directly. Output goes to .codex/verify/last.log.
// Runs on Sonnet at low effort: the checks are mostly mechanical, so this keeps
// each run fast and cheap.
//
// Checks come from .codex/verify.json ({ "checks": ["..."] }) when it exists,
// otherwise they are detected from the repo root (Node, Rust, Go, Python).
// `node .codex/hooks/claude-verify.js --print-checks [--root <dir>]` prints the
// resolved list without starting a run.

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
const fingerprintPath = path.join(stateDir, "last-verified");
const logPath = path.join(stateDir, "last.log");
const isWindows = process.platform === "win32";
const git = isWindows ? "git.exe" : "git";

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

function buildPrompt(checks) {
  const runStep = checks.length
    ? `2. Run these checks, in order:\n${checks.map((check) => `   - \`${check}\``).join("\n")}`
    : "2. No checks are configured for this repo. Review the diff only, and say in the report that no checks ran (add .codex/verify.json to define them).";
  return `Codex just finished a turn in this repo. Verify and fix its work:
1. Review the uncommitted diff. If it implements a plan in plans/, check it against that plan.
${runStep}
3. Fix every failure directly (type errors, lint errors, build or test failures, small plan drift),
   then re-run the checks until they all pass. Don't revert Codex's work to make checks pass.
   If a check fails under Bash with a process-start error (such as 0xc0000142 on Windows),
   re-run that check with the PowerShell tool before treating it as a real failure.
4. If the diff adds an impeccable live-mode block (\`impeccable-live-start\` markers or a
   localhost live.js script), don't remove it. Report it at the top as "must remove before commit".
5. If something needs larger rework than a targeted fix, stop and describe it instead.
End with a short report: each check's final result, the files you changed, and anything left open.`;
}

function allowedTools(checks) {
  const tools = ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)"];
  for (const check of checks) {
    tools.push(`Bash(${check}:*)`);
    if (isWindows) tools.push(`PowerShell(${check}:*)`);
  }
  return tools;
}

function gitOut(args) {
  const result = spawnSync(git, args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : "";
}

function fingerprint() {
  const hash = crypto.createHash("sha256");
  const diff = gitOut(["diff", "HEAD", "--", ".", ...ignored]);
  hash.update(diff);
  const untracked = gitOut(["ls-files", "--others", "--exclude-standard", "--", ".", ...ignored])
    .split("\n")
    .filter(Boolean);
  for (const file of untracked) {
    hash.update(file);
    try {
      hash.update(fs.readFileSync(path.join(repoRoot, file)));
    } catch {
      // File vanished between listing and reading; its name is already hashed.
    }
  }
  return { hash: hash.digest("hex"), empty: diff === "" && untracked.length === 0 };
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function runVerification() {
  const checks = detectChecks();
  const log = fs.openSync(logPath, "w");
  fs.writeSync(log, `Claude verification started ${new Date().toISOString()}\n`);
  fs.writeSync(log, `Checks: ${checks.length ? checks.join(" | ") : "(none configured)"}\n\n`);
  const result = spawnSync(
    "claude",
    [
      "-p",
      buildPrompt(checks),
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...allowedTools(checks),
    ],
    { cwd: repoRoot, stdio: ["ignore", log, log], windowsHide: true },
  );
  if (result.error) {
    fs.writeSync(log, `\nFailed to start claude: ${result.error.message}\n`);
  }
  fs.writeSync(log, `\nFinished ${new Date().toISOString()} (exit ${result.status ?? "?"})\n`);
  fs.closeSync(log);
  // Record the post-fix state so Claude's own edits don't trigger another run.
  fs.writeFileSync(fingerprintPath, fingerprint().hash);
  fs.rmSync(lockPath, { force: true });
}

if (process.argv.includes("--print-checks")) {
  const checks = detectChecks();
  console.log(checks.length ? checks.join("\n") : "(no checks detected; add .codex/verify.json)");
} else if (process.argv.includes("--run")) {
  runVerification();
  emitHookResult();
} else {
  fs.mkdirSync(stateDir, { recursive: true });
  const current = fingerprint();
  const lockAgeMs = fs.existsSync(lockPath) ? Date.now() - fs.statSync(lockPath).mtimeMs : Infinity;

  if (current.empty || current.hash === readFile(fingerprintPath) || lockAgeMs < 30 * 60 * 1000) {
    emitHookResult();
    process.exit(0);
  }

  fs.writeFileSync(lockPath, String(Date.now()));
  spawn(process.execPath, [__filename, "--run"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  emitHookResult(`Claude verification started in the background; see ${path.relative(repoRoot, logPath)}`);
}
