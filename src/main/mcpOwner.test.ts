import { afterEach, describe, expect, it } from 'vitest';
import { callTool, handleMcpRequestForTests, initReadSource, releaseReadSource, setExposedTools, setOwnerHandlers, TOOLS } from './mcpCore.js';
import type { OwnedReadSource } from './store/readSource.js';
import type { SessionOwner } from '../preload/sessionOwner.js';

const W = '01JC0000000000000000000000';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null };
const rs = {
  queryFlavor: null,
  close: async () => undefined,
  forgetCaller: async () => undefined,
  sessionWorkspace: async () => W,
  tokenGroups: async () => [],
  summaryParts: async () => ({ files: [], commands: [], tokens: [], span: { started_at: 1, last_active_at: 2 } })
} as unknown as OwnedReadSource;
const result = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const listed = () => (handleMcpRequestForTests('tools/list') as { tools: Array<{ name: string }> }).tools.map((t) => t.name);

afterEach(() => {
  setOwnerHandlers(null);
  setExposedTools(null);
  releaseReadSource();
});

describe('session owners in the MCP core', () => {
  it('without owner handlers (the desktop) nothing changes', async () => {
    initReadSource(rs);
    expect(listed()).not.toContain('cost_by_owner');
    expect(TOOLS.map((t) => t.name)).not.toContain('cost_by_owner');
    expect(result(await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, W))).not.toHaveProperty('owner');
    expect(result(await callTool({ name: 'session_summary', arguments: { id: 's1' } }, W))).not.toHaveProperty('owner');
  });

  it('with owner handlers get_cost and session_summary carry the owner, null when unknown', async () => {
    initReadSource(rs);
    const asked: Array<[readonly string[], string[]]> = [];
    setOwnerHandlers({
      ownersOf: async (ids, allowed) => { asked.push([ids, [...allowed]]); return new Map(ids.filter((i) => i === 's1').map((i) => [i, ann])); },
      ownerCosts: async () => []
    });
    expect(result(await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, W)).owner).toEqual(ann);
    expect(result(await callTool({ name: 'session_summary', arguments: { id: 's2' } }, W)).owner).toBeNull();
    expect(asked).toEqual([[['s1'], [W]], [['s2'], [W]]]);
  });

  it('a session outside the caller’s scope is refused before any owner lookup', async () => {
    initReadSource({ ...rs, sessionWorkspace: async () => null } as unknown as OwnedReadSource);
    let asked = 0;
    setOwnerHandlers({ ownersOf: async () => { asked++; return new Map([['s1', ann]]); }, ownerCosts: async () => [] });
    const r = (await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, W)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain('ann');
    expect(asked).toBe(0);
  });

  it('cost_by_owner is served only where exposed, with the caller scope and a numeric since', async () => {
    initReadSource(rs);
    const got: unknown[] = [];
    setOwnerHandlers({ ownersOf: async () => new Map(), ownerCosts: async (allowed, o) => { got.push([[...allowed], o]); return [{ owner: ann, sessions: 1, usd: 2 }]; } });
    expect(listed()).not.toContain('cost_by_owner');
    expect((await callTool({ name: 'cost_by_owner', arguments: {} }, W).catch((e: Error) => e.message))).toBe('Unknown tool: cost_by_owner');
    setExposedTools(new Set(['cost_by_owner']));
    expect(listed()).toEqual(['cost_by_owner']);
    expect(result(await callTool({ name: 'cost_by_owner', arguments: { since: 5 } }, W))).toEqual([{ owner: ann, sessions: 1, usd: 2 }]);
    await callTool({ name: 'cost_by_owner', arguments: { since: 'yesterday' } }, W);
    await callTool({ name: 'cost_by_owner', arguments: { since: Number.POSITIVE_INFINITY } }, W);
    expect(got).toEqual([[[W], { since: 5 }], [[W], { since: undefined }], [[W], { since: undefined }]]);
  });

  it('cost_by_owner without owner handlers answers unavailable', async () => {
    initReadSource(rs);
    setExposedTools(new Set(['cost_by_owner']));
    const r = (await callTool({ name: 'cost_by_owner', arguments: {} }, W)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r).toMatchObject({ isError: true, content: [{ text: 'Error: cost_by_owner is unavailable' }] });
  });
});
