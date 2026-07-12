#!/usr/bin/env node
// Minimal claude stub for local-backend e2e tests. Exercises the PTY path
// (spawn, data flow, resize, exit) without a real claude binary or API key.
// Ignores all claude CLI flags (--mcp-config, --session-id, --resume).
'use strict';
process.stdout.write('\r\nclaude-stub: ready\r\n');

// Drain stdin so the PTY write path is exercised; echo back so tests can
// assert bidirectional data flow.
try {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
} catch {
  // setRawMode may throw in some PTY configurations — not fatal.
}
process.stdin.resume();
process.stdin.on('data', (data) => {
  process.stdout.write(data);
});

// Stay alive until the host kills the process (stop / remove).
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
