import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root = '';
vi.mock('./paths.js', () => ({ workspaceStateDir: (id: string) => join(root, id) }));

const { recordEnvApplied, readEnvApplied } = await import('./envApplied.js');
const { envHash } = await import('./vaultModel.js');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'envapplied-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('round-trips a hash and never stores values', async () => {
  expect(await readEnvApplied('01HW1')).toBeNull();
  await recordEnvApplied('01HW1', { A: 'secret-value' });
  expect(await readEnvApplied('01HW1')).toBe(envHash({ A: 'secret-value' }));
  const raw = await (await import('node:fs/promises')).readFile(join(root, '01HW1', 'env-applied.json'), 'utf8');
  expect(raw).not.toContain('secret-value');
});
