import { describe, expect, it } from 'vitest';
import { formatUsd, ownerCostLines } from './ownerView';
import type { SessionOwner } from '../../preload/sessionOwner';

const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null };

describe('formatUsd', () => {
  it.each([[0, '$0.00'], [0.004, '<$0.01'], [1.234, '$1.23'], [123.46, '$123.5'], [1234.5, '$1,235']])('%d → %s', (n, s) => {
    expect(formatUsd(n)).toBe(s);
  });
});

describe('ownerCostLines', () => {
  it('keeps the host order, one line per owner, with stable keys', () => {
    expect(ownerCostLines([
      { owner: ann, sessions: 2, usd: 3 },
      { owner: null, sessions: 1, usd: 1 },
      { owner: ann, sessions: 9, usd: 9 }
    ])).toEqual([
      { key: 'user:github:7', owner: ann, sessions: 2, usd: 3 },
      { key: 'unattributed', owner: null, sessions: 1, usd: 1 }
    ]);
  });
});
