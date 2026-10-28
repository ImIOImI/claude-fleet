import { describe, it, expect } from 'vitest';
import { classifyChange, minScheduleInterval, riskFlags } from './classify.js';
import type { AutomationDef } from '../../preload/inboxTypes.js';

const name = (id: string) => ({ W1: 'ops-oncall', W2: 'webex-triage' } as Record<string, string>)[id] ?? id;
const base: AutomationDef = {
  name: 'log-watch', description: 'watch', tags: ['ops'], concurrency: 'skip',
  triggers: [{ schedule: { cron: '*/15 * * * *' } }, { manual: { allowFrom: ['W2'] } }],
  params: [{ name: 'since', type: 'string', default: '1h' }],
  steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }]
};
const with_ = (over: Partial<AutomationDef>): AutomationDef => ({ ...base, ...over });

describe('classifyChange', () => {
  it('new automations always need the user', () => {
    expect(classifyChange(null, base, name)).toEqual({ lowRisk: false, reasons: ['new automation'] });
  });
  it('wording, tags, name, params, slower schedules and removals are low-risk', () => {
    const lowRisk = [
      with_({ name: 'log-watch-2', description: 'x', tags: ['ops', 'prod'] }),
      with_({ steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs carefully' } }] }),
      with_({ params: [{ name: 'since', type: 'string', default: '2h' }, { name: 'n', type: 'number' }] }),
      with_({ triggers: [{ schedule: { cron: '*/30 * * * *' } }, { manual: { allowFrom: ['W2'] } }] }),
      with_({ triggers: [{ schedule: { cron: '*/5 * * * *' } }, { manual: { allowFrom: ['W2'] } }] }),
      with_({ triggers: [{ schedule: { cron: '*/15 * * * *' } }] }),
      with_({ concurrency: 'queue', timeout: '1h' })
    ];
    for (const after of lowRisk) expect(classifyChange(base, after, name)).toEqual({ lowRisk: true, reasons: [] });
  });
  it('widening what it can touch or how often needs the user, with readable reasons', () => {
    const r = (after: AutomationDef) => classifyChange(base, after, name).reasons;
    expect(r(with_({ steps: [...base.steps, { id: 'more', prompt: { workspace: 'W2', mode: 'live', message: 'x' } }] }))).toEqual(['prompts webex-triage (live)']);
    expect(r(with_({ steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'fresh', message: 'check logs', allowedTools: ['Read'] } }] })))
      .toEqual(['switches check to a fresh session', 'lets check use Read']);
    expect(r(with_({ steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs', ensureRunning: true } }] }))).toEqual(['check may start ops-oncall']);
    expect(r(with_({ triggers: [{ schedule: { cron: '*/2 * * * *' } }, { manual: { allowFrom: ['W2', 'W1'] } }] })))
      .toEqual(['lets ops-oncall run it', 'runs every 2 min (faster than every 5 min)']);
    expect(r(with_({ triggers: [...base.triggers, { event: { on: 'session.idle' } }] }))).toEqual(['adds an event trigger']);
  });
  it('adding a schedule to a by-hand automation needs the user', () => {
    const manualOnly = with_({ triggers: [{ manual: {} }] });
    expect(classifyChange(manualOnly, with_({ triggers: [{ manual: {} }, { schedule: { cron: '0 9 * * *' } }] }), name).reasons).toEqual(['adds a schedule (daily or less)']);
  });
});

describe('riskFlags + minScheduleInterval', () => {
  it('summarizes what an automation can do', () => {
    expect(minScheduleInterval(base)).toBe(15 * 60_000);
    expect(minScheduleInterval(with_({ triggers: [{ schedule: { cron: '0 9,15 * * *' } }] }))).toBe(6 * 3_600_000);
    expect(riskFlags(with_({ steps: [{ id: 'a', prompt: { workspace: 'W1', mode: 'fresh', message: 'm', allowedTools: ['Read'], ensureRunning: true } }] }), name))
      .toEqual(['prompts ops-oncall (fresh session)', 'starts ops-oncall if needed', 'may use Read', 'runs every 15 min', 'runnable by webex-triage']);
  });
});

describe('script steps (#407 Phase 7)', () => {
  const scripted = (script: Record<string, unknown>): AutomationDef => with_({ steps: [{ id: 'fetch', script: { run: 'curl x', ...script } } as never, ...base.steps] });
  it('adding, changing, moving or arming a script needs the user; wording elsewhere stays low-risk', () => {
    const r = (b: AutomationDef, a: AutomationDef) => classifyChange(b, a, name);
    expect(r(base, scripted({})).reasons).toEqual(['adds a script step (fetch)']);
    expect(r(scripted({}), scripted({ run: 'curl y' })).reasons).toEqual(['changes the fetch script']);
    expect(r(scripted({}), scripted({ runIn: 'W2' })).reasons).toEqual(['moves fetch to webex-triage']);
    expect(r(scripted({ secrets: ['A'] }), scripted({ secrets: ['A', 'B'] })).reasons).toEqual(['gives fetch secrets B']);
    expect(r(scripted({}), { ...scripted({}), tags: ['x'] })).toEqual({ lowRisk: true, reasons: [] });
  });
  it('an automation with a host step is never low-risk, and its flag says so', () => {
    const host = scripted({ runIn: 'host', shell: 'bash' });
    expect(classifyChange(host, { ...host, tags: ['x'] }, name)).toEqual({ lowRisk: false, reasons: ['has a step that runs on your computer'] });
    expect(classifyChange(scripted({}), host, name).reasons).toEqual(['moves fetch to your computer']);
    expect(riskFlags(scripted({ runIn: 'host', shell: 'pwsh', secrets: ['TOKEN'] }), name).slice(0, 2)).toEqual(['runs a script on your computer (pwsh)', 'uses secrets TOKEN']);
    expect(riskFlags(scripted({}), name)[0]).toBe('runs a script in the automations workspace');
  });
});

describe('reschedule (#437)', () => {
  const r30 = with_({ reschedule: { min: '30m' } });
  it('adding it, lowering the floor, or dropping the last schedule needs the user', () => {
    expect(classifyChange(base, r30, name).reasons).toEqual(['sets its own next run (no sooner than 30m)']);
    expect(classifyChange(r30, with_({ reschedule: { min: '10m' } }), name).reasons).toEqual(['lets it set its next run sooner (30m → 10m)']);
    expect(classifyChange(r30, with_({ reschedule: { min: '30m' }, triggers: [{ manual: { allowFrom: ['W2'] } }] }), name).reasons)
      .toEqual(['drops its schedule (it then runs only when a run reschedules it, by hand or on an event)']);
  });
  it('raising the floor or removing reschedule is low-risk', () => {
    expect(classifyChange(r30, with_({ reschedule: { min: '2h' } }), name).lowRisk).toBe(true);
    expect(classifyChange(r30, base, name).lowRisk).toBe(true);
  });
  it('is flagged on approval cards', () => {
    expect(riskFlags(r30, name)).toContain('sets its own next run (no sooner than 30m)');
  });
});
