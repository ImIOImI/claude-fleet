// Container-side MCP bridge (stdio ↔ host MCP server) with reconnect + resend.
//
// Why this exists (first-call hang, diagnosed 2026-07-09): the previous bridge
// was a shell pipeline — `{ printf token; exec cat; } | socat - TCP:…` — and a
// host-app restart killed socat's peer while `cat` kept holding claude's
// request pipe. cat only noticed on its NEXT write (SIGPIPE) and died carrying
// that request; the respawned pipeline never re-sent it. Net effect: the first
// MCP request after every app restart was silently eaten and claude hung on it
// forever (no client timeout), while the retry sailed through. Reproduced
// empirically; the unix `socat` variant loses in-flight requests the same way,
// just without the stuck-pipeline window.
//
// This bridge instead tracks every request line by its JSON-RPC id and only
// forgets it once a response with that id comes back. On ANY disconnect it
// reconnects forever with EXPONENTIAL BACKOFF (base CLAUDE_FLEET_MCP_RETRY_MS,
// doubling, capped at CLAUDE_FLEET_MCP_RETRY_MAX_MS), re-authenticates, and
// re-sends every still-unanswered request in order. The backoff resets to the
// base once a connection proves healthy (a server byte arrives, or it survives
// CLAUDE_FLEET_MCP_STABLE_MS) so a genuine drop (host app restart) still
// recovers in ~1s, while a hard-down server or a connection that dies on every
// attempt (server not up, token file absent) is probed ever more slowly
// instead of hammered once a second forever (#243 runaway). Notifications
// (no id) are sent at most once. Re-sending reads is safe (the server is
// read-only); the committee_* effects are at-least-once across an app restart
// — acceptable vs. an indefinite hang, and noted in SPEC §11.
//
// Delivery: the host writes this script into the per-workspace MCP dir
// (`<userData>/mcp/<id>/`), which is the one dir bind-mounted into that
// container — so every app start refreshes the bridge with no runner-image
// rebuild, and `managedMcpServerEntry()` just runs it with the runner's node.
//
// Config via env (composed host-side in docker.ts):
//   CLAUDE_FLEET_MCP_TCP        host:port  (Windows hosts — loopback TCP)
//   CLAUDE_FLEET_MCP_UNIX       socket path (Linux/macOS hosts)
//   CLAUDE_FLEET_MCP_TOKEN_FILE first-line auth token path (TCP only)
//   CLAUDE_FLEET_MCP_RETRY_MS   base reconnect backoff (test hook; default 1000)
//   CLAUDE_FLEET_MCP_RETRY_MAX_MS reconnect backoff cap (default 30000)
//   CLAUDE_FLEET_MCP_STABLE_MS  connection uptime that resets backoff (default 5000)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTAINER_BRIDGE_FILENAME = 'bridge.cjs';

const BRIDGE_SOURCE = `'use strict';
// claude-fleet container MCP bridge — reconnect + resend (see mcpContainerBridge.ts).
const net = require('net');
const fs = require('fs');

const tcp = process.env.CLAUDE_FLEET_MCP_TCP || '';
const unix = process.env.CLAUDE_FLEET_MCP_UNIX || '';
const tokenFile = process.env.CLAUDE_FLEET_MCP_TOKEN_FILE || '';
const retryMs = Number(process.env.CLAUDE_FLEET_MCP_RETRY_MS) || 1000;
const retryMaxMs = Number(process.env.CLAUDE_FLEET_MCP_RETRY_MAX_MS) || 30000;
const stableMs = Number(process.env.CLAUDE_FLEET_MCP_STABLE_MS) || 5000;

// Ordered outbox. Requests (numeric/string id) stay until a response with the
// same id arrives; notifications (no id) leave as soon as they hit a live
// socket. \`sent\` marks lines already written to the CURRENT connection.
let outbox = []; // { id: string|null, line: string, sent: boolean }
let sock = null;
let connected = false;
// Current reconnect delay; grows on every close, resets when a connection
// proves healthy. See connect()/onServerData().
let backoffMs = retryMs;

function idKey(v) {
  return v === undefined || v === null ? null : String(v);
}

let inCarry = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inCarry += chunk;
  let nl;
  while ((nl = inCarry.indexOf('\\n')) >= 0) {
    const line = inCarry.slice(0, nl);
    inCarry = inCarry.slice(nl + 1);
    if (!line.trim()) continue;
    let id = null;
    try { id = idKey(JSON.parse(line).id); } catch { /* forward as-is */ }
    outbox.push({ id, line, sent: false });
    flush();
  }
});
process.stdin.on('end', () => process.exit(0));

function flush() {
  if (!connected || !sock) return;
  for (const entry of outbox) {
    if (entry.sent) continue;
    sock.write(entry.line + '\\n');
    entry.sent = true;
  }
  // Notifications can't be acknowledged — once written, drop them so a later
  // reconnect doesn't fire them twice.
  outbox = outbox.filter((e) => e.id !== null || !e.sent);
}

let outCarry = '';
function onServerData(chunk) {
  // A byte from the server proves this connection works — collapse the
  // reconnect backoff so a genuine later drop (host app restart) recovers fast.
  backoffMs = retryMs;
  process.stdout.write(chunk);
  outCarry += chunk;
  let nl;
  while ((nl = outCarry.indexOf('\\n')) >= 0) {
    const line = outCarry.slice(0, nl);
    outCarry = outCarry.slice(nl + 1);
    try {
      const id = idKey(JSON.parse(line).id);
      if (id !== null) outbox = outbox.filter((e) => e.id !== id);
    } catch { /* non-JSON noise — ignore */ }
  }
}

function connect() {
  const c = tcp
    ? net.connect(Number(tcp.split(':')[1]), tcp.split(':')[0])
    : net.connect(unix);
  sock = c;
  let stableTimer = null;
  c.setKeepAlive(true, 5000);
  c.setEncoding('utf8');
  c.on('connect', () => {
    connected = true;
    if (tokenFile) {
      let tok = '';
      try { tok = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* not there yet */ }
      if (!tok) { c.destroy(); return; } // retry via 'close' until the token exists
      c.write(tok + '\\n');
    }
    // Everything unanswered goes again on this fresh connection.
    for (const entry of outbox) entry.sent = false;
    outCarry = '';
    flush();
    // A connection that stays up past stableMs is healthy — reset the backoff
    // so the NEXT reconnect is fast. A connection that dies before this fires
    // (server down, token missing → immediate destroy) leaves the backoff
    // growing, which is what stops the fixed-1s reconnect storm (#243).
    stableTimer = setTimeout(() => { backoffMs = retryMs; }, stableMs);
  });
  c.on('data', onServerData);
  c.on('error', () => { /* 'close' always follows and owns the retry */ });
  c.on('close', () => {
    connected = false;
    sock = null;
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    // Reconnect after the current backoff, then grow it (capped). Healthy
    // connections reset backoffMs back to the base (see above / onServerData).
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, retryMaxMs);
    setTimeout(connect, wait);
  });
}
connect();
`;

/**
 * Write the container bridge into a per-workspace MCP dir (the dir that gets
 * bind-mounted into exactly that container). Idempotent; overwrites with the
 * current source on every call so an app upgrade refreshes every workspace's
 * bridge without a runner-image rebuild.
 */
export function ensureContainerBridgeScript(mcpDir: string): string {
  mkdirSync(mcpDir, { recursive: true });
  const path = join(mcpDir, CONTAINER_BRIDGE_FILENAME);
  writeFileSync(path, BRIDGE_SOURCE, 'utf8');
  return path;
}
