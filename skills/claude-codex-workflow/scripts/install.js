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
// under .codex/ belong to the workflow and are updated on every run, so re-running the
// installer upgrades a project. It never commits.
//
// Flags:
//   --yes                       approve missing global tools and Playwright setup (not Impeccable)
//   --tools-only | --project-only
//   --dry-run                   print what would happen, change nothing
//   --update-sections           replace existing ## Workflow / ## Codex execution sections
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
const templates = path.join(__dirname, "..", "templates");
const results = [];

function record(step, ok, note = "") {
  results.push({ step, ok, note });
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  record(step, true, note);
}

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

// Files the user may customize: only created when missing.
function copyIfMissing(root, from, to) {
  if (readText(path.join(root, to)) !== null) return record(to, true, "exists, kept");
  write(path.join(root, to), fs.readFileSync(path.join(templates, from), "utf8"), to, "created");
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

// Appends the template's section, or replaces it with --update-sections.
function mergeSection(root, file, section, heading) {
  const target = path.join(root, file);
  const text = readText(target);
  const body = section.trim() + "\n";
  if (text === null) return write(target, body, file, `created with the ${heading} section`);
  const range = sectionRange(text, heading);
  if (!range) return write(target, `${text.trimEnd()}\n\n${body}`, file, `appended the ${heading} section`);
  if (text.slice(range.start, range.end).trim() === section.trim()) return record(file, true, `${heading} is up to date`);
  if (!flag("--update-sections")) {
    return record(file, true, `${heading} exists and differs from the plugin's; re-run with --update-sections to replace it`);
  }
  const updated = `${text.slice(0, range.start)}${body}${range.end < text.length ? "\n" : ""}${text.slice(range.end)}`;
  write(target, updated, file, `replaced the ${heading} section`);
}

function hookCommands(group) {
  return (group.hooks || []).map((hook) => hook.command);
}

// Adds each template hook group whose command isn't in .codex/hooks.json yet.
function mergeHooks(root, graphify, label) {
  const file = path.join(root, ".codex", "hooks.json");
  let template = fs.readFileSync(path.join(templates, "codex", "hooks.json"), "utf8");
  if (graphify && graphify !== "graphify") template = template.replace(/"graphify hook-guard/g, `"${graphify} hook-guard`);
  const wanted = JSON.parse(template);
  const text = readText(file);
  let config;
  try {
    config = text === null ? { description: wanted.description, hooks: {} } : JSON.parse(text);
  } catch {
    return record(`.codex/hooks.json${label}`, false, "isn't valid JSON; merge templates/codex/hooks.json by hand");
  }
  config.hooks = config.hooks || {};
  let repaired = 0;
  const impeccableWindows = 'cmd.exe /d /c "if exist .agents\\skills\\impeccable\\scripts\\impeccable.cmd .agents\\skills\\impeccable\\scripts\\impeccable.cmd hook"';
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type !== "command") continue;
        const commands = [hook.command, hook.commandWindows];
        if (!commands.some((command) => typeof command === "string" && /\.agents\/skills\/impeccable\/scripts\/impeccable(?:\.cmd)?["']?\s+hook\b/.test(command.replace(/\\/g, "/")))) continue;
        if (hook.commandWindows === impeccableWindows) continue;
        hook.commandWindows = impeccableWindows;
        repaired++;
      }
    }
  }
  let added = 0;
  for (const [event, groups] of Object.entries(wanted.hooks)) {
    const existing = (config.hooks[event] = config.hooks[event] || []);
    const present = new Set(existing.flatMap(hookCommands));
    for (const group of groups) {
      if (hookCommands(group).every((command) => present.has(command))) continue;
      existing.push(group);
      added++;
    }
  }
  if (!added && !repaired) return record(`.codex/hooks.json${label}`, true, "verify and graphify hooks present");
  write(file, JSON.stringify(config, null, 2) + "\n", `.codex/hooks.json${label}`, `added ${added} hook group(s), repaired ${repaired} Impeccable Windows hook(s); trust them again in Codex (/hooks)`);
}

function updateGitignore(root) {
  const file = path.join(root, ".gitignore");
  const text = readText(file) || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const wanted = [".codex/verify/", ".codex/autopilot/", "graphify-out/", "plans/*", "!plans/_template.md"];
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

function setupProject(root, graphify, impeccable) {
  console.log(`\nProject: ${root}`);
  for (const file of ["codex/hooks/claude-verify.js", "codex/hooks/workflow-lib.js", "codex/autopilot.js"]) {
    copyOwned(root, file, `.${file}`);
  }
  copyIfMissing(root, "plans/_template.md", "plans/_template.md");
  copyIfMissing(root, "skills/caveman/SKILL.md", ".claude/skills/caveman/SKILL.md");
  copyIfMissing(root, "skills/caveman/SKILL.md", ".agents/skills/caveman/SKILL.md");
  if (readText(path.join(root, "docs", "tasks", ".gitkeep")) === null) write(path.join(root, "docs", "tasks", ".gitkeep"), "", "docs/tasks/.gitkeep", "created");

  const claudeSection = fs.readFileSync(path.join(templates, "CLAUDE.workflow.md"), "utf8");
  const agentsSection = fs.readFileSync(path.join(templates, "AGENTS.codex.md"), "utf8").split("<!--")[0];
  mergeSection(root, "CLAUDE.md", claudeSection, "## Workflow");
  mergeSection(root, "AGENTS.md", agentsSection, "## Codex execution");
  mergeHooks(root, graphify, "");
  updateGitignore(root);

  if (flag("--skip-graphify")) record("graphify install", null, "skipped (--skip-graphify)");
  else if (!graphify && !dryRun) record("graphify install", false, "graphify isn't installed; re-run after installing it");
  else {
    runStep(root, "graphify claude install", graphify || "graphify", ["claude", "install"]);
    runStep(root, "graphify codex install", graphify || "graphify", ["codex", "install"]);
    ensureGraphifyRule(root, "CLAUDE.md");
    ensureGraphifyRule(root, "AGENTS.md");
  }

  if (!impeccable) {
    record("impeccable install", null, flag("--skip-impeccable") ? "skipped (--skip-impeccable)" : "skipped (optional; re-run with --impeccable to add it)");
  } else {
    const providers = flagValue("--impeccable-providers") || "claude,codex";
    runStep(root, "impeccable install", "npx", ["-y", "impeccable", "install", "--project", `--providers=${providers}`]);
    // Impeccable merges its own hooks into .codex/hooks.json; make sure ours survived.
    mergeHooks(root, graphify, " (after Impeccable)");
  }

  if (!dryRun) {
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

async function main() {
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
