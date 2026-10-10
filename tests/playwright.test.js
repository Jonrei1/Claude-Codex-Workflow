"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setupPlaywright, resolveInstallation } = require("../skills/claude-codex-workflow/scripts/playwright");

function fixture(options = {}) {
  const calls = [];
  const records = [];
  const prompts = [];
  const installation = {
    version: "test-version",
    server: "C:/Tool Folder/mcp/cli.js",
    cli: "C:/Tool Folder/mcp/node_modules/playwright/cli.js",
    browser: "C:/Browser Cache/chromium/chrome.exe",
  };
  let packageReady = Boolean(options.packageReady);
  let browserReady = Boolean(options.browserReady);
  const registered = new Set(options.registered || []);
  const env = {
    dryRun: Boolean(options.dryRun),
    // Most tests cover both clients (--playwright-codex); the default is Claude only.
    codex: "codex" in options ? options.codex : true,
    has: (command) => !(options.missingClients || []).includes(command),
    exists: (file) => file === installation.browser && browserReady,
    resolve: () => {
      if (!packageReady) throw new Error("package missing");
      return installation;
    },
    confirm: async (question) => {
      prompts.push(question);
      return options.approved !== false;
    },
    record: (step, ok, note) => records.push({ step, ok, note }),
    run: (command, args, settings = {}) => {
      calls.push({ command, args, settings });
      if (args[0] === "root") return { status: options.rootFails ? 1 : 0, stdout: "C:/Tool Folder\n" };
      if (args[1] === "get") return { status: registered.has(command) ? 0 : 1 };
      if (command === "npm") {
        packageReady = !options.packageFails;
        return { status: packageReady ? 0 : 1 };
      }
      if (command === process.execPath) {
        browserReady = !options.browserFails;
        return { status: browserReady ? 0 : 1 };
      }
      if (args[1] === "add") {
        if (command === options.registrationFails) return { status: 1 };
        registered.add(command);
        return { status: 0 };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return { env, calls, records, prompts, installation };
}

test("by default only Claude gets Playwright, since Claude does the UI audits", async () => {
  const f = fixture({ codex: undefined });
  await setupPlaywright(f.env);
  const writes = f.calls.filter((call) => call.args[0] !== "root" && call.args[1] !== "get");
  assert.deepEqual(writes.map((call) => call.command), ["npm", process.execPath, "claude"]);
  assert.ok(!f.calls.some((call) => call.command === "codex"));
  assert.ok(f.records.every((record) => record.ok === true));
});

test("first setup installs the server and matching browser, then connects both clients", async () => {
  const f = fixture();
  await setupPlaywright(f.env);
  const writes = f.calls.filter((call) => call.args[0] !== "root" && call.args[1] !== "get");
  assert.deepEqual(writes.map((call) => call.command), ["npm", process.execPath, "claude", "codex"]);
  assert.deepEqual(writes[0].args, ["install", "-g", "@playwright/mcp"]);
  assert.deepEqual(writes[1].args, [f.installation.cli, "install", "chromium"]);
  assert.deepEqual(writes[2].args.slice(0, 6), ["mcp", "add", "--scope", "user", "playwright", "--"]);
  assert.deepEqual(writes[3].args.slice(0, 4), ["mcp", "add", "playwright", "--"]);
  for (const call of writes.slice(2)) {
    assert.deepEqual(call.args.slice(-6), [process.execPath, f.installation.server, "--executable-path", f.installation.browser, "--headless", "--isolated"]);
  }
  assert.equal(f.prompts.length, 1);
  assert.ok(f.records.every((record) => record.ok === true));
});

test("repeat setup reuses packages and browser and preserves registrations without prompting", async () => {
  const f = fixture();
  await setupPlaywright(f.env);
  f.calls.length = 0;
  f.prompts.length = 0;
  await setupPlaywright(f.env);
  assert.deepEqual(f.calls.map((call) => call.args[0]), ["root", "mcp", "mcp"]);
  assert.equal(f.prompts.length, 0);
});

test("existing custom registration is kept when the other client needs connecting", async () => {
  const f = fixture({ packageReady: true, browserReady: true, registered: ["claude"] });
  await setupPlaywright(f.env);
  assert.equal(f.calls.filter((call) => call.command === "claude" && call.args[1] === "add").length, 0);
  assert.equal(f.calls.filter((call) => call.command === "codex" && call.args[1] === "add").length, 1);
});

test("dry run performs no commands, prompts or configuration writes", async () => {
  const f = fixture({ dryRun: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.records[0].ok, null);
});

test("declined setup reports incomplete work without mutating machine configuration", async () => {
  const f = fixture({ approved: false });
  await setupPlaywright(f.env);
  assert.ok(f.calls.every((call) => call.args[0] === "root" || call.args[1] === "get"));
  assert.ok(f.records.some((record) => record.ok === false));
});

test("download failure prevents registrations that point to a missing browser", async () => {
  const f = fixture({ browserFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.filter((call) => call.args[1] === "add").length, 0);
  assert.ok(f.records.some((record) => record.step === "Playwright Chromium" && record.ok === false));
});

test("package failure prevents browser download and MCP registration", async () => {
  const f = fixture({ packageFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.filter((call) => call.command === process.execPath || call.args[1] === "add").length, 0);
  assert.ok(f.records.some((record) => record.step === "Playwright MCP" && record.ok === false));
});

test("one registration failure is reported without preventing the other client setup", async () => {
  const f = fixture({ registrationFails: "claude" });
  await setupPlaywright(f.env);
  assert.ok(f.records.some((record) => record.step === "Playwright (claude)" && record.ok === false));
  assert.ok(f.records.some((record) => record.step === "Playwright (codex)" && record.ok === true));
});

test("a missing client is reported while the installed client gets browser tools", async () => {
  const f = fixture({ missingClients: ["claude"] });
  await setupPlaywright(f.env);
  assert.ok(f.calls.every((call) => call.command !== "claude"));
  assert.ok(f.records.some((record) => record.step === "Playwright (claude)" && record.ok === false));
  assert.ok(f.records.some((record) => record.step === "Playwright (codex)" && record.ok === true));
});

test("npm root failure produces an actionable failure and makes no installations", async () => {
  const f = fixture({ rootFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records[0].ok, false);
});

test("resolution uses the MCP dependency rather than another global Playwright version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-playwright-test-"));
  try {
    const mcp = path.join(root, "@playwright", "mcp");
    const dependency = path.join(mcp, "node_modules", "playwright");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(mcp, "package.json"), JSON.stringify({ version: "fixture", bin: { "playwright-mcp": "cli.js" } }));
    fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ main: "index.js" }));
    fs.writeFileSync(path.join(dependency, "index.js"), 'module.exports = { chromium: { executablePath: () => "matching-browser" } };');
    const installed = resolveInstallation(root);
    assert.equal(installed.cli, path.join(dependency, "cli.js"));
    assert.equal(installed.server, path.join(mcp, "cli.js"));
    assert.equal(installed.browser, "matching-browser");
  } finally {
    // Only this test's newly created directory is removed.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
