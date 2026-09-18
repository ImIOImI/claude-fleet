#!/usr/bin/env node
// Qwen-stub for e2e tests (Task 13). Executed in place of `qwen` when
// CLAUDE_FLEET_LOCAL_CLAUDE_BIN=process.execPath and
// CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS=<path-to-this-file>.
//
// Responsibilities:
//   (a) Print the compiled OpenAI env vars so the terminal assertion can see
//       them — mirrors claude-env-stub.js but prints OPENAI_BASE_URL /
//       OPENAI_API_KEY / OPENAI_MODEL (the qwen-code harness env contract from
//       endpoints.ts:compileEndpointEnv with harness:'qwen-code').
//   (b) Write ONE qwen-dialect JSONL turn (with usageMetadata + a functionCall)
//       to a chats dir under ~/.qwen/projects/<encoded-cwd>/chats/<sid>.jsonl,
//       so IF the qwen sidecar were running, observability would fill. The sidecar
//       is NOT running in this local-backend e2e (no Docker, no sidecar process),
//       so this write exercises the JSONL-shape contract only.
//
// NOTE: qwen-code harness is currently guarded — attachLocalSession throws
// "qwen-code harness is not yet supported for local workspaces" before this
// stub is ever reached. See qwen-workspace.spec.ts for how the e2e handles this.
'use strict';

import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// (a) Print the OpenAI env vars the harness should have injected.
const keys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
for (const k of keys) process.stdout.write(`${k}=${process.env[k] ?? '<unset>'}\r\n`);
process.stdout.write('qwen-stub: ready\r\n');

// (b) Write one qwen-dialect JSONL turn to the expected chats dir.
// The path mirrors qwen-code's chatRecordingService: ~/.qwen/projects/<key>/chats/<sid>.jsonl
// where <key> is the url-encoded cwd (qwen-code uses the working dir as the
// project discriminator). We use the stub's own cwd as the project key.
try {
  const cwd = process.cwd();
  // qwen-code encodes the path by replacing slashes with %2F and spaces with %20
  // for the project dir name. Use a simple percent-encode of the cwd.
  const encodedCwd = encodeURIComponent(cwd);
  const chatsDir = join(homedir(), '.qwen', 'projects', encodedCwd, 'chats');
  mkdirSync(chatsDir, { recursive: true });
  const sid = randomUUID();
  const record = {
    type: 'assistant',
    uuid: 'qwen-stub-' + sid,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    model: process.env.OPENAI_MODEL ?? 'qwen3-coder:30b',
    usageMetadata: {
      promptTokenCount: 77,
      candidatesTokenCount: 33,
      cachedContentTokenCount: 0
    },
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'fc_stub_1',
            name: 'Bash',
            args: { command: 'echo hello from qwen-stub' }
          }
        }
      ]
    }
  };
  writeFileSync(join(chatsDir, `${sid}.jsonl`), JSON.stringify(record) + '\n');
} catch {
  // Writing the fixture is best-effort; don't crash the stub.
}

process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
