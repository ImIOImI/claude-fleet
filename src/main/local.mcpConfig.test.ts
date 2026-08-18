// ensureMcpConfig's interop gate (#259).
//
// Design (docs/superpowers/specs/2026-08-05-local-launcher-wsl-design.md §C)
// always said MCP wiring is skipped when a distro has `wsl.conf [interop]`
// off — the bridge crosses the boundary by exec'ing the app's own .exe from
// inside the distro, which is exactly what interop-off forbids. The
// implementation wired it anyway and let the bridge fail inside claude, so
// `/mcp` showed a permanently-broken `claude-fleet-state` server.
//
// The distinguishing observable used below is the shared bridge script: an
// interop-off skip returns BEFORE `ensureLocalBridgeScript` writes it, while a
// launcher that merely fails later (a non-drive-letter exe path on this host)
// gets past that point. That separates "skipped for interop" from "skipped for
// some other reason" without needing a Windows host.

import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_DATA = mkdtempSync(join(tmpdir(), 'cf-mcpcfg-'));

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
vi.mock('./vault.js', () => ({
  resolveEnv: async (
    _id: string,
    plain: Record<string, string>,
    _k: string[]
  ): Promise<Record<string, string>> => ({ ...plain })
}));
vi.mock('./endpoints.js', () => ({
  endpointEnv: async (): Promise<Record<string, string>> => ({})
}));
vi.mock('node-pty', () => ({}));

const { ensureMcpConfig } = await import('./local.js');

const WS = '01MCPCFGTESTWS0000000000WS';
const stateDir = join(USER_DATA, 'state', WS);
const configPath = join(stateDir, 'mcp-config.json');
const bridgePath = join(USER_DATA, 'mcp', 'local-bridge.cjs');

/** The readiness file ensureMcpConfig gates on for THIS platform (#295). */
function seedReady(): void {
  const dir = join(USER_DATA, 'mcp', WS);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'token' : 'mcp.sock'), 'x');
}

const WSL_BASE = {
  mode: 'wsl' as const,
  distro: 'Ubuntu',
  shell: '/bin/bash',
  home: '/home/t',
  claudePath: '/home/t/.local/bin/claude'
};

describe('ensureMcpConfig — WSL interop gate (#259)', () => {
  beforeEach(() => {
    rmSync(join(USER_DATA, 'state'), { recursive: true, force: true });
    rmSync(join(USER_DATA, 'mcp'), { recursive: true, force: true });
    seedReady();
  });
  afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }));

  it('skips wiring entirely when interop is off', async () => {
    const out = await ensureMcpConfig(WS, { ...WSL_BASE, interopEnabled: false });
    expect(out).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
    // Returned before even writing the shared bridge — a true short-circuit,
    // not "wired then failed".
    expect(existsSync(bridgePath)).toBe(false);
  });

  it('skips even when the server side is up — interop, not readiness, is the reason', async () => {
    expect(existsSync(join(USER_DATA, 'mcp', WS))).toBe(true);
    await ensureMcpConfig(WS, { ...WSL_BASE, interopEnabled: false });
    expect(existsSync(configPath)).toBe(false);
  });

  // A manifest written before #259 has no flag. Treating that as "off" would
  // silently strip MCP from every existing WSL workspace on upgrade.
  it('does NOT skip when the flag is absent (pre-#259 manifest)', async () => {
    await ensureMcpConfig(WS, WSL_BASE);
    expect(existsSync(bridgePath)).toBe(true); // got past the interop gate
  });

  it('does NOT skip when interop is on', async () => {
    await ensureMcpConfig(WS, { ...WSL_BASE, interopEnabled: true });
    expect(existsSync(bridgePath)).toBe(true);
  });

  // The gate must be wsl-specific: a native local workspace has no interop
  // dependency and must keep getting a config.
  it('native launcher is unaffected and still writes a config', async () => {
    const out = await ensureMcpConfig(WS, { mode: 'native' });
    expect(out).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
  });

  it('returns undefined when the server side is not up yet', async () => {
    rmSync(join(USER_DATA, 'mcp'), { recursive: true, force: true });
    expect(await ensureMcpConfig(WS, { mode: 'native' })).toBeUndefined();
  });
});
