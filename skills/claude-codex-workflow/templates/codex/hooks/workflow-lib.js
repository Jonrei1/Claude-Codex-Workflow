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

module.exports = {
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
