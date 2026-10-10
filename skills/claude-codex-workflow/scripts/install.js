#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// One-command setup for the Claude + Codex workflow. Run it from the project root:
//
//   node <plugin>/skills/claude-codex-workflow/scripts/install.js [flags]
//   npx github:Jonrei1/Claude-Codex-Workflow [flags]
//   /claude-codex-workflow:setup [flags]          (in Claude Code)
//
// 1. Tools: checks node, git, Claude Code, Codex CLI, Playwright and graphify, and installs the
//    missing ones (global installs ask first unless --yes is given). Playwright MCP is
//    registered for Claude, which does the UI audits (--playwright-codex adds it to Codex).
// 2. Project, local only: copies the workflow scripts and Codex rules into .codex/, merges
//    the Claude rules into CLAUDE.local.md and an ExitPlanMode hook into
//    .claude/settings.local.json, merges .codex/hooks.json, adds the caveman skill for both
//    agents, and hides all of it through .git/info/exclude. Then it prints the detected checks.
//    Impeccable (`npx impeccable install`, design skills and UI hooks) is optional: it is
//    installed only with --impeccable, or when you answer yes to the prompt.
//
// It never modifies a file git tracks, so setting up the workflow leaves `git status` clean
// and can't cause merge conflicts for teammates. When .codex/hooks.json is tracked, the Stop
// hook goes into the user-level ~/.codex/hooks.json instead. --shared restores the old,
// team-wide layout (sections in CLAUDE.md and AGENTS.md, .gitignore entries, graphify's own
// project install). The scripts under .codex/ belong to the workflow and are updated on every
// run, so re-running the installer upgrades a project. Files an earlier version installed and
// this one no longer ships are removed (tracked in .codex/workflow-manifest.json). It never
// commits.
//
// The plugin also runs `install.js --sync` from a SessionStart hook, so a plugin update reaches
// every project that already uses the workflow without re-running setup.
//
// Flags:
//   --sync                      quiet, files-only upgrade of an already-set-up project (used by the
//                               plugin's SessionStart hook): no tools, prompts, graphify or Impeccable
//   --yes                       approve missing global tools and Playwright setup (not Impeccable)
//   --tools-only | --project-only
//   --dry-run                   print what would happen, change nothing
//   --shared                    write the team-wide layout into tracked files (old behaviour)
//   --update-sections           with --shared: replace existing ## Workflow / ## Codex execution sections
//   --impeccable                install Impeccable (otherwise asked on a terminal, skipped elsewhere)
//   --impeccable-providers=<l>  implies --impeccable; default claude,codex (use codex if you have the Impeccable plugin)
//   --skip-impeccable           don't install Impeccable and don't ask
//   --graphify-scope=<s>        user (default) or global; asked on a terminal when graphify is missing
//   --skip-graphify | --skip-playwright
//   --playwright-codex          also register Playwright MCP for Codex
//   --root <dir>                project directory (default: current directory)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");
const { setupPlaywright } = require("./playwright");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : "";
};

const isWindows = process.platform === "win32";
const dryRun = flag("--dry-run");
const sync = flag("--sync");
let shared = flag("--shared");
let projectDir = "";
const templates = path.join(__dirname, "..", "templates");
const pluginVersion = readJson(path.join(__dirname, "..", "..", "..", "package.json"))?.version || "0.0.0";
const MANIFEST = ".codex/workflow-manifest.json";
// Scripts the workflow owns: always the plugin's version, and removed once a later version drops them.
const OWNED = ["codex/hooks/claude-verify.js", "codex/hooks/workflow-lib.js", "codex/hooks/claude-plan-gate.js", "codex/autopilot.js"];
const CODEX_RULES = ".codex/workflow/CODEX.md";
// Files the user may customize: created when missing, refreshed only while still unmodified.
const MANAGED = [
  ["plans/_template.md", ".codex/plans/_template.md"],
  ["skills/caveman/SKILL.md", ".claude/skills/caveman/SKILL.md"],
  ["skills/caveman/SKILL.md", ".agents/skills/caveman/SKILL.md"],
];
const results = [];
const changed = [];
const notices = []; // one-line explanations --sync prints at session start

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split(".").map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

const sha = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");

function record(step, ok, note = "") {
  results.push({ step, ok, note });
  if (sync) return;
  const mark = ok === true ? "ok  " : ok === false ? "FAIL" : "--  ";
  console.log(`  [${mark}] ${step}${note ? `: ${note}` : ""}`);
}

function quote(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Windows needs a shell to run npm/npx/claude/codex (.cmd shims).
function run(command, commandArgs = [], options = {}) {
  return spawnSync(isWindows ? [command, ...commandArgs].map(quote).join(" ") : command, isWindows ? [] : commandArgs, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    shell: isWindows,
    windowsHide: true,
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout || 10 * 60 * 1000,
  });
}

function has(command) {
  const result = run(command, ["--version"], { timeout: 60 * 1000 });
  return result.status === 0 ? (result.stdout || "").trim().split("\n")[0] : "";
}

// Asks on the terminal, whatever flags were given. False when there's no terminal to ask on.
async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// --yes approves the machine tools. It doesn't approve optional extras like Impeccable.
async function confirm(question) {
  return flag("--yes") || ask(question);
}

// Where graphify goes: "user" (default) or "global". --graphify-scope=<user|global> decides;
// otherwise a terminal is asked, and --yes, --dry-run or no terminal mean "user".
async function graphifyScope() {
  const given = flagValue("--graphify-scope").toLowerCase();
  if (given === "user" || given === "global") return given;
  if (dryRun || flag("--yes") || !process.stdin.isTTY) return "user";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question("Install graphify for your user only, or globally for every user (needs admin rights)? [user/global] (default user) ", resolve),
  );
  rl.close();
  return /^g(lobal)?$/i.test(answer.trim()) ? "global" : "user";
}

// Impeccable (design skills and UI hooks) is optional and never installed by default:
// --impeccable (or --impeccable-providers) opts in, --skip-impeccable opts out, and
// otherwise the user is asked. --yes, --dry-run and a missing terminal all mean "no".
async function wantsImpeccable() {
  if (flag("--skip-impeccable")) return false;
  if (flag("--impeccable") || flagValue("--impeccable-providers")) return true;
  if (dryRun || flag("--yes") || !process.stdin.isTTY) return false;
  return ask("Install Impeccable (optional design skills and UI hooks, useful for UI work)?");
}

// Runs an install command after asking. Returns true when it ran and succeeded.
async function install(step, command, commandArgs) {
  const line = [command, ...commandArgs].join(" ");
  if (dryRun) {
    record(step, null, `would run \`${line}\``);
    return false;
  }
  if (!(await confirm(`${step} is missing. Run \`${line}\`?`))) {
    record(step, false, `missing; install with \`${line}\` (or re-run with --yes)`);
    return false;
  }
  console.log(`  $ ${line}`);
  const result = run(command, commandArgs, { inherit: true });
  return result.status === 0;
}

// graphify installs into ~/.local/bin (uv, pipx) or the Python user scripts dir, which
// may not be on this process's PATH yet.
function findGraphify() {
  if (has("graphify")) return "graphify";
  const exe = isWindows ? "graphify.exe" : "graphify";
  const candidates = [path.join(os.homedir(), ".local", "bin", exe)];
  if (isWindows && process.env.APPDATA) {
    const pythonDir = path.join(process.env.APPDATA, "Python");
    try {
      for (const version of fs.readdirSync(pythonDir)) candidates.push(path.join(pythonDir, version, "Scripts", exe));
    } catch {
      // no user Python scripts
    }
  }
  const found = candidates.find((file) => fs.existsSync(file));
  return found ? found.split(path.sep).join("/") : "";
}

async function installTools(impeccable) {
  console.log("\nTools");
  const major = Number(process.versions.node.split(".")[0]);
  record("node", major >= 18, major >= 18 ? process.version : `${process.version}; need 18 or newer`);
  const gitVersion = has("git");
  record("git", Boolean(gitVersion), gitVersion || "missing; install it with your OS package manager");

  for (const tool of [
    { step: "Claude Code", command: "claude", pkg: "@anthropic-ai/claude-code" },
    { step: "Codex CLI", command: "codex", pkg: "@openai/codex" },
  ]) {
    let version = has(tool.command);
    if (!version && (await install(tool.step, "npm", ["install", "-g", tool.pkg]))) version = has(tool.command);
    if (version) record(tool.step, true, version);
    else if (!dryRun && !results.some((r) => r.step === tool.step)) record(tool.step, false, `\`npm install -g ${tool.pkg}\` failed`);
  }
  if (has("codex") && !dryRun && run("codex", ["login", "status"], { timeout: 60 * 1000 }).status !== 0) {
    record("Codex login", false, "run `codex login`");
  }

  if (flag("--skip-playwright")) record("Playwright setup", null, "skipped (--skip-playwright)");
  else await setupPlaywright({ run, has, confirm, record, dryRun, codex: flag("--playwright-codex") });

  let graphify = findGraphify();
  if (!graphify) {
    const python = isWindows ? "python" : "python3";
    const scope = await graphifyScope();
    console.log(`  graphify install scope: ${scope}`);
    // user: into your home directory, no admin rights. global: system-wide pip, which
    // usually needs administrator/root rights and is shared by every user on the machine.
    const installers =
      scope === "global"
        ? [[python, ["-m", "pip", "install", "graphifyy"]]]
        : [
            ["uv", ["tool", "install", "graphifyy"]],
            ["pipx", ["install", "graphifyy"]],
            [python, ["-m", "pip", "install", "--user", "graphifyy"]],
          ];
    const available = installers.find(([command]) => has(command));
    if (!available) record("graphify", false, "install uv (https://docs.astral.sh/uv/) or Python, then re-run");
    else if (await install("graphify", available[0], available[1])) graphify = findGraphify();
  }
  if (graphify) {
    record("graphify", true, graphify === "graphify" ? has("graphify") : `${graphify} (not on PATH; add its folder to PATH)`);
  } else if (!dryRun && !results.some((r) => r.step === "graphify")) {
    record("graphify", false, "installed but not found; add ~/.local/bin to PATH and re-run");
  }

  if (impeccable) {
    record("npx (Impeccable)", Boolean(has("npx")), has("npx") ? "Impeccable runs through npx; nothing global to install" : "missing; comes with Node");
  }
  return graphify;
}

// ---- project files ----

function gitIn(root, gitArgs) {
  return spawnSync(isWindows ? "git.exe" : "git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
}

function isTracked(root, rel) {
  return gitIn(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
}

// Outside --shared, a file git tracks is never written: teammates would see the change, and
// two developers setting up the workflow would get merge conflicts.
function write(file, content, step, note, { allowTracked = false } = {}) {
  if (!shared && projectDir && !allowTracked) {
    const rel = path.relative(projectDir, file);
    if (!rel.startsWith("..") && !path.isAbsolute(rel) && isTracked(projectDir, rel)) {
      return record(step, false, "tracked by git, left unchanged (setup only writes local files; --shared allows it)");
    }
  }
  if (dryRun) return record(step, null, `dry run, not written (${note})`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write beside the target and rename, so a reader never sees a half-written script.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    return record(step, false, `couldn't write: ${error.message}`);
  }
  changed.push(step);
  record(step, true, note);
}

// Deletes a file an earlier version installed. Tracked files are never touched.
function remove(root, rel) {
  if (!shared && isTracked(root, rel)) return record(rel, true, "stale, but tracked by git; left in place");
  if (dryRun) return record(rel, null, "dry run, stale file not removed");
  try {
    fs.rmSync(path.join(root, rel), { force: true });
  } catch (error) {
    return record(rel, false, `couldn't remove: ${error.message}`);
  }
  changed.push(`${rel} (removed)`);
  record(rel, true, "stale file from an earlier version removed");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Workflow-owned files: always the plugin's version.
function writeOwned(root, source, to) {
  const current = readText(path.join(root, to));
  if (current === source) return record(to, true, "up to date");
  write(path.join(root, to), source, to, current === null ? "created" : "updated to the plugin's version");
}

function copyOwned(root, from, to) {
  writeOwned(root, fs.readFileSync(path.join(templates, from), "utf8"), to);
}

// Files the user may customize: created when missing, and refreshed to the plugin's version
// only while they still match what an earlier run installed (the manifest holds its hash).
// Edited files are kept.
function copyManaged(root, from, to, previous) {
  const source = fs.readFileSync(path.join(templates, from), "utf8");
  const current = readText(path.join(root, to));
  if (current === null) return write(path.join(root, to), source, to, "created");
  if (current === source) return record(to, true, "up to date");
  if (previous[to] && previous[to] === sha(current)) return write(path.join(root, to), source, to, "updated to the plugin's version");
  record(to, true, "customized, kept");
}

// Deletes files an earlier version installed that this one no longer ships.
function removeStale(root, previous, current) {
  for (const file of previous.files || []) {
    if (current.includes(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) continue;
    if (readText(path.join(root, file)) !== null) remove(root, file);
  }
}

function sectionRange(text, heading) {
  const match = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!match) return null;
  // The section ends at the next level-2 heading outside a fenced code block.
  let offset = match.index + match[0].length;
  let fenced = false;
  for (const line of text.slice(offset).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^## /.test(line)) return { start: match.index, end: offset };
    offset += line.length + 1;
  }
  return { start: match.index, end: text.length };
}

// Appends the template's section. An existing, different section is replaced in a local file
// (it belongs to the workflow), and in a shared file only with --update-sections.
function mergeSection(root, file, section, heading, { local = false } = {}) {
  const target = path.join(root, file);
  const text = readText(target);
  const body = section.trim() + "\n";
  if (text === null) return write(target, body, file, `created with the ${heading} section`);
  const range = sectionRange(text, heading);
  if (!range) return write(target, `${text.trimEnd()}\n\n${body}`, file, `appended the ${heading} section`);
  if (text.slice(range.start, range.end).trim() === section.trim()) return record(file, true, `${heading} is up to date`);
  if (!local && !sync && !flag("--update-sections")) {
    return record(file, true, `${heading} exists and differs from the plugin's; re-run with --update-sections to replace it`);
  }
  const updated = `${text.slice(0, range.start)}${body}${range.end < text.length ? "\n" : ""}${text.slice(range.end)}`;
  write(target, updated, file, `replaced the ${heading} section`);
}

// Merges the template hook groups into a Codex hooks file. Groups whose commands are already
// present are skipped, an older workflow Stop command is upgraded in place, and Impeccable's
// Windows launcher is repaired. `events` limits which template events are merged.
// Impeccable's own installer writes a Windows command of the form `if exist "x" ("x" hook & exit /b)`.
// Codex can run it through PowerShell, where that is a syntax error, so the hook fails on every
// event. The cmd.exe wrapper below runs the same thing from PowerShell and cmd alike.
const IMPECCABLE_WINDOWS = 'cmd.exe /d /c "if exist .agents\\skills\\impeccable\\scripts\\impeccable.cmd .agents\\skills\\impeccable\\scripts\\impeccable.cmd hook"';
const IMPECCABLE_HOOK = /\.agents\/skills\/impeccable\/scripts\/impeccable(?:\.cmd)?["']?\s+hook\b/;

// Fixes one Impeccable hook entry in place. Returns true when it changed.
function repairImpeccableHook(hook) {
  if (hook.type !== "command") return false;
  const isImpeccable = [hook.command, hook.commandWindows].some((command) => typeof command === "string" && IMPECCABLE_HOOK.test(command.replace(/\\/g, "/")));
  if (!isImpeccable || hook.commandWindows === IMPECCABLE_WINDOWS) return false;
  hook.commandWindows = IMPECCABLE_WINDOWS;
  return true;
}

// Repairs the Impeccable hooks in a Codex hooks file and touches nothing else. A tracked file is
// repaired too: the hook is broken for everyone who has it, and the change is only its
// commandWindows line, which you can commit.
function repairImpeccableHooks(file, step) {
  const text = readText(file);
  if (text === null || !text.includes("impeccable")) return;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return;
  }
  let repaired = 0;
  for (const groups of Object.values(config.hooks || {})) {
    for (const group of groups) for (const hook of group.hooks || []) if (repairImpeccableHook(hook)) repaired++;
  }
  if (!repaired) return;
  const tracked = projectDir && isTracked(projectDir, path.relative(projectDir, file));
  const note = `fixed ${repaired} Impeccable Windows hook(s) that failed on every event${tracked ? "; the file is tracked, so commit the change" : ""}; trust the hooks again in Codex (/hooks)`;
  write(file, JSON.stringify(config, null, 2) + "\n", step, note, { allowTracked: true });
  if (changed.includes(step)) notices.push(`${step}: ${note}`);
}

// graphify may be installed at a full path; compare hook commands without it.
const normalizeCommand = (command) => String(command).replace(/^"?[^"]*?graphify(\.exe)?"? hook-guard/i, "graphify hook-guard");

function mergeHooks(file, step, { graphify, events } = {}) {
  let template = fs.readFileSync(path.join(templates, "codex", "hooks.json"), "utf8");
  if (graphify && graphify !== "graphify") template = template.replace(/"graphify hook-guard/g, `"${graphify} hook-guard`);
  const wanted = JSON.parse(template);
  const text = readText(file);
  let config;
  try {
    config = text === null ? { description: wanted.description, hooks: {} } : JSON.parse(text);
  } catch {
    return record(step, false, "isn't valid JSON; merge templates/codex/hooks.json by hand");
  }
  config.hooks = config.hooks || {};
  let repaired = 0;
  const verifyHook = wanted.hooks.Stop[0].hooks[0];
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type !== "command") continue;
        if (typeof hook.command === "string" && hook.command.includes("claude-verify.js") && hook.command !== verifyHook.command) {
          Object.assign(hook, verifyHook);
          repaired++;
          continue;
        }
        if (repairImpeccableHook(hook)) repaired++;
      }
    }
  }
  let added = 0;
  for (const [event, groups] of Object.entries(wanted.hooks)) {
    if (events && !events.includes(event)) continue;
    const existing = (config.hooks[event] = config.hooks[event] || []);
    const present = new Set(existing.flatMap(hookCommands).map(normalizeCommand));
    for (const group of groups) {
      if (hookCommands(group).every((command) => present.has(normalizeCommand(command)))) continue;
      existing.push(group);
      added++;
    }
  }
  if (!added && !repaired) return record(step, true, events ? "verify hook present" : "verify and graphify hooks present");
  write(file, JSON.stringify(config, null, 2) + "\n", step, `added ${added} hook group(s), updated ${repaired} hook(s); trust them again in Codex (/hooks)`);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// The project's .codex/hooks.json when it's ours to change. When the team tracks it, only the
// Stop hook goes into the user-level ~/.codex/hooks.json; its command does nothing in repos
// without the workflow.
function mergeProjectHooks(root, graphify, label = "") {
  const rel = ".codex/hooks.json";
  if (!shared && isTracked(root, rel)) {
    repairImpeccableHooks(path.join(root, rel), `${rel}${label}`);
    return mergeHooks(path.join(codexHome(), "hooks.json"), `~/.codex/hooks.json${label}`, { events: ["Stop"] });
  }
  mergeHooks(path.join(root, rel), `${rel}${label}`, { graphify });
}

// Claude Code: a PostToolUse hook on ExitPlanMode that reminds Claude to confirm the role and
// hand the plan off. settings.local.json is per-user, so teammates never see it.
function mergeClaudeSettings(root) {
  const rel = ".claude/settings.local.json";
  const file = path.join(root, rel);
  const command = "node -e \"const p=require('path').join(process.env.CLAUDE_PROJECT_DIR||process.cwd(),'.codex','hooks','claude-plan-gate.js');require('fs').existsSync(p)?require(p):console.log('{}')\"";
  const text = readText(file);
  let config;
  try {
    config = text === null ? {} : JSON.parse(text);
  } catch {
    return record(rel, false, "isn't valid JSON; add the ExitPlanMode hook by hand (see SKILL.md)");
  }
  config.hooks = config.hooks || {};
  const groups = (config.hooks.PostToolUse = config.hooks.PostToolUse || []);
  if (groups.some((group) => hookCommands(group).includes(command))) return record(rel, true, "plan handoff hook present");
  groups.push({ matcher: "ExitPlanMode", hooks: [{ type: "command", command }] });
  write(file, JSON.stringify(config, null, 2) + "\n", rel, "added the ExitPlanMode handoff hook");
}

function hookCommands(group) {
  return (group.hooks || []).map((hook) => hook.command);
}

// Local-only workflow paths, hidden from git status through .git/info/exclude.
function localPaths(root) {
  return [
    ".codex/plans/",
    ".codex/verify/",
    ".codex/verify.json",
    ".codex/autopilot/",
    ".codex/tasks/",
    ".codex/workflow/",
    ".codex/workflow-manifest.json",
    ".codex/autopilot.js",
    ".codex/hooks/claude-verify.js",
    ".codex/hooks/workflow-lib.js",
    ".codex/hooks/claude-plan-gate.js",
    ...(isTracked(root, ".codex/hooks.json") ? [] : [".codex/hooks.json"]),
    "CLAUDE.local.md",
    ".claude/settings.local.json",
    ".claude/skills/caveman/",
    ".agents/skills/caveman/",
    "graphify-out/",
  ];
}

function appendBlock(file, step, heading, wanted) {
  const text = readText(file) || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const missing = wanted.filter((line) => !lines.includes(line));
  if (!missing.length) return record(step, true, "workflow entries present");
  const block = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# ${heading}\n${missing.join("\n")}\n`;
  write(file, text + block, step, `added ${missing.length} entr${missing.length === 1 ? "y" : "ies"}`);
}

function updateExclude(root) {
  const rel = gitIn(root, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim() || ".git/info/exclude";
  appendBlock(path.resolve(root, rel), ".git/info/exclude", "Claude + Codex workflow (local only)", localPaths(root));
}

function updateGitignore(root) {
  appendBlock(path.join(root, ".gitignore"), ".gitignore", "Claude + Codex workflow", [".codex/verify/", ".codex/autopilot/", ".codex/workflow-manifest.json", ".codex/plans/*", "!.codex/plans/_template.md", "graphify-out/", "CLAUDE.local.md", ".claude/settings.local.json"]);
}

// Earlier versions wrote plans to plans/ and sections into tracked files. Untracked plans
// move to .codex/plans/; tracked files are only pointed out, never edited.
function migrateOldLayout(root) {
  const oldPlans = path.join(root, "plans");
  let names = [];
  try {
    names = fs.readdirSync(oldPlans);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".md") || name.startsWith("_") || isTracked(root, `plans/${name}`)) continue;
    const to = path.join(root, ".codex", "plans", name);
    if (fs.existsSync(to)) continue;
    if (dryRun) {
      record(`plans/${name}`, null, `would move to .codex/plans/${name}`);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(oldPlans, name), to);
    record(`plans/${name}`, true, `moved to .codex/plans/${name}`);
  }
  if (shared) return;
  const old = [
    ["CLAUDE.md", "## Workflow", "autopilot.js"],
    ["AGENTS.md", "## Codex execution", "autopilot.js"],
    [".gitignore", "# Claude + Codex workflow", "plans/*"],
  ];
  for (const [file, heading, marker] of old) {
    const text = readText(path.join(root, file));
    if (text && text.includes(heading) && text.includes(marker)) {
      record(`${file} (old workflow)`, null, `still has the previous version's "${heading}" block; the rules now live in local files, so remove it together with your team when convenient`);
    }
  }
}

const graphifyRule = "- After all code edits for a task are complete, run `graphify update .` once at the end\n  of the coding session. Do not run it between file edits.";

function ensureGraphifyRule(root, file) {
  const target = path.join(root, file);
  const text = readText(target);
  if (text === null || text.includes("Do not run it between file edits")) return;
  write(target, `${text.trimEnd()}\n${graphifyRule}\n`, file, "added the once-per-task graphify rule");
}

function runStep(root, step, command, commandArgs) {
  const line = [command, ...commandArgs].join(" ");
  if (dryRun) return record(step, null, `would run \`${line}\``);
  console.log(`  $ ${line}`);
  const result = run(command, commandArgs, { cwd: root, inherit: true });
  record(step, result.status === 0, result.status === 0 ? "" : `\`${line}\` exited with ${result.status ?? "a timeout"}`);
}

function setupProject(root, graphify, impeccable) {
  projectDir = root;
  if (!sync) console.log(`\nProject: ${root} (${shared ? "shared layout (--shared)" : "local only: no tracked file is changed"})`);
  const previous = readJson(path.join(root, MANIFEST)) || {};
  const ownedPaths = [...OWNED.map((file) => `.${file}`), CODEX_RULES];
  for (const file of OWNED) copyOwned(root, file, `.${file}`);
  const codexRules = fs.readFileSync(path.join(templates, "AGENTS.codex.md"), "utf8");
  writeOwned(root, `# Codex rules for the Claude + Codex workflow\n\n${codexRules.replace(/<!--[\s\S]*?-->\s*/, "")}`, CODEX_RULES);
  removeStale(root, previous, ownedPaths);
  const managed = {};
  for (const [from, to] of MANAGED) {
    copyManaged(root, from, to, previous.managed || {});
    // Record a hash only for text this plugin wrote; a customized file keeps the old hash, so it never matches.
    const text = readText(path.join(root, to));
    if (text !== null && text === fs.readFileSync(path.join(templates, from), "utf8")) managed[to] = sha(text);
    else if (previous.managed?.[to]) managed[to] = previous.managed[to];
  }
  if (!sync) migrateOldLayout(root);

  const claudeSection = fs.readFileSync(path.join(templates, "CLAUDE.workflow.md"), "utf8");
  if (shared) {
    mergeSection(root, "CLAUDE.md", claudeSection, "## Workflow");
    mergeSection(root, "AGENTS.md", codexRules.split("<!--")[0], "## Codex execution");
  } else {
    mergeSection(root, "CLAUDE.local.md", claudeSection, "## Workflow", { local: true });
  }
  mergeClaudeSettings(root);
  mergeProjectHooks(root, graphify);
  if (shared) updateGitignore(root);
  else updateExclude(root);

  if (sync) {
    // Files only: graphify and Impeccable are left as they are.
  } else if (flag("--skip-graphify")) record("graphify install", null, "skipped (--skip-graphify)");
  else if (!graphify && !dryRun) record("graphify install", false, "graphify isn't installed; re-run after installing it");
  else if (!shared) record("graphify project install", null, "skipped: it edits shared CLAUDE.md/AGENTS.md. The graphify rules are in CLAUDE.local.md and .codex/workflow/CODEX.md, and its guard hooks in .codex/hooks.json");
  else {
    runStep(root, "graphify claude install", graphify || "graphify", ["claude", "install"]);
    runStep(root, "graphify codex install", graphify || "graphify", ["codex", "install"]);
    ensureGraphifyRule(root, "CLAUDE.md");
    ensureGraphifyRule(root, "AGENTS.md");
  }

  if (sync) {
    // handled above
  } else if (!impeccable) {
    record("impeccable install", null, flag("--skip-impeccable") ? "skipped (--skip-impeccable)" : "skipped (optional; re-run with --impeccable to add it)");
  } else {
    const providers = flagValue("--impeccable-providers") || "claude,codex";
    if (!shared) console.log("  Note: Impeccable's own installer writes shared project files (skills, hooks, PRODUCT.md/DESIGN.md); review them before committing.");
    runStep(root, "impeccable install", "npx", ["-y", "impeccable", "install", "--project", `--providers=${providers}`]);
    // Impeccable merges its own hooks into .codex/hooks.json; make sure ours survived.
    mergeProjectHooks(root, graphify, " (after Impeccable)");
  }

  if (!dryRun && results.every((r) => r.ok !== false)) {
    const manifest = { version: pluginVersion, shared, files: ownedPaths, managed };
    const text = JSON.stringify(manifest, null, 2) + "\n";
    if (readText(path.join(root, MANIFEST)) !== text) write(path.join(root, MANIFEST), text, MANIFEST, `workflow v${pluginVersion}`);
  }

  if (!dryRun && !sync) {
    console.log("\nDetected checks (node .codex/hooks/claude-verify.js --print-checks):");
    const checks = run(process.execPath, [path.join(root, ".codex", "hooks", "claude-verify.js"), "--print-checks"], { cwd: root });
    console.log((checks.stdout || checks.stderr || "").replace(/^/gm, "  "));
  }
}

function projectRoot() {
  const start = path.resolve(flagValue("--root") || process.cwd());
  const result = spawnSync(isWindows ? "git.exe" : "git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? path.resolve(result.stdout.trim()) : "";
}

// Files-only upgrade for a project that already uses the workflow. Silent when there is
// nothing to do, and never fails the session it runs in.
function syncProject() {
  const root = projectRoot();
  if (!root) return;
  // Independent of the workflow: a broken Impeccable hook fails on every Codex event.
  projectDir = root;
  repairImpeccableHooks(path.join(root, ".codex", "hooks.json"), ".codex/hooks.json");
  repairImpeccableHooks(path.join(codexHome(), "hooks.json"), "~/.codex/hooks.json");
  const manifest = readJson(path.join(root, MANIFEST));
  if (!manifest) {
    if (readText(path.join(root, ".codex", "autopilot.js")) !== null) {
      console.log("claude-codex-workflow: this project's workflow files predate automatic updates. Run /claude-codex-workflow:setup --project-only once to upgrade them.");
    }
    return;
  }
  // A teammate on a newer plugin already upgraded this project; don't take it back.
  if (manifest.version && compareVersions(manifest.version, pluginVersion) > 0) return;
  shared = Boolean(manifest.shared);
  setupProject(root, "", false);
}

function announceChanges() {
  for (const notice of notices) console.log(`claude-codex-workflow: ${notice}`);
  const files = changed.filter((file) => file !== MANIFEST);
  if (files.length) {
    console.log(
      `claude-codex-workflow v${pluginVersion}: updated ${files.length} project file(s) (${files.join(", ")}). ` +
        "Restart Claude Code and Codex so the updated workflow applies.",
    );
  }
  for (const r of results.filter((r) => r.ok === false)) console.log(`claude-codex-workflow sync: ${r.step}: ${r.note}`);
}

async function main() {
  if (sync) {
    try {
      syncProject();
      announceChanges();
    } catch (error) {
      console.log(`claude-codex-workflow sync skipped: ${error.message}`);
    }
    return;
  }
  const doTools = !flag("--project-only");
  const doProject = !flag("--tools-only");
  if (dryRun) console.log("Dry run: nothing is installed or written.");

  const impeccable = doProject && (await wantsImpeccable());
  const graphify = doTools ? await installTools(impeccable) : findGraphify();
  if (doProject) {
    const root = projectRoot();
    if (!root) {
      record("project", false, "not inside a git repository; run `git init` first, or pass --root <dir>");
    } else {
      setupProject(root, graphify, impeccable);
    }
  }

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${failed.length ? `${failed.length} step(s) need attention:` : "All steps succeeded."}`);
  for (const r of failed) console.log(`  - ${r.step}: ${r.note}`);
  if (doProject) {
    console.log(`
Left for you:
  1. Open the project in Codex and trust the workflow hooks (Codex asks on first run, or use /hooks).
  2. Codex runs the verify step (headless Claude) from its own session. Let those commands use the
     network and a long timeout (30 min); approve them when Codex asks to run outside the sandbox.
  3. Build the first graph: /graphify . in Claude Code (needs some code first).
${impeccable ? `  4. /impeccable init in Claude Code writes PRODUCT.md. In an existing project, follow with
     /impeccable document to capture DESIGN.md.` : `  4. Impeccable (design skills, optional) wasn't installed. For UI-heavy work, re-run with --impeccable.`}
  5. If the detected checks above are wrong or empty, add .codex/verify.json. For UI work, add its
     "ui" block (startCommand, url, viewports, paths) so Claude can audit the app with Playwright.
  6. Restart Claude Code (it loads CLAUDE.local.md and the plan hook) and check /mcp for Playwright.
Then keep a Codex session open in this repo and plan a task with Claude. Claude asks who
implements it; for Codex it sends the plan to that session itself and reviews the result.`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
