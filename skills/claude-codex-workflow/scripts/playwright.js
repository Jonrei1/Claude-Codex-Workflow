"use strict";

const fs = require("node:fs");
// Use the MCP package's Playwright dependency so the downloaded browser matches it. Shared with
// the verify step's UI audit, which starts the same server for headless Claude.
const { resolvePlaywright: resolveInstallation } = require("../templates/codex/hooks/workflow-lib");

// Claude does the UI audits, so Playwright is registered for Claude. codex: true
// (--playwright-codex) also registers it for Codex.
async function setupPlaywright({ run, has, confirm, record, dryRun, codex = false, resolve = resolveInstallation, exists = fs.existsSync }) {
  const clients = [
    { command: "claude", add: ["mcp", "add", "--scope", "user", "playwright", "--"] },
    ...(codex ? [{ command: "codex", add: ["mcp", "add", "playwright", "--"] }] : []),
  ];
  if (dryRun) {
    record("Playwright MCP", null, `would install missing global @playwright/mcp, download its matching Chromium, and register a missing playwright server for Claude (user scope)${codex ? " and Codex" : ""}`);
    return;
  }
  const globalRoot = run("npm", ["root", "-g"], { timeout: 60 * 1000 });
  if (globalRoot.status !== 0 || !(globalRoot.stdout || "").trim()) {
    record("Playwright MCP", false, "cannot locate global npm packages; check npm root -g");
    return;
  }
  const root = globalRoot.stdout.trim();
  let installed;
  try { installed = resolve(root); } catch { /* missing or incomplete package */ }
  const missing = [];
  for (const client of clients) {
    if (!has(client.command)) {
      record(`Playwright (${client.command})`, false, `install ${client.command} first, then re-run setup`);
    } else if (run(client.command, ["mcp", "get", "playwright"], { timeout: 60 * 1000 }).status === 0) {
      record(`Playwright (${client.command})`, true, "existing registration kept; check /mcp for connection status");
    } else {
      missing.push(client);
    }
  }
  if ((!installed || !exists(installed.browser) || missing.length) &&
      !(await confirm("Set up Playwright (global @playwright/mcp, matching Chromium download, and missing user MCP registrations)?"))) {
    record("Playwright setup", false, "incomplete; re-run with --yes to install Chromium and register the MCP tools");
    return;
  }
  if (!installed) {
    const result = run("npm", ["install", "-g", "@playwright/mcp"], { inherit: true });
    if (result.status !== 0) {
      record("Playwright MCP", false, "npm install -g @playwright/mcp failed");
      return;
    }
    try { installed = resolve(root); } catch (error) {
      record("Playwright MCP", false, `cannot resolve installed package: ${error.message}`);
      return;
    }
  }
  record("Playwright MCP", true, installed.version);
  if (!exists(installed.browser)) {
    const result = run(process.execPath, [installed.cli, "install", "chromium"], { inherit: true });
    if (result.status !== 0 || !exists(installed.browser)) {
      record("Playwright Chromium", false, "browser download failed; re-run setup. Linux may also need Playwright system dependencies (see README)");
      return;
    }
  }
  record("Playwright Chromium", true, "matching browser installed");
  // Absolute Node/server/browser paths avoid npx downloads and Windows .cmd launch issues.
  const serverArgs = [installed.server, "--executable-path", installed.browser, "--headless", "--isolated"];
  for (const client of missing) {
    const result = run(client.command, [...client.add, process.execPath, ...serverArgs], { inherit: true });
    record(`Playwright (${client.command})`, result.status === 0,
      result.status === 0 ? "registered; restart the client and check /mcp" : "registration failed; re-run setup");
  }
}

module.exports = { setupPlaywright, resolveInstallation };
