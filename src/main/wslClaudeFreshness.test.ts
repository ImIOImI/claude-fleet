import { describe, expect, it } from 'vitest';
import {
  checkWslClaudeFreshness,
  compareVersions,
  parseClaudeVersion,
  parseVersionBatch,
  versionBatchScript,
  type FreshnessDeps
} from './wslClaudeFreshness.js';

const LAUNCHER = {
  distro: 'Ubuntu',
  shell: '/usr/bin/zsh',
  home: '/home/troy',
  claudePath: '/home/troy/.local/bin/claude'
};

/** Fake exec: first call is the login-shell `command -v` (args contain '-lic'),
 *  second is the `sh -c` version batch. */
function fakeExec(loginStdout: string, versions: Record<string, string>): FreshnessDeps {
  return {
    exec: async (_file, args) => {
      if (args.includes('-lic')) return { stdout: loginStdout };
      // Batch: answer for every path the script asks about, empty when unknown.
      const script = args[args.length - 1];
      const lines: string[] = [];
      for (const m of script.matchAll(/printf '%s\\t%s\\n' '([^']+)'/g)) {
        const p = m[1];
        lines.push(`${p}\t${versions[p] ?? ''}`);
      }
      return { stdout: lines.join('\n') + '\n' };
    }
  };
}

describe('parseClaudeVersion', () => {
  it('extracts x.y.z from claude --version output', () => {
    expect(parseClaudeVersion('2.1.235 (Claude Code)')).toBe('2.1.235');
  });
  it('returns null for empty/garbage output', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('not found')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('2.1.235', '2.0.76')).toBeGreaterThan(0);
    expect(compareVersions('2.0.76', '2.1.235')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('versionBatchScript / parseVersionBatch', () => {
  it('quotes paths and round-trips path→version lines', () => {
    const script = versionBatchScript(["/opt/a b/claude"]);
    expect(script).toContain("'/opt/a b/claude'");
    const parsed = parseVersionBatch('/usr/bin/claude\t2.0.76 (Claude Code)\n/gone/claude\t\n');
    expect(parsed.get('/usr/bin/claude')).toBe('2.0.76');
    expect(parsed.get('/gone/claude')).toBeNull();
  });
  it('ignores rc chatter lines without a tab or leading slash', () => {
    const parsed = parseVersionBatch('welcome to zsh!\nnot-a-path\tjunk\n/x/claude\t1.0.0\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('/x/claude')).toBe('1.0.0');
  });
});

describe('checkWslClaudeFreshness', () => {
  it('reports a newer login-shell claude (the #336 case)', async () => {
    const deps = fakeExec('/home/troy/.nvm/versions/node/v22/bin/claude\n', {
      '/home/troy/.local/bin/claude': '2.0.76 (Claude Code)',
      '/home/troy/.nvm/versions/node/v22/bin/claude': '2.1.235 (Claude Code)'
    });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r).toEqual({
      pinned: { path: '/home/troy/.local/bin/claude', version: '2.0.76' },
      best: { path: '/home/troy/.nvm/versions/node/v22/bin/claude', version: '2.1.235' }
    });
  });

  it('takes the LAST absolute-path line of login-shell output (rc chatter)', async () => {
    const deps = fakeExec('motd banner\n/usr/bin/not-it says hi\n/opt/new/claude\n', {
      '/home/troy/.local/bin/claude': '2.0.76',
      '/opt/new/claude': '3.0.0'
    });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r?.best.path).toBe('/opt/new/claude');
  });

  it('returns null when the pinned binary is already the newest', async () => {
    const deps = fakeExec('/home/troy/.local/bin/claude\n', {
      '/home/troy/.local/bin/claude': '2.1.235',
      '/usr/local/bin/claude': '2.0.76'
    });
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });

  it('returns null when nothing else resolves', async () => {
    const deps = fakeExec('', { '/home/troy/.local/bin/claude': '2.0.76' });
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });

  it('suppresses offers at or below ignoreClaudeVersion, allows newer', async () => {
    const versions = {
      '/home/troy/.local/bin/claude': '2.0.76',
      '/usr/local/bin/claude': '2.1.235'
    };
    expect(
      await checkWslClaudeFreshness(
        { ...LAUNCHER, ignoreClaudeVersion: '2.1.235' },
        fakeExec('', versions)
      )
    ).toBeNull();
    const r = await checkWslClaudeFreshness(
      { ...LAUNCHER, ignoreClaudeVersion: '2.1.100' },
      fakeExec('', versions)
    );
    expect(r?.best.version).toBe('2.1.235');
  });

  it('reports any working candidate when the pinned binary no longer runs', async () => {
    const deps = fakeExec('', { '/usr/local/bin/claude': '2.0.1' });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r).toEqual({
      pinned: { path: '/home/troy/.local/bin/claude', version: null },
      best: { path: '/usr/local/bin/claude', version: '2.0.1' }
    });
  });

  it('survives a rejecting exec (returns null, never throws)', async () => {
    const deps: FreshnessDeps = { exec: async () => Promise.reject(new Error('wsl gone')) };
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });
});
