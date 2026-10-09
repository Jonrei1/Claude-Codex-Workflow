/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Shared by claude-verify.js, autopilot.js and claude-plan-gate.js.
//
// Everything the workflow writes is local to this clone: plans in .codex/plans/, verify logs
// in .codex/verify/<task>/, task summaries in .codex/tasks/. The installer hides them through
// .git/info/exclude, so nothing shows up in `git status` for the user or their teammates.
//
// Plans follow .codex/plans/_template.md: YAML-ish frontmatter, `## Acceptance` items with
// ids (A1, A2...), then `## Phase <N>: <title>` sections with Scope, Steps, Covers, Done when,
// Hands off and a **Gate** list of backticked commands. planChecklist() checks all of it.
//
// Agents never commit, so progress is tracked with snapshots: the git tree of the whole
// working tree (tracked and untracked, ignore rules respected), written through a
// temporary index. A snapshot is a tree object, not a commit; it's on no branch and is
// never pushed. Diffing two snapshots shows exactly what a phase changed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const isWindows = process.platform === "win32";
const git = isWindows ? "git.exe" : "git";

// Workflow locations, relative to the repo root.
const plansRel = ".codex/plans";
const tasksRel = ".codex/tasks";
const verifyRel = ".codex/verify";
const codexRulesRel = ".codex/workflow/CODEX.md";
const planPattern = /^\.codex\/plans\/[^/]+\.md$/;

// Changes under these paths are workflow state, not part of any phase.
const workflowPaths = [":!plans", ":!.codex", ":!.claude", ":!.agents/skills/caveman", ":!.impeccable", ":!graphify-out", ":!CLAUDE.local.md"];
// Changes under these never trigger a verification run on their own.
const triggerIgnored = [...workflowPaths, ":!*.md"];

function gitRun(repoRoot, args, env) {
  return spawnSync(git, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: env || process.env,
  });
}

function gitOut(repoRoot, args, env) {
  const result = gitRun(repoRoot, args, env);
  return result.status === 0 ? result.stdout.trim() : "";
}

function treeExists(repoRoot, tree) {
  return Boolean(tree) && gitRun(repoRoot, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;
}

// Tree of the current working tree, without touching the real index.
function snapshot(repoRoot) {
  const realIndex = path.resolve(repoRoot, gitOut(repoRoot, ["rev-parse", "--git-path", "index"]));
  const tempIndex = `${realIndex}.snapshot-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const added = gitRun(repoRoot, ["add", "-A", "--", "."], env);
    if (added.status !== 0) throw new Error(`git add (snapshot) failed: ${added.stderr.trim()}`);
    const tree = gitOut(repoRoot, ["write-tree"], env);
    if (!tree) throw new Error("git write-tree (snapshot) failed");
    return tree;
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
}

function headTree(repoRoot) {
  return gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
}

function changedFiles(repoRoot, from, to, pathspec = triggerIgnored) {
  return gitOut(repoRoot, ["diff", "--name-only", from, to, "--", ".", ...pathspec]).split("\n").filter(Boolean);
}

function diffText(repoRoot, from, to, pathspec = workflowPaths) {
  return gitOut(repoRoot, ["diff", from, to, "--", ".", ...pathspec]);
}

// Per-task verify logs: .codex/verify/<slug>/. Reports without a task go to _untasked/.
function taskVerifyDir(repoRoot, slug) {
  return path.join(repoRoot, ".codex", "verify", slug || "_untasked");
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function verifyConfig(repoRoot) {
  return readJsonFile(path.join(repoRoot, ".codex", "verify.json")) || {};
}

// ---- Plans -------------------------------------------------------------------------------

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

function isPlaceholder(value) {
  return !value || /<[^>]*>/.test(value);
}

// The text after a bold label such as **Scope:** up to the next bold label, or null.
function labelBlock(body, label) {
  const match = new RegExp(`\\*\\*${label}[^*\\n]*\\*\\*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)`, "i").exec(body);
  return match ? match[1].trim() : null;
}

// Phases in document order: { id, title, body, gates, commit, scope, steps, covers,
// doneWhen, handsOff, uiAudit }. The first backticked span on each bullet under **Gate** is
// a command. `commit` is the optional suggested commit message for the user.
function parsePhases(text) {
  const headings = [...text.matchAll(/^## Phase ([\w.]+):\s*(.+)$/gm)];
  return headings.map((heading, i) => {
    const start = heading.index + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : nextH2(text, start);
    const body = text.slice(start, end);
    const gates = [];
    const gateBlock = /\*\*Gate[^\n]*\n([\s\S]*?)(?=\n\*\*|\n## |$)/.exec(body);
    if (gateBlock) {
      for (const line of gateBlock[1].split(/\r?\n/)) {
        const command = /^\s*[-*]\s*`([^`]+)`/.exec(line);
        if (command) gates.push(command[1].trim());
      }
    }
    const commit = /\*\*(?:Suggested )?[Cc]ommit[^*]*:\*\*\s*`([^`]+)`/.exec(body);
    const covers = labelBlock(body, "Covers");
    return {
      id: heading[1],
      title: heading[2].trim(),
      body,
      gates,
      commit: commit ? commit[1].trim() : "",
      scope: labelBlock(body, "Scope"),
      steps: labelBlock(body, "Steps"),
      covers: covers === null ? null : [...covers.matchAll(/\bA\d+\b/g)].map((m) => m[0]),
      doneWhen: labelBlock(body, "Done when"),
      handsOff: labelBlock(body, "Hands off"),
      uiAudit: labelBlock(body, "UI audit"),
    };
  });
}

function nextH2(text, from) {
  const match = /^## (?!Phase )/m.exec(text.slice(from));
  return match ? from + match.index : text.length;
}

function section(text, heading) {
  const match = new RegExp(`^## ${heading}\\s*$`, "mi").exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## /m.exec(text.slice(start));
  return text.slice(start, next ? start + next.index : text.length).trim();
}

// Acceptance items with ids: `- A1: ...`.
function acceptanceIds(text) {
  const body = section(text, "Acceptance") || "";
  return [...body.matchAll(/^\s*[-*]\s*\**(A\d+)\**\s*[:.)-]/gm)].map((m) => m[1]);
}

// The plan's `## UI audit` section: start command, URL, viewports and checks.
function uiAuditSpec(text) {
  const body = section(text, "UI audit");
  if (body === null) return null;
  const value = (name) => {
    const match = new RegExp(`^\\s*[-*]\\s*${name}:\\s*(.+)$`, "mi").exec(body);
    return match ? match[1].replace(/`/g, "").trim() : "";
  };
  const checksAt = /^\s*[-*]\s*Checks:\s*$/im.exec(body);
  const checks = checksAt
    ? body.slice(checksAt.index + checksAt[0].length).split(/\r?\n/).map((line) => /^\s+[-*]\s*(.+)$/.exec(line)).filter(Boolean).map((m) => m[1].trim())
    : [];
  const viewports = value("Viewports").split(/[,\s]+/).map(Number).filter((n) => n > 0);
  return { body, start: value("Start"), url: value("URL"), viewports, checks };
}

// Effective UI settings: the plan's ## UI audit section wins over .codex/verify.json "ui".
function uiSettings(repoRoot, text) {
  const config = verifyConfig(repoRoot).ui || {};
  const spec = (text && uiAuditSpec(text)) || {};
  return {
    startCommand: (!isPlaceholder(spec.start) && spec.start) || config.startCommand || "",
    url: (!isPlaceholder(spec.url) && spec.url) || config.url || "",
    viewports: (spec.viewports && spec.viewports.length ? spec.viewports : config.viewports) || [375, 1280],
    readyTimeoutSec: config.readyTimeoutSec || 90,
    paths: Array.isArray(config.paths) ? config.paths : [],
    checks: spec.checks || [],
  };
}

const shellBuiltins = new Set(["cd", "echo", "test", "[", "true", "false", "exit", "set", "export", "env", "call", "if", "for"]);
const packageManagerCommands = new Set(["exec", "dlx", "install", "i", "add", "remove", "why", "list", "ls", "create", "x"]);

function onPath(command) {
  if (/[\\/]/.test(command)) return fs.existsSync(command);
  const exts = isWindows ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, command + ext))) return true;
    }
  }
  return false;
}

// Why a gate can't run here, or "" when it looks runnable. Checks each command in a chain:
// package scripts must exist in package.json, other programs must be on PATH or in
// node_modules/.bin.
function gateProblem(repoRoot, gate) {
  const pkg = readJsonFile(path.join(repoRoot, "package.json"));
  const scripts = (pkg && pkg.scripts) || {};
  const localBin = (name) => fs.existsSync(path.join(repoRoot, "node_modules", ".bin", name)) || (isWindows && fs.existsSync(path.join(repoRoot, "node_modules", ".bin", `${name}.cmd`)));
  for (const part of gate.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter((word) => !/^\w+=/.test(word));
    if (!words.length) continue;
    const [program, first, second] = words;
    if (shellBuiltins.has(program)) continue;
    let script = "";
    if (["npm", "bun"].includes(program) && ["run", "run-script"].includes(first)) script = second;
    else if (program === "npm" && ["test", "t"].includes(first)) script = "test";
    else if (["pnpm", "yarn"].includes(program) && first === "run") script = second;
    else if (["pnpm", "yarn"].includes(program) && first && !first.startsWith("-") && !packageManagerCommands.has(first)) {
      if (!scripts[first] && !localBin(first)) return `\`${part.trim()}\`: no "${first}" script in package.json`;
      continue;
    }
    if (script !== "") {
      if (!script || !scripts[script]) return `\`${part.trim()}\`: no "${script || "?"}" script in package.json`;
      continue;
    }
    if (!onPath(program) && !localBin(program) && !fs.existsSync(path.join(repoRoot, program))) {
      return `\`${part.trim()}\`: \`${program}\` isn't on PATH`;
    }
  }
  return "";
}

// The planning checklist: [{ ok, item, detail }]. A plan is handed off only when every
// item is ok, so each phase ties into the next and the handoff carries everything Codex
// and the reviewers need.
function planChecklist(repoRoot, slug, text) {
  const meta = frontmatter(text);
  const phases = parsePhases(text);
  const items = [];
  const add = (ok, item, detail = "") => items.push({ ok, item, detail });

  add(Boolean(meta.task) && !isPlaceholder(meta.task) && meta.task === slug, "frontmatter task matches the file name", meta.task === slug ? "" : `task: ${meta.task || "(missing)"}, file: ${slug}`);
  add(["normal", "high"].includes(meta.risk), "frontmatter risk is normal or high", meta.risk || "(missing)");
  add(["none", "codex"].includes(meta.review || "none"), "frontmatter review is none or codex", meta.review || "");
  add(["yes", "no"].includes(meta.ui), "frontmatter ui is yes or no", meta.ui || "(missing)");
  add(phases.length > 0, "has `## Phase <N>: <title>` sections");

  const ids = acceptanceIds(text);
  add(ids.length > 0, "acceptance items have ids (`- A1: ...`)");
  const covered = new Set(phases.flatMap((phase) => phase.covers || []));
  const uncovered = ids.filter((id) => !covered.has(id));
  add(uncovered.length === 0, "every acceptance item is covered by a phase", uncovered.join(", "));
  const unknown = [...covered].filter((id) => !ids.includes(id));
  add(unknown.length === 0, "every **Covers:** id exists under Acceptance", unknown.join(", "));

  phases.forEach((phase, index) => {
    const label = `Phase ${phase.id}`;
    const filled = (value) => value !== null && !isPlaceholder(value) && value.replace(/[.\s]/g, "") !== "";
    add(!isPlaceholder(phase.title), `${label}: title`);
    add(filled(phase.scope), `${label}: **Scope:**`);
    add(filled(phase.steps), `${label}: **Steps:**`);
    add(phase.covers !== null && phase.covers.length > 0, `${label}: **Covers:** acceptance ids`);
    add(filled(phase.doneWhen), `${label}: **Done when:**`);
    if (index < phases.length - 1) add(filled(phase.handsOff), `${label}: **Hands off:** (what phase ${phases[index + 1].id} relies on)`);
    add(phase.gates.length > 0, `${label}: gate command`);
    for (const gate of phase.gates) {
      if (isPlaceholder(gate)) {
        add(false, `${label}: gate is runnable`, `\`${gate}\` is a placeholder`);
      } else {
        const problem = gateProblem(repoRoot, gate);
        add(!problem, `${label}: gate is runnable`, problem);
      }
    }
  });

  if (meta.ui === "yes") {
    const spec = uiAuditSpec(text);
    const ui = uiSettings(repoRoot, text);
    add(spec !== null, "ui: yes has a `## UI audit` section");
    add(Boolean(ui.url), "UI audit URL (plan `- URL:` or verify.json ui.url)");
    add(Boolean(ui.startCommand), "UI audit start command (plan `- Start:` or verify.json ui.startCommand)");
    add(Boolean(spec && spec.checks.length), "UI audit has `- Checks:` items");
    add(phases.some((phase) => phase.uiAudit && !isPlaceholder(phase.uiAudit)), "at least one phase has a **UI audit:** block");
  }
  return items;
}

// Problems that stop autopilot before it starts.
function planProblems(repoRoot, slug, text) {
  return planChecklist(repoRoot, slug, text)
    .filter((item) => !item.ok)
    .map((item) => (item.detail ? `${item.item}: ${item.detail}` : item.item));
}

// ---- Headless Claude calls -------------------------------------------------------------
//
// Every headless call goes through runClaude / runClaudeAsync, so all of them get the same
// trimmed setup and the same usage record. Listing only the built-in tools a call needs
// (--tools) cuts its fixed input from about 37k to 14k tokens, and --strict-mcp-config keeps
// MCP tool schemas out unless the call passes its own --mcp-config (the UI audit's
// Playwright server). Each call is appended to .codex/verify/usage.jsonl.
//
// Optional .codex/verify.json block:
//   "headless": { "settingSources": "project,local" }
// Passes --setting-sources, which skips user-level settings, plugins and hooks. It is opt-in:
// user settings can carry authentication or proxy environment, which would stop applying.

function headlessConfig(repoRoot) {
  return verifyConfig(repoRoot).headless || {};
}

function usagePath(repoRoot) {
  return path.join(repoRoot, ".codex", "verify", "usage.jsonl");
}

// `allowed` holds permission patterns such as `Bash(npm test:*)`; the built-in tool a call
// needs is the name before the parenthesis. MCP tools come from --mcp-config instead.
function builtinTools(allowed) {
  return [...new Set(allowed.filter((pattern) => !pattern.startsWith("mcp__")).map((pattern) => pattern.replace(/\(.*$/, "")))];
}

function usageRecord(name, task, model, effort, parsed, ok) {
  const usage = (parsed && parsed.usage) || {};
  return {
    time: new Date().toISOString(),
    task: task || "",
    name,
    model,
    effort,
    ok,
    inputTokens: usage.input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    turns: (parsed && parsed.num_turns) || 0,
    costUsd: (parsed && parsed.total_cost_usd) || 0,
    durationMs: (parsed && parsed.duration_ms) || 0,
  };
}

// On Windows an npm install puts only claude.cmd on PATH, and spawn can't start a .cmd
// without a shell (which would mangle the prompt). Find the executable the shim points to.
let claudeCommand;
function resolveClaude() {
  if (claudeCommand) return claudeCommand;
  claudeCommand = { command: "claude", prefix: [] };
  if (!isWindows) return claudeCommand;
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, "claude.exe");
    if (fs.existsSync(exe)) return (claudeCommand = { command: exe, prefix: [] });
    const shim = path.join(dir, "claude.cmd");
    if (!fs.existsSync(shim)) continue;
    const target = /"%dp0%\\([^"]+\.(?:exe|c?js))"/i.exec(fs.readFileSync(shim, "utf8"));
    const resolved = target && path.join(dir, target[1]);
    if (resolved && fs.existsSync(resolved)) {
      return (claudeCommand = /\.exe$/i.test(resolved) ? { command: resolved, prefix: [] } : { command: process.execPath, prefix: [resolved] });
    }
  }
  return claudeCommand;
}

function claudeArgs(repoRoot, { prompt, model, effort, allowed, denied = [], permissionMode, mcpConfig }) {
  const claude = resolveClaude();
  const args = [
    ...claude.prefix,
    "-p", prompt,
    "--model", model,
    "--effort", effort,
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", builtinTools(allowed).join(","),
  ];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  const { settingSources } = headlessConfig(repoRoot);
  if (settingSources) args.push("--setting-sources", String(settingSources));
  // The variadic flags go last so they can't swallow another option.
  args.push("--allowedTools", ...allowed);
  if (denied.length) args.push("--disallowedTools", ...denied);
  return { command: claude.command, args };
}

function finishClaude(repoRoot, options, result) {
  const stdout = (result.stdout || "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const text = parsed && typeof parsed.result === "string" ? parsed.result.trim() : stdout;
  const ok = !result.error && result.status === 0 && !(parsed && parsed.is_error);
  try {
    fs.mkdirSync(path.dirname(usagePath(repoRoot)), { recursive: true });
    fs.appendFileSync(usagePath(repoRoot), `${JSON.stringify(usageRecord(options.name, options.task, options.model, options.effort, parsed, ok))}\n`);
  } catch {
    // Usage logging must never fail a run.
  }
  return { status: result.status, error: result.error, text, stderr: (result.stderr || "").trim() };
}

// Runs `claude -p` and returns { status, error, text, stderr }. `text` is the model's final
// reply, taken from the JSON result; if the output isn't JSON, it falls back to raw stdout.
function runClaude(repoRoot, options) {
  const { command, args } = claudeArgs(repoRoot, options);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
  return finishClaude(repoRoot, options, result);
}

// The same call without blocking, so independent review steps can run side by side.
function runClaudeAsync(repoRoot, options) {
  const { command, args } = claudeArgs(repoRoot, options);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finishClaude(repoRoot, options, { stdout, stderr, ...result }));
    };
    let child;
    try {
      child = spawn(command, args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.env ? { env: options.env } : {}) });
    } catch (error) {
      done({ status: null, error });
      return;
    }
    const timer = options.timeout
      ? setTimeout(() => {
          child.kill();
          done({ status: null, error: Object.assign(new Error(`timed out after ${options.timeout} ms`), { code: "ETIMEDOUT" }) });
        }, options.timeout)
      : null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done({ status: null, error }));
    child.on("close", (status) => done({ status }));
  });
}

// Runs a shell command without blocking: { cmd, ok, status, output }.
function runShellAsync(repoRoot, cmd, { timeout, env } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(cmd, { cwd: repoRoot, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    const finish = (ok, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ cmd, ok, status, output: output.trim() });
    };
    const timer = timeout ? setTimeout(() => { killTree(child.pid); finish(false, "timed out"); }, timeout) : null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code) => finish(code === 0, `exit ${code}`));
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWindows) spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

// Sums .codex/verify/usage.jsonl, optionally for one task, grouped by step name.
function usageSummary(repoRoot, task) {
  let lines = [];
  try {
    lines = fs.readFileSync(usagePath(repoRoot), "utf8").split("\n").filter(Boolean);
  } catch {
    return "No usage recorded yet (.codex/verify/usage.jsonl).";
  }
  const rows = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const picked = task ? rows.filter((row) => row.task === task) : rows;
  if (picked.length === 0) return task ? `No usage recorded for ${task}.` : "No usage recorded yet.";
  const groups = new Map();
  for (const row of picked) {
    const key = `${row.name.replace(/\d+/g, "N")} (${row.model}/${row.effort})`;
    const sum = groups.get(key) || { calls: 0, input: 0, output: 0, cost: 0, failed: 0 };
    sum.calls += 1;
    sum.input += row.inputTokens + row.cacheCreationTokens + row.cacheReadTokens;
    sum.output += row.outputTokens;
    sum.cost += row.costUsd;
    sum.failed += row.ok ? 0 : 1;
    groups.set(key, sum);
  }
  const out = [task ? `Headless Claude usage for ${task}` : "Headless Claude usage, all tasks", ""];
  let total = { calls: 0, input: 0, output: 0, cost: 0 };
  for (const [key, sum] of groups) {
    out.push(`${key}: ${sum.calls} call(s), ${sum.input} input, ${sum.output} output tokens, $${sum.cost.toFixed(4)}${sum.failed ? `, ${sum.failed} failed` : ""}`);
    total = { calls: total.calls + sum.calls, input: total.input + sum.input, output: total.output + sum.output, cost: total.cost + sum.cost };
  }
  out.push("", `Total: ${total.calls} call(s), ${total.input} input, ${total.output} output tokens, $${total.cost.toFixed(4)} (API list price; not a subscription invoice)`);
  out.push("Input counts fresh, cache-written and cache-read tokens together. Codex usage is not included.");
  return out.join("\n");
}

// ---- Codex sessions ----------------------------------------------------------------------
//
// Every Codex TUI (terminal or IDE) runs its threads on the shared local app-server daemon,
// and `codex queue` posts into a thread through it. The daemon is also the only place that
// knows which sessions are open right now: a session gets no rollout file or state row until
// its first message. So the handoff asks the daemon, over `codex app-server proxy` (stdio
// relayed to the control socket, which speaks JSON-RPC over WebSocket), for its loaded
// threads and picks the newest one whose cwd is this repo.

// One WebSocket frame. Client frames are masked; server frames aren't.
function encodeFrame(text, { mask = true } = {}) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x81;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  return Buffer.concat([header, key, Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]))]);
}

// Splits complete frames off the front of buffer: { frames: [{ opcode, text }], rest }.
function decodeFrames(buffer) {
  const frames = [];
  for (;;) {
    if (buffer.length < 2) break;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const keyLength = masked ? 4 : 0;
    if (buffer.length < offset + keyLength + length) break;
    const key = buffer.subarray(offset, offset + keyLength);
    let payload = buffer.subarray(offset + keyLength, offset + keyLength + length);
    if (masked) payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]));
    frames.push({ opcode: buffer[0] & 0x0f, text: payload.toString("utf8") });
    buffer = buffer.subarray(offset + keyLength + length);
  }
  return { frames, rest: buffer };
}

// Runs JSON-RPC calls against the app-server daemon in order. Resolves to { results } (one
// per call; a call's error lands as { error }) or { error } when the daemon can't be reached.
function codexAppServer(calls, { timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(isWindows ? "codex app-server proxy" : "codex", isWindows ? [] : ["app-server", "proxy"], {
        shell: isWindows,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    let settled = false;
    let stderr = "";
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let nextId = 0;
    const pending = new Map();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const reject of pending.values()) reject(new Error("closed"));
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: `no answer from the Codex app-server within ${timeoutMs / 1000}s` }), timeoutMs);
    const send = (message) => child.stdin.write(encodeFrame(JSON.stringify(message)));
    const request = (method, params) =>
      new Promise((resolveCall, rejectCall) => {
        const id = ++nextId;
        pending.set(id, rejectCall);
        pending.set(`ok:${id}`, resolveCall);
        send({ id, method, params });
      });
    const onMessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id === undefined || !pending.has(`ok:${message.id}`)) return;
      const resolveCall = pending.get(`ok:${message.id}`);
      pending.delete(message.id);
      pending.delete(`ok:${message.id}`);
      resolveCall(message);
    };
    const run = async () => {
      try {
        const init = await request("initialize", { clientInfo: { name: "claude-codex-workflow", version: "1" } });
        if (init.error) return finish({ error: `initialize failed: ${init.error.message || JSON.stringify(init.error)}` });
        send({ method: "initialized" });
        const results = [];
        for (const call of calls) {
          const reply = await request(call.method, call.params || {});
          results.push(reply.error ? { error: reply.error.message || JSON.stringify(reply.error) } : reply.result);
        }
        finish({ results });
      } catch {
        finish({ error: "the Codex app-server closed the connection" });
      }
    };
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code) => finish({ error: `codex app-server proxy exited with ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ""}` }));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const status = buffer.subarray(0, end).toString("utf8").split("\r\n")[0];
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101\b/.test(status)) return finish({ error: `the Codex app-server refused the connection (${status})` });
        upgraded = true;
        run();
      }
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) if (frame.opcode === 1) onMessage(frame.text);
    });
    const key = crypto.randomBytes(16).toString("base64");
    child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

// Threads loaded in the daemon right now: { threads } or { error }.
async function liveCodexThreads(options = {}) {
  const list = await codexAppServer([{ method: "thread/loaded/list" }], options);
  if (list.error) return { error: list.error };
  const ids = (list.results[0] && list.results[0].data) || [];
  if (!ids.length) return { threads: [] };
  const read = await codexAppServer(ids.map((threadId) => ({ method: "thread/read", params: { threadId, includeTurns: false } })), options);
  if (read.error) return { error: read.error };
  const threads = read.results.map((result) => result && result.thread).filter(Boolean);
  return { threads };
}

function samePath(a, b) {
  const normal = (p) => path.resolve(String(p).replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
  return isWindows ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

// The user's own sessions in repoRoot, newest first. Skips headless `codex exec` runs,
// subagents and Codex's side threads (titles and the like are ephemeral, threadSource
// other than "user").
function pickCodexSession(threads, repoRoot) {
  const matches = (threads || [])
    .filter((thread) => thread && thread.id && thread.cwd && samePath(thread.cwd, repoRoot))
    .filter((thread) => thread.source !== "exec" && !thread.parentThreadId && !thread.ephemeral)
    .filter((thread) => !thread.threadSource || thread.threadSource === "user")
    .map((thread) => ({
      id: thread.id,
      cwd: thread.cwd,
      source: thread.source || "",
      status: (thread.status && thread.status.type) || "",
      name: thread.name || "",
      at: thread.recencyAt || thread.updatedAt || thread.createdAt || 0,
    }))
    .sort((a, b) => b.at - a.at);
  return { session: matches[0] || null, others: matches.slice(1) };
}

// The open Codex session for repoRoot: { session, others } or { session: null, error }.
async function findCodexSession(repoRoot, options = {}) {
  const live = await liveCodexThreads(options);
  if (live.error) return { session: null, others: [], error: live.error };
  return pickCodexSession(live.threads, repoRoot);
}

// ---- Playwright --------------------------------------------------------------------------

// Use the MCP package's Playwright dependency so the downloaded browser matches it.
function resolvePlaywright(globalRoot) {
  const packageFile = path.join(globalRoot, "@playwright", "mcp", "package.json");
  const requireMcp = createRequire(packageFile);
  const pkg = requireMcp(packageFile);
  const playwright = requireMcp("playwright");
  return {
    version: pkg.version,
    server: path.join(path.dirname(packageFile), pkg.bin["playwright-mcp"]),
    cli: path.join(path.dirname(requireMcp.resolve("playwright/package.json")), "cli.js"),
    browser: playwright.chromium.executablePath(),
  };
}

// The Playwright MCP server config for a headless Claude call, or null when the global
// @playwright/mcp package or its browser is missing.
function playwrightMcpConfig(outputDir) {
  const npm = spawnSync("npm root -g", { encoding: "utf8", windowsHide: true, shell: true, timeout: 60 * 1000 });
  const root = (npm.stdout || "").trim();
  if (npm.status !== 0 || !root) return null;
  let installed;
  try {
    installed = resolvePlaywright(root);
  } catch {
    return null;
  }
  if (!fs.existsSync(installed.browser)) return null;
  return {
    mcpServers: {
      playwright: {
        command: process.execPath,
        args: [installed.server, "--executable-path", installed.browser, "--headless", "--isolated", "--output-dir", outputDir],
      },
    },
  };
}

module.exports = {
  plansRel,
  tasksRel,
  verifyRel,
  codexRulesRel,
  planPattern,
  runClaude,
  runClaudeAsync,
  runShellAsync,
  killTree,
  usageSummary,
  workflowPaths,
  triggerIgnored,
  gitRun,
  gitOut,
  treeExists,
  snapshot,
  headTree,
  changedFiles,
  diffText,
  taskVerifyDir,
  readJsonFile,
  verifyConfig,
  frontmatter,
  isPlaceholder,
  parsePhases,
  acceptanceIds,
  uiAuditSpec,
  uiSettings,
  gateProblem,
  planChecklist,
  planProblems,
  encodeFrame,
  decodeFrames,
  codexAppServer,
  liveCodexThreads,
  pickCodexSession,
  findCodexSession,
  resolvePlaywright,
  playwrightMcpConfig,
};
