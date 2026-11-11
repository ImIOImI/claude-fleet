import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parsePublishBody, partitionIdFor, PublishArgError, publishedSessionId, PUBLISH_MAX_BODY, PUBLISH_MAX_LINES, SESSION_UUID_RE
} from './protocol.js';

const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ok = { sourceWorkspaceId: SRC, sessionId: SID, events: ['{"type":"user"}'] };

describe('parsePublishBody', () => {
  it('pins the wire limits', () => {
    expect(PUBLISH_MAX_BODY).toBe(1048576);
    expect(PUBLISH_MAX_LINES).toBe(500);
  });

  it('accepts the three fields', () => {
    expect(parsePublishBody(ok)).toEqual(ok);
    expect(parsePublishBody({ ...ok, events: Array(PUBLISH_MAX_LINES).fill('{}') }).events).toHaveLength(PUBLISH_MAX_LINES);
  });

  it.each([
    [{ ...ok, ownerLogin: 'bob' }, /unknown field: ownerLogin/],
    [{ ...ok, workspaceId: SRC }, /unknown field: workspaceId/],
    [{ ...ok, partitionId: 'pub_x' }, /unknown field: partitionId/],
    [JSON.parse(`{"__proto__":{},"sourceWorkspaceId":"${SRC}","sessionId":"${SID}","events":["{}"]}`), /unknown field: __proto__/],
    [{ ...ok, sourceWorkspaceId: 'not-a-ulid' }, /sourceWorkspaceId/],
    [{ ...ok, sessionId: 'AAAAAAAA-2222-4333-8444-555555555555' }, /sessionId/],
    [{ ...ok, sessionId: SID.slice(1) }, /sessionId/],
    [{ ...ok, events: [] }, /1-500/],
    [{ ...ok, events: Array(PUBLISH_MAX_LINES + 1).fill('{}') }, /1-500/],
    [{ ...ok, events: ['{"a":\n1}'] }, /events\[0\] must be one JSONL line/],
    [{ ...ok, events: ['{"a":\r1}'] }, /events\[0\] must be one JSONL line/],
    [{ ...ok, events: ['nope'] }, /events\[0\] is not JSON/],
    [{ ...ok, events: ['[1]'] }, /events\[0\] must be a JSON object/],
    [{ ...ok, events: [7] }, /events\[0\] must be one JSONL line/],
    [[ok], /body must be/],
    [null, /body must be/]
  ])('refuses %j', (body, msg) => {
    expect(() => parsePublishBody(body)).toThrow(PublishArgError);
    expect(() => parsePublishBody(body)).toThrow(msg);
  });
});

describe('partition and session ids', () => {
  const ann = { provider: 'github', id: 7 };
  it('derives a stable partition per (provider, account, source workspace)', () => {
    const p = partitionIdFor(ann, SRC);
    expect(p).toMatch(/^pub_[0-9a-f]{32}$/);
    expect(partitionIdFor({ ...ann }, SRC)).toBe(p);
    expect(partitionIdFor({ ...ann, id: 8 }, SRC)).not.toBe(p);
    expect(partitionIdFor({ ...ann, provider: 'gitlab' }, SRC)).not.toBe(p);
    expect(partitionIdFor(ann, '01JC0000000000000000000006')).not.toBe(p);
  });

  it('ignores the login, so a rename keeps the partition', () => {
    const withLogin = { ...ann, login: 'ann' } as Parameters<typeof partitionIdFor>[0];
    expect(partitionIdFor(withLogin, SRC)).toBe(partitionIdFor({ ...ann, login: 'ann2' } as typeof withLogin, SRC));
  });

  it('pins the derivation', () => {
    expect(partitionIdFor(ann, SRC)).toBe(`pub_${sha256Hex(`github:7\0${SRC}`).slice(0, 32)}`);
  });

  it('derives a UUID-shaped session id per partition', () => {
    const p = partitionIdFor(ann, SRC);
    const s = publishedSessionId(p, SID);
    expect(s).toMatch(SESSION_UUID_RE);
    expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publishedSessionId(p, SID)).toBe(s);
    expect(publishedSessionId(partitionIdFor({ ...ann, id: 8 }, SRC), SID)).not.toBe(s);
    expect(s).not.toBe(SID);
  });
});

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
