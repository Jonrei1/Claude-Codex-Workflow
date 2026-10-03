"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lib = require("../skills/claude-codex-workflow/templates/codex/hooks/workflow-lib");

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-usage-"));
  fs.mkdirSync(path.join(dir, ".codex", "verify"), { recursive: true });
  return dir;
}

function record(task, name, extra = {}) {
  return JSON.stringify({
    task,
    name,
    model: "sonnet",
    effort: "low",
    ok: true,
    inputTokens: 10,
    cacheCreationTokens: 100,
    cacheReadTokens: 1000,
    outputTokens: 5,
    costUsd: 0.01,
    ...extra,
  });
}

test("usageSummary reports no usage before any call", () => {
  const dir = tempRepo();
  assert.match(lib.usageSummary(dir, ""), /No usage recorded yet/);
});

test("usageSummary groups by step, filters by task and counts failures", () => {
  const dir = tempRepo();
  const lines = [
    record("a", "alignment"),
    record("a", "alignment"),
    record("a", "checks-fix", { ok: false }),
    record("b", "alignment"),
    "not json",
  ];
  fs.writeFileSync(path.join(dir, ".codex", "verify", "usage.jsonl"), `${lines.join("\n")}\n`);

  const forA = lib.usageSummary(dir, "a");
  assert.match(forA, /alignment \(sonnet\/low\): 2 call\(s\), 2220 input, 10 output tokens/);
  assert.match(forA, /checks-fix \(sonnet\/low\): 1 call\(s\).*1 failed/);
  assert.match(forA, /Total: 3 call\(s\)/);

  assert.match(lib.usageSummary(dir, "b"), /Total: 1 call\(s\)/);
  assert.match(lib.usageSummary(dir, "missing"), /No usage recorded for missing/);
});
