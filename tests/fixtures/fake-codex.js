"use strict";

// Stand-in for the codex CLI in handoff tests: node fake-codex.js <config.json> <codex args...>
// config: { threadsFile, argsFile, queueCode, proxyCode }.
// - `app-server proxy` answers the WebSocket upgrade and the JSON-RPC calls the handoff makes,
//   serving the threads listed in threadsFile (missing file = no threads).
// - `queue ...` records its arguments in argsFile and exits with queueCode.

const fs = require("node:fs");
const path = require("node:path");
const lib = require(path.join(__dirname, "..", "..", "skills", "claude-codex-workflow", "templates", "codex", "hooks", "workflow-lib"));

const [configFile, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

function threads() {
  try {
    return JSON.parse(fs.readFileSync(config.threadsFile, "utf8"));
  } catch {
    return [];
  }
}

if (args[0] === "queue") {
  fs.writeFileSync(config.argsFile, args.join(" "));
  process.exit(config.queueCode || 0);
}

if (args[0] === "app-server" && args[1] === "proxy") {
  if (config.proxyCode) {
    process.stderr.write("Error: failed to connect to the app-server control socket\n");
    process.exit(config.proxyCode);
  }
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const reply = (message) => process.stdout.write(lib.encodeFrame(JSON.stringify(message), { mask: false }));
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      process.stdout.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    }
    const { frames, rest } = lib.decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const message = JSON.parse(frame.text);
      if (message.id === undefined) continue;
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      else if (message.method === "thread/loaded/list") reply({ id: message.id, result: { data: threads().map((thread) => thread.id), nextCursor: null } });
      else if (message.method === "thread/read") {
        const thread = threads().find((candidate) => candidate.id === message.params.threadId);
        reply(thread ? { id: message.id, result: { thread } } : { id: message.id, error: { code: -32600, message: "thread not loaded" } });
      } else reply({ id: message.id, error: { code: -32601, message: "unknown method" } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  process.exit(0);
}
