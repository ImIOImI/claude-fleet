// Regression coverage for the #444 final-review finding M6: `registerAutomationIpc`'s
// `secret` dependency (runner.ts's script-step secret lookup) called
// `getSecret(ws, key)` directly, with no backstop against `ws` being a
// reserved (non-workspace) vault scope — the same backstop `vault.resolveEnv`
// applies before injecting a bag into a workspace env. `automationIpc.ts`
// pulls in electron, ipc.ts (dockerode, the broker client, better-sqlite3),
// and a dozen other modules, so standing up a real `registerAutomationIpc` to
// call the dependency is not the cheapest reliable way to guard against the
// call being dropped by a future edit. Instead: unit-test the guard directly
// (also covered in vaultScopes.test.ts) and assert, by source text, that the
// `secret:` dependency still calls it before `getSecret`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertNotReservedVaultScope } from '../vaultScopes.js';

const src = readFileSync(new URL('./automationIpc.ts', import.meta.url), 'utf8');

describe('assertNotReservedVaultScope refuses a reserved scope (#444 final review M6)', () => {
  it.each([
    ['a loadout-source vault scope', 'loadout-source:ghcr.io/acme/private'],
    ['an endpoint vault scope', 'endpoint:3f0c']
  ])('refuses %s', (_label, scope) => {
    expect(() => assertNotReservedVaultScope(scope)).toThrow(/reserved/);
  });
});

describe('automation secret guard wiring (#444 final review M6)', () => {
  it('the `secret` dependency asserts before reading the vault', () => {
    const line = src.split('\n').find((l) => l.includes('secret: (ws, key)'));
    expect(line, 'secret: (ws, key) => … dependency not found in automationIpc.ts').toBeTruthy();
    expect(line!.indexOf('assertNotReservedVaultScope(ws)')).toBeGreaterThan(-1);
    expect(line!.indexOf('assertNotReservedVaultScope(ws)')).toBeLessThan(line!.indexOf('getSecret(ws, key)'));
  });
});
