// Pins the desktop MCP surface byte-for-byte across the mcpCore split.
import { describe, expect, it } from 'vitest';
import { handleMcpRequestForTests, TOOLS } from './mcpServer.js';

describe('desktop MCP contract', () => {
  it('initialize and tools/list are unchanged', async () => {
    const init = handleMcpRequestForTests('initialize');
    const list = handleMcpRequestForTests('tools/list');
    await expect(JSON.stringify({ init, list }, null, 2)).toMatchFileSnapshot('__snapshots__/mcpServer.contract.json');
    expect(TOOLS.map((t) => t.name).slice(8, 12)).toEqual(['query', 'perf_status', 'perf_set', 'perf_sentinel_set']);
  });
});
