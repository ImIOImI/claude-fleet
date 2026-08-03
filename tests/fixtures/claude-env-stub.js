#!/usr/bin/env node
// Env-printing claude stub (#250): prints the backend env vars an endpoint
// workspace should have injected, then stays alive like claude would.
'use strict';
const keys = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CF_SUMMARY_MODEL'
];
for (const k of keys) process.stdout.write(`${k}=${process.env[k] ?? '<unset>'}\r\n`);
process.stdout.write('env-stub: ready\r\n');
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
