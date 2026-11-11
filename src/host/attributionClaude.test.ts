// D112: the pinned claude honours inline `--settings` hooks and attribution. Runs only where the
// installed claude is the Dockerfile pin; skipped elsewhere. A dummy key and a local capture server only.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RUNNER_HOOKS } from '../main/claudeArgs.js';
import { sessionSettings } from './attribution.js';

const PIN = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(readFileSync(resolve(__dirname, '../../docker/Dockerfile'), 'utf8'))?.[1];

function installed(): string | null {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/)[0];
  } catch {
    return null;
  }
}

describe.skipIf(!PIN || installed() !== PIN)(`claude ${PIN} and the session settings`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'attr-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the hooks and sends the commit and PR attribution to the model', async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(b);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const marker = join(dir, 'hook-ran');
    const settings = JSON.parse(sessionSettings({ kind: 'user', provider: 'github', id: '12345', login: 'ann', name: 'Ann Example', avatarUrl: null })!);
    expect(Object.keys(settings.hooks).sort()).toEqual(Object.keys(RUNNER_HOOKS.hooks).sort());
    // The runner's hook scripts don't exist here; one stand-in proves hooks load from the same flag.
    settings.hooks = { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] };
    const home = join(dir, 'home');
    const cwd = join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    await new Promise<void>((done) => {
      const p = spawn('claude', ['-p', 'hi', '--settings', JSON.stringify(settings)], {
        cwd,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        }
      });
      p.on('exit', () => done());
    });
    server.close();
    expect(existsSync(marker)).toBe(true);
    const sent = bodies.join('\n');
    expect(sent).toContain('Co-authored-by: Ann Example <12345+ann@users.noreply.github.com>');
    expect(sent).toContain('on behalf of @ann');
  }, 90_000);
});
