"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installer = path.join(__dirname, "..", "skills", "claude-codex-workflow", "scripts", "install.js");
const plain = ["--project-only", "--skip-graphify", "--skip-impeccable"];

function installerRun(cwd, args) {
  return spawnSync(process.execPath, [installer, ...args], { cwd, encoding: "utf8" });
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-sync-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.strictEqual(installerRun(dir, plain).status, 0);
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

test("install records the owned scripts in a manifest", () => {
  const dir = tempProject();
  const manifest = JSON.parse(read(dir, ".codex/workflow-manifest.json"));
  for (const file of [".codex/autopilot.js", ".codex/hooks/claude-verify.js", ".codex/hooks/workflow-lib.js", ".codex/workflow/CODEX.md"]) assert.ok(manifest.files.includes(file), file);
});

test("sync replaces a stale autopilot, removes dropped scripts and updates the workflow sections", () => {
  const dir = tempProject();
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "1.0.0";
  manifest.files.push(".codex/old-script.js");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// STALE-MARKER\n");
  fs.writeFileSync(path.join(dir, ".codex", "old-script.js"), "// dropped\n");
  fs.writeFileSync(path.join(dir, ".codex", "user-script.js"), "// not ours\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.local.md"), read(dir, "CLAUDE.local.md").replace("## Workflow", "## Workflow\nSTALE LINE"));

  const result = installerRun(dir, ["--sync"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /updated/);
  assert.doesNotMatch(read(dir, ".codex/autopilot.js"), /STALE-MARKER/);
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "old-script.js")));
  assert.ok(fs.existsSync(path.join(dir, ".codex", "user-script.js")));
  assert.doesNotMatch(read(dir, "CLAUDE.local.md"), /STALE LINE/);
  });

test("sync is silent when current, ignores other projects, and never downgrades", () => {
  const dir = tempProject();
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");

  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "99.0.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// newer\n");
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// newer\n");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-other-"));
  spawnSync("git", ["init", "-q"], { cwd: other });
  assert.strictEqual(installerRun(other, ["--sync"]).stdout, "");
  assert.ok(!fs.existsSync(path.join(other, ".codex")));
});

test("customized caveman skill is kept; an untouched older copy is refreshed", () => {
  const dir = tempProject();
  const claudeSkill = path.join(dir, ".claude", "skills", "caveman", "SKILL.md");
  fs.appendFileSync(claudeSkill, "# mine\n");
  installerRun(dir, ["--sync"]);
  installerRun(dir, ["--sync"]);
  assert.match(fs.readFileSync(claudeSkill, "utf8"), /# mine/);

  const agentSkill = path.join(dir, ".agents", "skills", "caveman", "SKILL.md");
  fs.writeFileSync(agentSkill, "OLD BUNDLED");
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.managed[".agents/skills/caveman/SKILL.md"] = require("node:crypto").createHash("sha256").update("OLD BUNDLED").digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  installerRun(dir, ["--sync"]);
  assert.notStrictEqual(fs.readFileSync(agentSkill, "utf8"), "OLD BUNDLED");
});

test("a project without a manifest gets a hint, not a rewrite", () => {
  const dir = tempProject();
  fs.rmSync(path.join(dir, ".codex", "workflow-manifest.json"));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// legacy\n");
  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /setup --project-only/);
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// legacy\n");
});

test("setup leaves git status clean, including the manifest", () => {
  const dir = tempProject();
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
  assert.strictEqual(status.trim(), "");
});

const BROKEN_WINDOWS = 'if exist ".agents/skills/impeccable/scripts/impeccable.cmd" (".agents/skills/impeccable/scripts/impeccable.cmd" hook & exit /b)';

function impeccableHooks() {
  const hook = (timeout) => ({
    type: "command",
    command: '[ ! -f ".agents/skills/impeccable/scripts/impeccable" ] || ".agents/skills/impeccable/scripts/impeccable" hook',
    commandWindows: BROKEN_WINDOWS,
    timeout,
  });
  return { hooks: { Stop: [{ hooks: [hook(30)] }], PostToolUse: [{ matcher: "Edit|Write", hooks: [hook(5)] }] } };
}

test("sync fixes Impeccable's broken Windows hook, even in a tracked hooks.json with no workflow manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-imp-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  const file = path.join(dir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(impeccableHooks(), null, 2));
  git("add", ".codex/hooks.json");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hooks");

  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /fixed 2 Impeccable Windows hook/);
  assert.match(result.stdout, /commit the change/);
  const fixed = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const hook of [fixed.hooks.Stop[0].hooks[0], fixed.hooks.PostToolUse[0].hooks[0]]) {
    assert.match(hook.commandWindows, /^cmd\.exe \/d \/c "if exist /);
    assert.doesNotMatch(hook.commandWindows, /exit \/b/);
    assert.match(hook.command, /^\[ ! -f/); // the POSIX command is untouched
  }
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, ""); // nothing left to repair
});

test("the repaired Impeccable command runs under PowerShell and cmd", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-imp-run-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const script = path.join(dir, ".agents", "skills", "impeccable", "scripts", "impeccable.cmd");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "@echo off\r\necho ran %1\r\nexit /b 0\r\n");
  const file = path.join(dir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(impeccableHooks()));
  installerRun(dir, ["--sync"]);
  const command = JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop[0].hooks[0].commandWindows;
  for (const shell of [["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], ["cmd.exe", "/d", "/s", "/c", command]]) {
    const result = spawnSync(shell[0], shell.slice(1), { cwd: dir, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: shell[0] === "cmd.exe" });
    assert.strictEqual(result.status, 0, `${shell[0]}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ran hook/, shell[0]);
  }
});
