import { describe, expect, it } from 'vitest';
import { validateDefinition } from '../main/automations/definition.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const ctx = { workspace: hostResolver(WS), check: remoteHostRefusals };
const fresh = { id: 'go', prompt: { workspace: 'review-bot', mode: 'fresh', message: 'review' } };

describe('remote host definitions', () => {
  it('accepts a scheduled fresh prompt step on the hosted workspace, by name or id', () => {
    expect(validateDefinition({ name: 'a', triggers: [{ schedule: { cron: '0 9 * * 1-5' } }], steps: [fresh] }, ctx).ok).toBe(true);
    expect(validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: WS.id } }] }, ctx).ok).toBe(true);
  });
  it('refuses another workspace', () => {
    const r = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: 'other' } }] }, ctx);
    expect(r).toEqual({ ok: false, errors: ['steps[0].prompt.workspace: unknown workspace "other"'] });
  });
  it('refuses live steps, script steps and the idle/started events', () => {
    const live = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, mode: 'live' } }] }, ctx);
    expect(live).toEqual({ ok: false, errors: ['steps[0] (go): mode: live is not available on a remote host; use mode: fresh'] });
    const script = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', script: { run: 'echo hi' } }] }, { ...ctx, hostShells: ['bash'] });
    expect(script).toEqual({ ok: false, errors: ['steps[0] (s): script steps are not available on a remote host yet'] });
    const idle = validateDefinition({ name: 'a', triggers: [{ event: { on: 'session.idle' } }], steps: [fresh] }, ctx);
    expect(idle).toEqual({ ok: false, errors: ['triggers[0]: session.idle events are not available on a remote host'] });
  });
  it('substitutes $self in prompt workspaces, event workspaces and allowFrom', () => {
    const d = substituteSelf({ name: 'a', triggers: [{ manual: { allowFrom: ['$self'] } }, { event: { on: 'todo.created', workspace: '$self' } }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: '$self' } }] }, WS.id) as {
      triggers: Array<{ manual?: { allowFrom: string[] }; event?: { workspace: string } }>; steps: Array<{ prompt: { workspace: string } }>;
    };
    expect(d.triggers[0].manual!.allowFrom).toEqual([WS.id]);
    expect(d.triggers[1].event!.workspace).toBe(WS.id);
    expect(d.steps[0].prompt.workspace).toBe(WS.id);
  });
  it('leaves $self elsewhere alone and does not mutate its input', () => {
    const raw = { name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: '$self', message: '$self' } }] };
    const d = substituteSelf(raw, WS.id) as { steps: Array<{ prompt: { workspace: string; message: string } }> };
    expect(d.steps[0].prompt).toMatchObject({ workspace: WS.id, message: '$self' });
    expect(raw.steps[0].prompt.workspace).toBe('$self');
  });
});
