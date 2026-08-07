import { describe, it, expect } from 'vitest';
import { wslMcpServerEntry, localMcpServerEntry } from './mcpLocalBridge.js';

describe('wslMcpServerEntry', () => {
  it('translates the exe to /mnt/c and keeps Windows paths in args/env', () => {
    const e = wslMcpServerEntry(
      'C:\\Users\\troy\\AppData\\Local\\Programs\\claude-fleet\\claude-fleet.exe',
      'C:\\ud\\mcp\\local-bridge.cjs',
      'C:\\ud\\mcp\\ws1\\mcp.sock'
    );
    expect(e).toEqual({
      type: 'stdio',
      command: '/mnt/c/Users/troy/AppData/Local/Programs/claude-fleet/claude-fleet.exe',
      args: ['C:\\ud\\mcp\\local-bridge.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: 'C:\\ud\\mcp\\ws1\\mcp.sock' }
    });
  });
  it('returns null for a non-drive exe path', () => {
    expect(wslMcpServerEntry('\\\\server\\share\\x.exe', 'C:\\b.cjs', 'C:\\s.sock')).toBeNull();
  });
});

describe('localMcpServerEntry', () => {
  it('is unchanged', () => {
    expect(localMcpServerEntry('/e', '/b.cjs', '/s.sock').command).toBe('/e');
  });
});
