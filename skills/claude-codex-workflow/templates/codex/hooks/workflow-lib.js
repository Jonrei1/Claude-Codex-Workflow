/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Shared by claude-verify.js and autopilot.js.
//
// Plans follow plans/_template.md: YAML-ish frontmatter, then `## Phase <N>: <title>`
// sections with a **Gate** list of backticked commands.
//
// Agents never commit, so progress is tracked with snapshots: the git tree of the whole
// working tree (tracked and untracked, .gitignore respected), written through a
// temporary index. A snapshot is a tree object, not a commit; it's on no branch and is
// never pushed. Diffing two snapshots shows exactly what a phase changed.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const git = process.platform === "win32" ? "git.exe" : "git";

// Changes under these paths are workflow state, not part of any phase.
const workflowPaths = [":!plans", ":!.codex", ":!.claude", ":!.impeccable", ":!graphify-out"];
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
  const tempIndex = `${realIndex}.snapshot-${process.pid}`;
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

// Phases in document order: { id, title, body, gates: [command], commit }.
// The first backticked span on each bullet under **Gate** is a command. `commit` is the
// optional suggested commit message for the user.
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
    return { id: heading[1], title: heading[2].trim(), body, gates, commit: commit ? commit[1].trim() : "" };
  });
}

function nextH2(text, from) {
  const match = /^## (?!Phase )/m.exec(text.slice(from));
  return match ? from + match.index : text.length;
}

// Problems that stop autopilot before it starts: no phases, placeholders, missing gates.
function planProblems(slug, meta, phases) {
  const problems = [];
  if (phases.length === 0) problems.push("no `## Phase <N>: <title>` sections");
  for (const phase of phases) {
    const label = `Phase ${phase.id}`;
    if (isPlaceholder(phase.title)) problems.push(`${label}: title is a placeholder`);
    if (phase.gates.length === 0) problems.push(`${label}: no gate command`);
    for (const gate of phase.gates) {
      if (isPlaceholder(gate)) problems.push(`${label}: gate \`${gate}\` is a placeholder`);
    }
  }
  if (meta.task && !isPlaceholder(meta.task) && meta.task !== slug) {
    problems.push(`frontmatter task \`${meta.task}\` doesn't match the file name \`${slug}\``);
  }
  return problems;
}

// ---- Headless Claude calls -------------------------------------------------------------
//
// Every headless call goes through runClaude, so all of them get the same trimmed setup and
// the same usage record. Measured on a trivial prompt: listing only the built-in tools a call
// needs (--tools) cuts its fixed input from about 37k to 14k tokens, and --strict-mcp-config
// keeps MCP tool schemas out. Each call is appended to .codex/verify/usage.jsonl.
//
// Optional .codex/verify.json block:
//   "headless": { "settingSources": "project,local" }
// Passes --setting-sources, which skips user-level settings, plugins and hooks. It is opt-in:
// user settings can carry authentication or proxy environment, which would stop applying.

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function headlessConfig(repoRoot) {
  const config = readJsonFile(path.join(repoRoot, ".codex", "verify.json"));
  return (config && config.headless) || {};
}

function usagePath(repoRoot) {
  return path.join(repoRoot, ".codex", "verify", "usage.jsonl");
}

// `allowed` holds permission patterns such as `Bash(npm test:*)`; the built-in tool a call
// needs is the name before the parenthesis.
function builtinTools(allowed) {
  return [...new Set(allowed.map((pattern) => pattern.replace(/\(.*$/, "")))];
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

// On Windows an npm install puts only claude.cmd on PATH, and spawnSync can't start a .cmd
// without a shell (which would mangle the prompt). Find the executable the shim points to.
let claudeCommand;
function resolveClaude() {
  if (claudeCommand) return claudeCommand;
  claudeCommand = { command: "claude", prefix: [] };
  if (process.platform !== "win32") return claudeCommand;
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

// Runs `claude -p` and returns { status, error, text, stderr }. `text` is the model's final
// reply, taken from the JSON result; if the output isn't JSON, it falls back to raw stdout.
function runClaude(repoRoot, { name, task, prompt, model, effort, allowed, denied = [], permissionMode, env, timeout }) {
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
  if (permissionMode) args.push("--permission-mode", permissionMode);
  const { settingSources } = headlessConfig(repoRoot);
  if (settingSources) args.push("--setting-sources", String(settingSources));
  // The variadic flags go last so they can't swallow another option.
  args.push("--allowedTools", ...allowed);
  if (denied.length) args.push("--disallowedTools", ...denied);

  const result = spawnSync(claude.command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...(env ? { env } : {}),
    ...(timeout ? { timeout } : {}),
  });
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
    fs.appendFileSync(usagePath(repoRoot), `${JSON.stringify(usageRecord(name, task, model, effort, parsed, ok))}\n`);
  } catch {
    // Usage logging must never fail a run.
  }
  return { status: result.status, error: result.error, text, stderr: (result.stderr || "").trim() };
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

module.exports = {
  runClaude,
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
  frontmatter,
  isPlaceholder,
  parsePhases,
  planProblems,
};
