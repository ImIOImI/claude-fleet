// Unit tests for the qwen-code MCP settings helpers in docker.ts.
//
// `qwenSettingsContent()` is a pure function returning the fixed settings
// object to seed into every qwen-code workspace's ~/.qwen/settings.json.
// `seedQwenSettings()` is the file-writing wrapper; we cover its write and
// reconcile paths with a tmp dir, mirroring claudeJsonSeed.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

// Imported AFTER the mock so paths.ts picks up the stubbed electron.app.
const { qwenSettingsContent, seedQwenSettings } = await import('./docker.js');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-qwensettings-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('qwenSettingsContent', () => {
  it('returns the fleet-state MCP entry using socat + UNIX-CONNECT socket path', () => {
    const content = qwenSettingsContent();
    expect(content).toEqual({
      mcpServers: {
        'claude-fleet-state': {
          command: 'socat',
          args: ['-', 'UNIX-CONNECT:/fleet/mcp/mcp.sock']
        }
      }
    });
  });

  it('uses socat (not node) as the command', () => {
    const { mcpServers } = qwenSettingsContent() as { mcpServers: Record<string, { command: string }> };
    expect(mcpServers['claude-fleet-state'].command).toBe('socat');
  });

  it('wires to the canonical CONTAINER_MCP_SOCKET path', () => {
    const { mcpServers } = qwenSettingsContent() as { mcpServers: Record<string, { args: string[] }> };
    const args = mcpServers['claude-fleet-state'].args;
    expect(args).toContain('UNIX-CONNECT:/fleet/mcp/mcp.sock');
  });
});

describe('seedQwenSettings', () => {
  it('creates the file with the correct MCP entry when absent', async () => {
    const filePath = await seedQwenSettings('01QWEN');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed).toEqual(qwenSettingsContent());
  });

  it('creates the parent state dir if missing', async () => {
    // userDataDir exists but no state/<id> subdir yet
    const filePath = await seedQwenSettings('01FRESH');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBeTruthy();
  });

  it('reconciles the managed entry without touching other keys', async () => {
    // Pre-create the state dir and a file with stale MCP + user prefs
    await mkdir(join(userDataDir, 'state', '01RECON'), { recursive: true });
    const filePath = join(userDataDir, 'state', '01RECON', 'qwen-settings.json');
    const existing = {
      theme: 'dark',
      mcpServers: {
        'claude-fleet-state': { command: 'old-cmd', args: [] },
        'my-other-mcp': { command: 'npx', args: ['my-server'] }
      }
    };
    await writeFile(filePath, JSON.stringify(existing), 'utf8');

    await seedQwenSettings('01RECON');
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    // User prefs untouched
    expect(parsed.theme).toBe('dark');
    // Other MCP server untouched
    expect(parsed.mcpServers['my-other-mcp']).toEqual({ command: 'npx', args: ['my-server'] });
    // Our entry updated
    const { mcpServers } = qwenSettingsContent() as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers['claude-fleet-state']).toEqual(mcpServers['claude-fleet-state']);
  });

  it('leaves an already-correct file byte-identical (no rewrite)', async () => {
    await mkdir(join(userDataDir, 'state', '01SAME'), { recursive: true });
    const filePath = join(userDataDir, 'state', '01SAME', 'qwen-settings.json');
    const serialized = JSON.stringify(qwenSettingsContent(), null, 2);
    await writeFile(filePath, serialized, 'utf8');

    await seedQwenSettings('01SAME');
    // File content is byte-identical (no trailing rewrite)
    expect(await readFile(filePath, 'utf8')).toBe(serialized);
  });
});
