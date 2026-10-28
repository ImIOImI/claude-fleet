// docker/runner/fleet-emit (#407 Phase 7) builds stdout lines the script
// protocol parses. Runs the real script when bash + jq are available.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseScriptOutput } from './scriptProtocol.js';

const SCRIPT = path.resolve(__dirname, '../../../docker/runner/fleet-emit');
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const run = (...args: string[]) => execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

describe.runIf(process.platform !== 'win32' && has('jq'))('fleet-emit', () => {
  it('emits lines the protocol turns into a todo, a notification and state', () => {
    const out = [
      run('todo', 'Reply to "Ana"', '--key', 'webex:1', '--priority', 'high', '--tag', 'webex', '--tag', 'ops', '--body', 'line1\nline2', '--notify'),
      run('notify', 'Token expires tomorrow'),
      run('state', '{"cursor": 42}')
    ].join('');
    const p = parseScriptOutput(out);
    expect(p.todos).toEqual([{ title: 'Reply to "Ana"', key: 'webex:1', priority: 'high', body: 'line1\nline2', tags: ['webex', 'ops'], notify: true }]);
    expect(p.notifies).toEqual([{ title: 'Token expires tomorrow' }]);
    expect(p.state).toEqual({ cursor: 42 });
    expect(p.text).toBe('');
  });
  it('emits a next-run request (#437)', () => {
    expect(parseScriptOutput(run('next', '4h')).next).toEqual({ in: '4h' });
    expect(parseScriptOutput(run('next', '--at', '2026-10-29T09:00:00Z')).next).toEqual({ at: '2026-10-29T09:00:00Z' });
  });
  it('rejects bad priorities and bad state JSON', () => {
    expect(spawnSync('bash', [SCRIPT, 'todo', 'x', '--priority', 'meh']).status).toBe(2);
    expect(spawnSync('bash', [SCRIPT, 'state', '{nope']).status).toBe(2);
  });
});
