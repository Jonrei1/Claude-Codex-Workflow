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
//    missing ones (global installs ask first unless --yes is given).
// 2. Project: copies the workflow scripts, merges the CLAUDE.md / AGENTS.md sections and
//    .codex/hooks.json, adds the caveman skill for both agents, updates .gitignore, runs
//    `graphify claude install` and `graphify codex install`, then prints the detected checks.
//    Impeccable (`npx impeccable install`, design skills and UI hooks) is optional: it is
//    installed only with --impeccable, or when you answer yes to the prompt.
//
// It never overwrites CLAUDE.md, AGENTS.md or hooks.json; it merges into them. The scripts
// under .codex/ and the ## Workflow / ## Codex execution sections belong to the workflow and
// are updated on every run, so re-running the installer upgrades a project. Files an earlier
// version installed and this one no longer ships are removed (tracked in
// .codex/workflow-manifest.json). It never commits.
//
// The plugin also runs `install.js --sync` from a SessionStart hook, so a plugin update
// reaches every project that already uses the workflow without re-running setup.
//
// Flags:
//   --yes                       approve missing global tools and Playwright setup (not Impeccable)
//   --tools-only | --project-only
//   --dry-run                   print what would happen, change nothing
//   --keep-sections             leave existing ## Workflow / ## Codex execution sections alone
//                               (they are replaced by default; --update-sections is the same as the default)
//   --sync                      quiet, files-only upgrade of an already-set-up project (used by the
//                               plugin's SessionStart hook): no tools, prompts, graphify or Impeccable
//   --impeccable                install Impeccable (otherwise asked on a terminal, skipped elsewhere)
//   --impeccable-providers=<l>  implies --impeccable; default claude,codex (use codex if you have the Impeccable plugin)
//   --skip-impeccable           don't install Impeccable and don't ask
//   --graphify-scope=<s>        user (default) or global; asked on a terminal when graphify is missing
//   --skip-graphify | --skip-playwright
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
const templates = path.join(__dirname, "..", "templates");
const pluginVersion = readJson(path.join(__dirname, "..", "..", "..", "package.json"))?.version || "0.0.0";
const MANIFEST = path.join(".codex", "workflow-manifest.json");
// Scripts the workflow owns: always the plugin's version, and removed once a later version drops them.
const OWNED = ["codex/hooks/claude-verify.js", "codex/hooks/workflow-lib.js", "codex/autopilot.js"];
// Files the user may customize, created when missing and refreshed only while still unmodified.
const MANAGED = [
  ["plans/_template.md", "plans/_template.md"],
  ["skills/caveman/SKILL.md", ".claude/skills/caveman/SKILL.md"],
  ["skills/caveman/SKILL.md", ".agents/skills/caveman/SKILL.md"],
];
const results = [];
const changed = [];

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
  else await setupPlaywright({ run, has, confirm, record, dryRun });

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

function write(file, content, step, note) {
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

function remove(file, step, note) {
  if (dryRun) return record(step, null, `dry run, not removed (${note})`);
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    return record(step, false, `couldn't remove: ${error.message}`);
  }
  changed.push(`${step} (removed)`);
  record(step, true, note);
}

const sha = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Workflow-owned scripts: always the plugin's version.
function copyOwned(root, from, to) {
  const source = fs.readFileSync(path.join(templates, from), "utf8");
  const current = readText(path.join(root, to));
  if (current === source) return record(to, true, "up to date");
  write(path.join(root, to), source, to, current === null ? "created" : "updated to the plugin's version");
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

// Appends the template's section, or replaces it when it differs. --keep-sections leaves it alone.
// The replaced text is saved to .codex/backup/ first, in case it held your own edits.
function mergeSection(root, file, section, heading) {
  const target = path.join(root, file);
  const text = readText(target);
  const body = section.trim() + "\n";
  if (text === null) return write(target, body, file, `created with the ${heading} section`);
  const range = sectionRange(text, heading);
  if (!range) return write(target, `${text.trimEnd()}\n\n${body}`, file, `appended the ${heading} section`);
  if (text.slice(range.start, range.end).trim() === section.trim()) return record(file, true, `${heading} is up to date`);
  if (flag("--keep-sections")) {
    return record(file, true, `${heading} exists and differs from the plugin's; kept (--keep-sections)`);
  }
  write(path.join(root, ".codex", "backup", `${file}.bak`), text, `.codex/backup/${file}.bak`, `previous ${file} saved`);
  const updated = `${text.slice(0, range.start)}${body}${range.end < text.length ? "\n" : ""}${text.slice(range.end)}`;
  write(target, updated, file, `replaced the ${heading} section with the plugin's`);
}

function hookCommands(group) {
  return (group.hooks || []).map((hook) => hook.command);
}

// graphify may be installed at a full path; compare hook commands without it.
const normalizeCommand = (command) => String(command).replace(/^"?[^"]*?graphify(\.exe)?"? hook-guard/i, "graphify hook-guard");

// Adds each template hook group whose command isn't in .codex/hooks.json yet, and drops groups
// an earlier version added that this version no longer ships. Returns the template's commands.
function mergeHooks(root, graphify, label, previousHooks = []) {
  const file = path.join(root, ".codex", "hooks.json");
  let template = fs.readFileSync(path.join(templates, "codex", "hooks.json"), "utf8");
  if (graphify && graphify !== "graphify") template = template.replace(/"graphify hook-guard/g, `"${graphify} hook-guard`);
  const wanted = JSON.parse(template);
  const wantedCommands = Object.values(wanted.hooks).flatMap((groups) => groups.flatMap(hookCommands));
  const text = readText(file);
  let config;
  try {
    config = text === null ? { description: wanted.description, hooks: {} } : JSON.parse(text);
  } catch {
    record(`.codex/hooks.json${label}`, false, "isn't valid JSON; merge templates/codex/hooks.json by hand");
    return wantedCommands;
  }
  config.hooks = config.hooks || {};
  const stale = new Set(previousHooks.map(normalizeCommand));
  for (const command of wantedCommands) stale.delete(normalizeCommand(command));
  let added = 0;
  let dropped = 0;
  for (const [event, groups] of Object.entries(wanted.hooks)) {
    let existing = (config.hooks[event] = config.hooks[event] || []);
    const kept = existing.filter((group) => !(hookCommands(group).length && hookCommands(group).every((command) => stale.has(normalizeCommand(command)))));
    dropped += existing.length - kept.length;
    existing = config.hooks[event] = kept;
    const present = new Set(existing.flatMap(hookCommands).map(normalizeCommand));
    for (const group of groups) {
      if (hookCommands(group).every((command) => present.has(normalizeCommand(command)))) continue;
      existing.push(group);
      added++;
    }
  }
  if (added || dropped) {
    write(file, JSON.stringify(config, null, 2) + "\n", `.codex/hooks.json${label}`, `added ${added}, removed ${dropped} hook group(s); trust them again in Codex (/hooks)`);
  } else {
    record(`.codex/hooks.json${label}`, true, "verify and graphify hooks present");
  }
  return wantedCommands;
}

function updateGitignore(root) {
  const file = path.join(root, ".gitignore");
  const text = readText(file) || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const wanted = [".codex/verify/", ".codex/autopilot/", ".codex/backup/", "graphify-out/", "plans/*", "!plans/_template.md"];
  const missing = wanted.filter((line) => !lines.includes(line));
  if (!missing.length) return record(".gitignore", true, "workflow entries present");
  const block = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# Claude + Codex workflow\n${missing.join("\n")}\n`;
  write(file, text + block, ".gitignore", `added ${missing.join(", ")}`);
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

// Deletes files an earlier version installed that this one no longer ships.
function removeStale(root, previous, current) {
  for (const file of previous.files || []) {
    if (current.includes(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) continue;
    const target = path.join(root, file);
    if (readText(target) !== null) remove(target, file, "stale file from an earlier version removed");
  }
}

function setupProject(root, graphify, impeccable) {
  if (!sync) console.log(`\nProject: ${root}`);
  const previous = readJson(path.join(root, MANIFEST)) || {};
  const ownedPaths = OWNED.map((file) => `.${file}`);
  for (const file of OWNED) copyOwned(root, file, `.${file}`);
  removeStale(root, previous, ownedPaths);
  const managed = {};
  for (const [from, to] of MANAGED) {
    copyManaged(root, from, to, previous.managed || {});
    // Record a hash only for text this plugin wrote; a customized file keeps the old hash, so it never matches.
    const text = readText(path.join(root, to));
    if (text !== null && text === fs.readFileSync(path.join(templates, from), "utf8")) managed[to] = sha(text);
    else if (previous.managed?.[to]) managed[to] = previous.managed[to];
  }
  if (readText(path.join(root, "docs", "tasks", ".gitkeep")) === null) write(path.join(root, "docs", "tasks", ".gitkeep"), "", "docs/tasks/.gitkeep", "created");

  const claudeSection = fs.readFileSync(path.join(templates, "CLAUDE.workflow.md"), "utf8");
  const agentsSection = fs.readFileSync(path.join(templates, "AGENTS.codex.md"), "utf8").split("<!--")[0];
  mergeSection(root, "CLAUDE.md", claudeSection, "## Workflow");
  mergeSection(root, "AGENTS.md", agentsSection, "## Codex execution");
  const hookCommandsInstalled = mergeHooks(root, graphify, "", previous.hooks);
  updateGitignore(root);

  if (sync) {
    // Files only: graphify and Impeccable are left as they are.
  } else if (flag("--skip-graphify")) record("graphify install", null, "skipped (--skip-graphify)");
  else if (!graphify && !dryRun) record("graphify install", false, "graphify isn't installed; re-run after installing it");
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
    runStep(root, "impeccable install", "npx", ["-y", "impeccable", "install", "--project", `--providers=${providers}`]);
    // Impeccable merges its own hooks into .codex/hooks.json; make sure ours survived.
    mergeHooks(root, graphify, " (after Impeccable)");
  }

  if (!dryRun && results.every((r) => r.ok !== false)) {
    const manifest = { version: pluginVersion, files: ownedPaths, hooks: hookCommandsInstalled, managed };
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
  const manifest = readJson(path.join(root, MANIFEST));
  if (!manifest && readText(path.join(root, ".codex", "autopilot.js")) === null) return; // not a workflow project
  // A teammate on a newer plugin already upgraded this project; don't take it back.
  if (manifest?.version && compareVersions(manifest.version, pluginVersion) > 0) return;
  setupProject(root, "", false);
  const failed = results.filter((r) => r.ok === false);
  const files = changed.filter((file) => file !== MANIFEST);
  if (files.length) {
    console.log(
      `claude-codex-workflow v${pluginVersion}: synced ${files.length} project file(s) (${files.join(", ")}). ` +
        "Restart Codex and re-read CLAUDE.md/AGENTS.md so the updated workflow applies.",
    );
  }
  for (const r of failed) console.log(`claude-codex-workflow sync: ${r.step}: ${r.note}`);
}

async function main() {
  if (sync) {
    try {
      syncProject();
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
  1. Open the project in Codex and trust .codex/hooks.json (Codex asks on first run, or use /hooks).
  2. Codex runs the verify step (headless Claude) from its own session. Let those commands use the
     network and a long timeout (30 min); approve them when Codex asks to run outside the sandbox.
  3. Build the first graph: /graphify . in Claude Code (needs some code first).
${impeccable ? `  4. /impeccable init in Claude Code writes PRODUCT.md. In an existing project, follow with
     /impeccable document to capture DESIGN.md.` : `  4. Impeccable (design skills, optional) wasn't installed. For UI-heavy work, re-run with --impeccable.`}
  5. If the detected checks above are wrong or empty, add .codex/verify.json.
  6. Restart Claude and Codex, and check /mcp for Playwright (unless skipped). Start your app
     before asking either agent to inspect it. Browser checks must be requested in the plan.
Then plan a task with Claude, and paste the one line it ends with into Codex: Execute plans/<task>.md`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
