import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpBridge } from './mcpBridgeFile.js';

describe('writeMcpBridge', () => {
  it('writes the container bridge, 0644, to the named path', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'br-')), 'mcp-bridge.cjs');
    writeMcpBridge(out);
    expect(readFileSync(out, 'utf8')).toMatch(/CLAUDE_FLEET_MCP_UNIX/);
    expect(statSync(out).mode & 0o777).toBe(0o644);
  });
});
