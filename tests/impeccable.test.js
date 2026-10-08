"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installer = path.join(__dirname, "..", "skills", "claude-codex-workflow", "scripts", "install.js");

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-impeccable-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// A dry run with no terminal attached (stdin is ignored), like a headless Claude command.
function dryRun(extra) {
  const dir = gitRepo();
  const result = spawnSync(process.execPath, [installer, "--project-only", "--dry-run", "--skip-graphify", "--root", dir, ...extra], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test("Impeccable is not installed by default and the user is pointed at --impeccable", () => {
  const out = dryRun([]);
  assert.match(out, /impeccable install: skipped \(optional; re-run with --impeccable to add it\)/);
  assert.doesNotMatch(out, /npx -y impeccable/);
  assert.match(out, /Impeccable \(design skills, optional\) wasn't installed/);
});

test("--yes approves tools but does not install Impeccable", () => {
  const out = dryRun(["--yes"]);
  assert.match(out, /impeccable install: skipped \(optional/);
  assert.doesNotMatch(out, /npx -y impeccable/);
});

test("--impeccable installs it for both agents", () => {
  const out = dryRun(["--impeccable"]);
  assert.match(out, /would run `npx -y impeccable install --project --providers=claude,codex`/);
  assert.match(out, /\/impeccable init in Claude Code writes PRODUCT\.md/);
});

test("--impeccable-providers implies --impeccable", () => {
  const out = dryRun(["--impeccable-providers=codex"]);
  assert.match(out, /would run `npx -y impeccable install --project --providers=codex`/);
});

test("--skip-impeccable wins and says so", () => {
  const out = dryRun(["--skip-impeccable", "--impeccable"]);
  assert.match(out, /impeccable install: skipped \(--skip-impeccable\)/);
  assert.doesNotMatch(out, /npx -y impeccable/);
});

test("workflow instructions treat Impeccable as optional", () => {
  const templates = path.join(__dirname, "..", "skills", "claude-codex-workflow", "templates");
  const claude = fs.readFileSync(path.join(templates, "CLAUDE.workflow.md"), "utf8");
  const agents = fs.readFileSync(path.join(templates, "AGENTS.codex.md"), "utf8");
  assert.match(claude, /Impeccable is optional/);
  assert.match(agents, /If the impeccable skill is installed/);
});

test("setup repairs existing Impeccable Windows hooks and preserves other hooks on rerun", () => {
  const dir = gitRepo();
  const file = path.join(dir, ".codex", "hooks.json");
  const command = 'sh .agents/skills/impeccable/scripts/impeccable hook';
  const unrelated = { type: "command", command: "echo custom", commandWindows: "echo windows" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [
    { type: "command", command, commandWindows: '.agents\\skills\\impeccable\\scripts\\impeccable.cmd hook', timeout: 10 },
    unrelated,
  ] }] } }));
  const setup = () => {
    const result = spawnSync(process.execPath, [installer, "--project-only", "--skip-graphify", "--skip-impeccable", "--root", dir], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  };
  setup();
  const first = fs.readFileSync(file, "utf8");
  const group = JSON.parse(first).hooks.PostToolUse[0];
  assert.strictEqual(group.matcher, "Write|Edit");
  assert.deepStrictEqual(group.hooks[0], {
    type: "command", command, timeout: 10,
    commandWindows: 'cmd.exe /d /c "if exist .agents\\skills\\impeccable\\scripts\\impeccable.cmd .agents\\skills\\impeccable\\scripts\\impeccable.cmd hook"',
  });
  assert.deepStrictEqual(group.hooks[1], unrelated);
  if (process.platform === "win32") {
    const result = spawnSync(group.hooks[0].commandWindows, { cwd: dir, shell: true, encoding: "utf8", windowsHide: true });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  }
  setup();
  assert.strictEqual(fs.readFileSync(file, "utf8"), first);
});

test("graphify scope: user by default, global when asked", () => {
  const dir = gitRepo();
  const run = (extra) =>
    spawnSync(process.execPath, [installer, "--tools-only", "--dry-run", "--skip-playwright", ...extra], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH },
    }).stdout;
  const out = run([]);
  // graphify may already be installed on this machine; the scope line only shows when it isn't.
  if (/graphify install scope/.test(out)) {
    assert.match(out, /graphify install scope: user/);
    assert.match(run(["--graphify-scope=global"]), /graphify install scope: global/);
  }
});
