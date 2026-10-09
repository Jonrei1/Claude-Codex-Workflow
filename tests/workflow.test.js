"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const skill = path.join(__dirname, "..", "skills", "claude-codex-workflow");
const installer = path.join(skill, "scripts", "install.js");
const lib = require(path.join(skill, "templates", "codex", "hooks", "workflow-lib"));
const isWindows = process.platform === "win32";

function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepo() {
  const dir = tempDir("ccw-workflow-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

function install(dir, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [installer, "--project-only", "--skip-graphify", "--skip-impeccable", "--root", dir, ...extra], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: path.join(dir, "..", `${path.basename(dir)}-codex-home`), ...env },
  });
  return result;
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

// ---- installer: local only, no tracked edits ----

test("setup in a team repo changes no tracked file and leaves git status clean", () => {
  const dir = gitRepo();
  write(dir, "CLAUDE.md", "# Team rules\n");
  write(dir, "AGENTS.md", "# Team agents\n");
  write(dir, ".gitignore", "node_modules/\n");
  write(dir, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [] } }, null, 2));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "team files");

  const first = install(dir);
  assert.strictEqual(first.status, 0, first.stdout + first.stderr);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "", first.stdout);
  assert.strictEqual(read(dir, "CLAUDE.md"), "# Team rules\n");
  assert.strictEqual(read(dir, "AGENTS.md"), "# Team agents\n");
  assert.strictEqual(read(dir, ".gitignore"), "node_modules/\n");

  assert.match(read(dir, "CLAUDE.local.md"), /^## Workflow/m);
  assert.match(read(dir, ".codex/workflow/CODEX.md"), /## Codex execution/);
  assert.ok(fs.existsSync(path.join(dir, ".codex/plans/_template.md")));
  const exclude = read(dir, ".git/info/exclude");
  assert.match(exclude, /# Claude \+ Codex workflow \(local only\)/);
  assert.match(exclude, /^\.codex\/plans\/$/m);
  assert.match(exclude, /^CLAUDE\.local\.md$/m);
  assert.doesNotMatch(exclude, /^\.codex\/hooks\.json$/m, "a tracked hooks.json isn't excluded");

  // The tracked hooks.json stays untouched; the Stop hook goes to the user-level file.
  const userHooks = JSON.parse(fs.readFileSync(path.join(dir, "..", `${path.basename(dir)}-codex-home`, "hooks.json"), "utf8"));
  assert.strictEqual(userHooks.hooks.Stop.length, 1);
  assert.match(userHooks.hooks.Stop[0].hooks[0].command, /claude-verify\.js/);
  assert.ok(!userHooks.hooks.PreToolUse, "graphify guards stay project-level");

  const settings = JSON.parse(read(dir, ".claude/settings.local.json"));
  assert.strictEqual(settings.hooks.PostToolUse[0].matcher, "ExitPlanMode");

  // Re-running changes nothing.
  const files = ["CLAUDE.local.md", ".git/info/exclude", ".claude/settings.local.json", ".codex/workflow/CODEX.md"].map((rel) => read(dir, rel));
  const second = install(dir);
  assert.strictEqual(second.status, 0, second.stdout + second.stderr);
  assert.deepStrictEqual(["CLAUDE.local.md", ".git/info/exclude", ".claude/settings.local.json", ".codex/workflow/CODEX.md"].map((rel) => read(dir, rel)), files);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
});

test("setup in a fresh repo creates and hides its own .codex/hooks.json", () => {
  const dir = gitRepo();
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(read(dir, ".git/info/exclude"), /^\.codex\/hooks\.json$/m);
  const hooks = JSON.parse(read(dir, ".codex/hooks.json"));
  assert.ok(hooks.hooks.Stop && hooks.hooks.PreToolUse);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.ok(!fs.existsSync(path.join(dir, ".gitignore")));
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.md")));
});

test("an older workflow Stop hook is upgraded in place, not duplicated", () => {
  const dir = gitRepo();
  const old = "node -e \"const cp=require('node:child_process');const path=require('node:path');const root=cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();require(path.join(root,'.codex','hooks','claude-verify.js'))\"";
  write(dir, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: old }] }] } }));
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const stop = JSON.parse(read(dir, ".codex/hooks.json")).hooks.Stop;
  assert.strictEqual(stop.length, 1);
  assert.match(stop[0].hooks[0].command, /existsSync/);
});

test("untracked plans from the old plans/ folder move to .codex/plans/", () => {
  const dir = gitRepo();
  write(dir, "plans/old-task.md", "---\ntask: old-task\n---\n");
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(dir, ".codex/plans/old-task.md")));
  assert.ok(!fs.existsSync(path.join(dir, "plans/old-task.md")));
});

test("--shared keeps the team-wide layout in CLAUDE.md, AGENTS.md and .gitignore", () => {
  const dir = gitRepo();
  const result = install(dir, ["--shared"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(read(dir, "CLAUDE.md"), /^## Workflow/m);
  assert.match(read(dir, "AGENTS.md"), /^## Codex execution/m);
  assert.match(read(dir, ".gitignore"), /^\.codex\/plans\/\*$/m);
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.local.md")));
});

// ---- planning checklist ----

const goodPlan = `---
task: add-badge
risk: normal
review: none
ui: yes
---

# Add a badge

## Acceptance
- A1: badge renders on the profile page
- A2: badge count comes from the API

## UI audit
- Start: \`node --version\`
- URL: http://localhost:3999/profile
- Viewports: 375, 1280
- Checks:
  - the badge is visible next to the name

## Phase 1: API
**Scope:** src/api/badge.js
**Steps:**
1. Add the endpoint.
**Covers:** A2
**Done when:** GET /badge returns { count }.
**Hands off:** \`getBadge()\` in src/api/badge.js returning { count: number }.
**Gate (must pass):**
- \`node --version\`

## Phase 2: UI
**Scope:** src/ui/Badge.jsx
**Steps:**
1. Render the badge.
**Covers:** A1
**Done when:** the badge shows the count.
**UI audit:** the badge sits right of the name at both widths.
**Gate (must pass):**
- \`node --version\`
`;

function planRepo(text, pkg) {
  const dir = gitRepo();
  if (pkg) write(dir, "package.json", JSON.stringify(pkg));
  write(dir, ".codex/plans/add-badge.md", text);
  return dir;
}

test("a complete plan passes every checklist item", () => {
  const dir = planRepo(goodPlan);
  const failed = lib.planChecklist(dir, "add-badge", goodPlan).filter((item) => !item.ok);
  assert.deepStrictEqual(failed, []);
});

test("the checklist catches uncovered acceptance, missing handoff, missing scripts and UI gaps", () => {
  const text = goodPlan
    .replace("**Covers:** A1", "**Covers:** A3")
    .replace(/\*\*Hands off:\*\*.*\n/, "")
    .replace("- `node --version`\n\n## Phase 2", "- `npm run nope`\n\n## Phase 2")
    .replace(/## UI audit[\s\S]*?(?=## Phase 1)/, "");
  const dir = planRepo(text, { scripts: { test: "node --test" } });
  const problems = lib.planProblems(dir, "add-badge", text).join("\n");
  assert.match(problems, /every acceptance item is covered by a phase: A1/);
  assert.match(problems, /every \*\*Covers:\*\* id exists under Acceptance: A3/);
  assert.match(problems, /Phase 1: \*\*Hands off:\*\*/);
  assert.match(problems, /no "nope" script in package\.json/);
  assert.match(problems, /ui: yes has a `## UI audit` section/);
});

test("gates must be runnable: unknown programs are reported", () => {
  const dir = gitRepo();
  assert.match(lib.gateProblem(dir, "definitely-not-a-real-tool-xyz --check"), /isn't on PATH/);
  assert.strictEqual(lib.gateProblem(dir, "node --version && git --version"), "");
});

// ---- Codex session discovery ----

// A thread as the Codex app-server's thread/read returns it.
function liveThread(id, cwd, extra = {}) {
  return { id, cwd, source: "vscode", status: { type: "idle" }, threadSource: "user", ephemeral: false, parentThreadId: null, createdAt: 1000, updatedAt: 1000, ...extra };
}

test("pickCodexSession picks the newest of the user's own sessions in the repo", () => {
  const repo = tempDir("ccw-repo-");
  const threads = [
    liveThread("old-match", repo, { updatedAt: 1000 }),
    liveThread("new-match", isWindows ? `\\\\?\\${repo.toUpperCase()}` : repo, { updatedAt: 3000 }),
    liveThread("other-repo", path.join(repo, "..", "elsewhere"), { updatedAt: 9000 }),
    liveThread("headless", repo, { source: "exec", updatedAt: 9000 }),
    liveThread("subagent", repo, { parentThreadId: "new-match", updatedAt: 9000 }),
    liveThread("title", repo, { ephemeral: true, threadSource: "thread_title", updatedAt: 9000 }),
  ];
  const { session, others } = lib.pickCodexSession(threads, repo);
  assert.strictEqual(session.id, "new-match");
  assert.strictEqual(session.status, "idle");
  assert.deepStrictEqual(others.map((other) => other.id), ["old-match"]);
  assert.strictEqual(lib.pickCodexSession(threads, path.join(repo, "..", "nowhere")).session, null);
});

test("WebSocket frames round-trip at every length encoding", () => {
  for (const size of [5, 300, 70000]) {
    const text = "x".repeat(size);
    for (const mask of [true, false]) {
      const frame = lib.encodeFrame(text, { mask });
      const { frames, rest } = lib.decodeFrames(Buffer.concat([frame, frame.subarray(0, 1)]));
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].text, text);
      assert.strictEqual(rest.length, 1);
    }
  }
});

// ---- autopilot handoff and wait ----

function workflowRepo() {
  const dir = gitRepo();
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  write(dir, ".codex/plans/add-badge.md", goodPlan);
  return dir;
}

function autopilot(dir, args, env = {}) {
  return spawnSync(process.execPath, [path.join(dir, ".codex", "autopilot.js"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

test("handoff refuses a plan that fails the checklist", () => {
  const dir = workflowRepo();
  write(dir, ".codex/plans/add-badge.md", goodPlan.replace("**Covers:** A1", ""));
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--print"]);
  assert.strictEqual(result.status, 1, result.stdout);
  assert.match(result.stdout, /Not handed off/);
});

test("handoff --print exits 5 with the paste line", () => {
  const dir = workflowRepo();
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--print"]);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /Execute \.codex\/plans\/add-badge\.md\. Follow \.codex\/workflow\/CODEX\.md, section Full plan execution\./);
});

// A codex stand-in (tests/fixtures/fake-codex.js) on PATH. Its app-server serves the threads
// in threadsFile; `queue` records its arguments in argsFile.
function fakeCodex({ threads, queueCode = 0, proxyCode = 0 } = {}) {
  const bin = tempDir("ccw-bin-");
  const config = { threadsFile: path.join(bin, "threads.json"), argsFile: path.join(bin, "args.txt"), queueCode, proxyCode };
  fs.writeFileSync(path.join(bin, "config.json"), JSON.stringify(config));
  if (threads) fs.writeFileSync(config.threadsFile, JSON.stringify(threads));
  const script = path.join(__dirname, "fixtures", "fake-codex.js");
  if (isWindows) fs.writeFileSync(path.join(bin, "codex.cmd"), `@"${process.execPath}" "${script}" "${path.join(bin, "config.json")}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "${path.join(bin, "config.json")}" "$@"\n`);
    fs.chmodSync(path.join(bin, "codex"), 0o755);
  }
  return { ...config, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

const liveId = "11111111-2222-3333-4444-555555555555";

test("handoff sends the plan to the Codex session open in the repo, and names it", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, dir), liveThread("title-thread", dir, { ephemeral: true, threadSource: "thread_title", updatedAt: 5000 })] });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md"], codex.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(codex.argsFile, "utf8"), new RegExp(`queue --thread ${liveId} --message "?Execute \\.codex/plans/add-badge\\.md`));
  assert.match(result.stdout, new RegExp(`Sent to Codex session ${liveId} \\(vscode, idle\\) in `));
  const handoff = JSON.parse(read(dir, ".codex/autopilot/handoff.json"));
  assert.strictEqual(handoff.via, "codex queue");
  assert.strictEqual(handoff.thread, liveId);
  assert.strictEqual(handoff.source, "vscode");
});

test("handoff with no Codex session open prints the paste line instead of opening a terminal", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, path.join(dir, "..", "elsewhere"))] });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--wait", "0"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /No Codex session is open in this repo\./);
  assert.match(result.stdout, /Paste this into Codex:\s+Execute \.codex\/plans\/add-badge\.md/);
  assert.ok(!fs.existsSync(codex.argsFile), "nothing should be queued");
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "print");
});

test("handoff waits for Codex to be started in the repo, then sends the plan to it", async () => {
  const dir = workflowRepo();
  const codex = fakeCodex();
  const child = spawn(process.execPath, [path.join(dir, ".codex", "autopilot.js"), "handoff", ".codex/plans/add-badge.md", "--wait", "30"], {
    cwd: dir,
    env: { ...process.env, ...codex.env },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stdout += chunk));
  setTimeout(() => fs.writeFileSync(codex.threadsFile, JSON.stringify([liveThread(liveId, dir)])), 1000);
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.strictEqual(status, 0, stdout);
  assert.match(stdout, /Start Codex in a terminal here/);
  assert.match(fs.readFileSync(codex.argsFile, "utf8"), new RegExp(`queue --thread ${liveId}`));
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "codex queue");
});

test("handoff prints the paste line when codex queue fails", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, dir)], queueCode: 1 });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`codex queue to ${liveId} failed`));
  assert.match(result.stdout, /Paste this into Codex:/);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "print");
});

test("handoff explains an unreachable Codex app-server and prints the paste line", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ proxyCode: 1 });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--wait", "0"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /Couldn't ask the Codex app-server for open sessions: codex app-server proxy exited with 1/);
  assert.match(result.stdout, /Paste this into Codex:/);
  assert.ok(!fs.existsSync(codex.argsFile), "nothing should be queued");
});

test("wait returns when the run is done, with a summary, and 4 when it's stuck", () => {
  const dir = workflowRepo();
  const since = new Date(Date.now() - 1000).toISOString();
  const status = (state) =>
    write(dir, ".codex/autopilot/status.json", JSON.stringify({ slug: "add-badge", state, reason: state === "stuck" ? "phase 2 still needs rework" : "", updated: new Date().toISOString(), phases: { 1: { verdict: "PASS", alignment: "PASS", checks: "pass", ui: "not run" } } }));
  status("done");
  let result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Run add-badge: DONE/);
  assert.match(result.stdout, /Phase 1 \(API\): PASS/);
  assert.match(result.stdout, /final UI audit/);
  status("stuck");
  result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /handoff \.codex\/plans\/add-badge\.md --continue/);
});

// ---- verification runs its steps in parallel ----

test("verify runs the checks fix step and the alignment review at the same time, and keeps per-task reports", () => {
  const dir = workflowRepo();
  write(dir, ".codex/verify.json", JSON.stringify({ checks: ['node -e "process.exit(1)"'] }));
  write(dir, "src/api/badge.js", "module.exports = 1;\n");
  const bin = tempDir("ccw-claude-");
  const times = path.join(bin, "times.jsonl");
  const fake = path.join(bin, "fake-claude.js");
  fs.writeFileSync(
    fake,
    `const fs = require("fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const name = /VERDICT: PASS/.test(prompt) ? "alignment" : /UI AUDIT/.test(prompt) ? "ui" : "fix";
const start = Date.now();
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(times)}, JSON.stringify({ name, start, end: Date.now() }) + "\\n");
  process.stdout.write(JSON.stringify({ result: name === "alignment" ? "DONE: all\\nVERDICT: PASS" : "fixed nothing" }));
}, 1500);
`,
  );
  // Shaped like npm's shim, which workflow-lib resolves to `node <script>` on Windows.
  if (isWindows) fs.writeFileSync(path.join(bin, "claude.cmd"), `@node "%dp0%\\fake-claude.js" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(path.join(bin, "claude"), 0o755);
  }
  const base = lib.headTree(dir) || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const result = spawnSync(process.execPath, [path.join(dir, ".codex/hooks/claude-verify.js"), "--run", "--base", base, "--plan", ".codex/plans/add-badge.md", "--phase", "1", "--gate", "passed"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);

  const calls = fs.readFileSync(times, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const fix = calls.find((call) => call.name === "fix");
  const alignment = calls.find((call) => call.name === "alignment");
  assert.ok(fix && alignment, JSON.stringify(calls));
  assert.ok(fix.start < alignment.end && alignment.start < fix.end, `steps didn't overlap: ${JSON.stringify(calls)}`);

  const state = JSON.parse(read(dir, ".codex/verify/state.json"));
  assert.strictEqual(state.lastAlignment, "PASS");
  assert.strictEqual(state.lastChecks, "fail");
  assert.strictEqual(state.lastVerdict, "NEEDS REWORK", "failing checks fail the phase even when alignment passes");
  for (const file of ["phase-1.alignment.md", "phase-1.checks.log", "phase-1.diff"]) {
    assert.ok(fs.existsSync(path.join(dir, ".codex/verify/add-badge", file)), file);
  }
  assert.match(read(dir, ".codex/verify/alignment.md"), /Checks that still fail/);
  // Only the app change shows up; every workflow file is hidden through .git/info/exclude.
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "?? src/api/badge.js");
});
