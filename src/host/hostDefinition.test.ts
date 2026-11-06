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
    expect(live).toEqual({ ok: false, errors: ['steps[0].prompt.mode: live is not available on a remote host; use mode: fresh'] });
    const script = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', script: { run: 'echo hi' } }] }, { ...ctx, hostShells: ['bash'] });
    expect(script).toEqual({ ok: false, errors: ['steps[0].script: script steps are not available on a remote host yet'] });
    const idle = validateDefinition({ name: 'a', triggers: [{ event: { on: 'session.idle' } }], steps: [fresh] }, ctx);
    expect(idle).toEqual({ ok: false, errors: ['triggers[0].event.on: session.idle events are not available on a remote host'] });
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
  it('refuses workspace.started events', () => {
    const r = validateDefinition({ name: 'a', triggers: [{ event: { on: 'workspace.started' } }], steps: [fresh] }, ctx);
    expect(r).toEqual({ ok: false, errors: ['triggers[0].event.on: workspace.started events are not available on a remote host'] });
  });
  it('refuses other workspaces in allowFrom and event.workspace', () => {
    const allow = validateDefinition({ name: 'a', triggers: [{ manual: { allowFrom: ['review-bot', 'other'] } }], steps: [fresh] }, ctx);
    expect(allow).toEqual({ ok: false, errors: ['triggers[0].manual.allowFrom: unknown workspace "other"'] });
    const ev = validateDefinition({ name: 'a', triggers: [{ event: { on: 'todo.created', workspace: 'other' } }], steps: [fresh] }, ctx);
    expect(ev).toEqual({ ok: false, errors: ['triggers[0].event.workspace: unknown workspace "other"'] });
  });
  it('binds $self in script.runIn', () => {
    const d = substituteSelf({ steps: [{ id: 's', script: { run: 'echo', runIn: '$self' } }] }, WS.id) as { steps: Array<{ script: { runIn: string } }> };
    expect(d.steps[0].script.runIn).toBe(WS.id);
  });
  it('accumulates every refusal', () => {
    const r = validateDefinition({
      name: 'a',
      triggers: [{ event: { on: 'session.idle' } }, { event: { on: 'workspace.started' } }],
      steps: [{ ...fresh, prompt: { ...fresh.prompt, mode: 'live' } }, { id: 's', script: { run: 'echo hi', runIn: 'review-bot' } }]
    }, ctx);
    expect(r).toEqual({ ok: false, errors: [
      'triggers[0].event.on: session.idle events are not available on a remote host',
      'triggers[1].event.on: workspace.started events are not available on a remote host',
      'steps[0].prompt.mode: live is not available on a remote host; use mode: fresh',
      'steps[1].script: script steps are not available on a remote host yet'
    ] });
  });
  it('treats a step with both script and prompt as a script step, and refuses it', () => {
    const r = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', script: { run: 'echo hi', runIn: 'review-bot' }, prompt: fresh.prompt }] }, ctx);
    expect(r).toEqual({ ok: false, errors: ['steps[0].script: script steps are not available on a remote host yet'] });
  });
});
