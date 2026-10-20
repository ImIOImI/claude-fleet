import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import { createLoadoutInstaller } from './loadoutInstaller.js';
import type { PreparedAutomation } from './loadoutAutomations.js';
import type { AutomationDef } from '../../preload/inboxTypes.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());

const def = (name: string, message = 'check', extra: Partial<AutomationDef> = {}): AutomationDef => ({
  name, triggers: [{ manual: {} }], concurrency: 'skip', steps: [{ id: 's', prompt: { workspace: 'T1', mode: 'live', message } }], ...extra
});
const prep = (folder: string, d: AutomationDef | null, over: Partial<PreparedAutomation> = {}): PreparedAutomation => ({
  folder, name: d?.name ?? folder, ok: !!d, errors: d ? [] : ['bad'], definition: d, hostStep: false, missingSecrets: [], ...over
});

function setup() {
  inbox = InboxStore.memory();
  const store = new AutomationStore(inbox.db);
  let t = 1_000;
  const inst = createLoadoutInstaller({ store, now: () => ++t, workspaceName: (id) => ({ T1: 'ops', T2: 'build' } as Record<string, string>)[id] ?? id });
  return { store, inst };
}
const base = { loadoutId: 'webex', version: '1.0.0', targetId: 'T1', targetName: 'ops' };

describe('loadout installer', () => {
  it('first install turns on valid automations, holds back missing secrets and host steps, and skips invalid ones', () => {
    const { store, inst } = setup();
    const ps = [
      prep('watch', def('webex-watch')),
      prep('needs-secret', def('needs-secret'), { missingSecrets: ['WEBEX_TOKEN'] }),
      prep('on-host', def('on-host'), { hostStep: true }),
      prep('broken', null)
    ];
    const rows = inst.preview(ps, 'webex', 'T1');
    expect(rows.map((r) => [r.folder, r.status, r.defaultOn, r.blocked])).toEqual([
      ['watch', 'new', true, null],
      ['needs-secret', 'new', false, 'add the secret WEBEX_TOKEN to turn it on'],
      ['on-host', 'new', false, 'runs a script on your computer: allow that for this loadout to install it'],
      ['broken', 'invalid', false, 'bad']
    ]);
    const r = inst.install(ps, base);
    expect(r).toMatchObject({ created: ['webex-watch', 'needs-secret'], skipped: [{ name: 'on-host' }, { name: 'broken' }] });
    expect(store.byName('webex-watch')!.enabled).toBe(true);
    expect(store.byName('needs-secret')!.enabled).toBe(false);
    expect(store.byName('webex-watch')!.origin).toEqual({ loadoutId: 'webex', version: '1.0.0', workspaceId: 'T1', folder: 'watch', installedVersion: 1 });
    expect(inst.install([prep('on-host', def('on-host'), { hostStep: true })], { ...base, allowHost: true }).created).toEqual(['on-host']);
  });
  it('honours the review ticks, and a second install target gets its own copy', () => {
    const { store, inst } = setup();
    inst.install([prep('watch', def('webex-watch'))], { ...base, enable: [] });
    expect(store.byName('webex-watch')!.enabled).toBe(false);
    const r = inst.install([prep('watch', def('webex-watch', 'check', { steps: [{ id: 's', prompt: { workspace: 'T2', mode: 'live', message: 'check' } }] }))], { ...base, targetId: 'T2', targetName: 'build' });
    expect(r.created).toEqual(['webex-watch-build']);
  });
  it('update: unedited automations take the new version, edited ones are kept, new ones arrive off', () => {
    const { store, inst } = setup();
    inst.install([prep('a', def('a')), prep('b', def('b'))], base);
    const b = store.byName('b')!;
    store.update(b.id, { ...b.definition, description: 'my edit' }, { kind: 'user', id: null });
    const next = [prep('a', def('a', 'check v2')), prep('b', def('b', 'check v2')), prep('c', def('c'))];
    expect(inst.preview(next, 'webex', 'T1').map((r) => [r.folder, r.status, r.defaultOn])).toEqual([['a', 'update', true], ['b', 'kept-edited', true], ['c', 'new', false]]);
    const r = inst.install(next, { ...base, version: '1.1.0' });
    expect(r).toMatchObject({ updated: ['a'], kept: ['b'], created: ['c'] });
    expect(store.byName('a')).toMatchObject({ version: 2, enabled: true, origin: { version: '1.1.0', installedVersion: 2 } });
    expect(store.byName('c')!.enabled).toBe(false);
    expect(inst.preview(next, 'webex', 'T1').map((r) => r.status)).toEqual(['unchanged', 'kept-edited', 'unchanged']);
    expect(r.ids).toHaveLength(3);
  });
  it('uninstall removes only that install target\'s automations', () => {
    const { store, inst } = setup();
    inst.install([prep('a', def('a'))], base);
    inst.install([prep('a', def('a'))], { ...base, targetId: 'T2', targetName: 'build' });
    expect(inst.uninstall('webex', 'T1')).toEqual(['a']);
    expect(store.list().map((a) => a.name)).toEqual(['a-build']);
  });
});
