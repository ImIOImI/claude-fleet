import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyName, prepareLoadoutAutomations, readLoadoutAutomations } from './loadoutAutomations.js';

const ctx = { workspace: (v: string) => ({ T1: 'T1', 'ops-oncall': 'W1', W1: 'W1', WA: 'WA' } as Record<string, string>)[v] ?? null };

function loadout(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loadout-auto-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const WATCH = `name: webex-watch
triggers: [{ schedule: { cron: "*/30 * * * *" } }, { manual: { allowFrom: [$self] } }]
steps:
  - id: fetch
    script: { run: ./fetch.sh, secrets: [WEBEX_TOKEN] }
  - id: tell
    prompt: { workspace: $self, mode: fresh, message: "Triage {{steps.fetch.stdout}}" }
`;

describe('loadout automations', () => {
  it('reads automations/<name>/automation.yaml with sibling files, binds $self, inlines ./scripts, and flags missing secrets', async () => {
    const dir = loadout({
      'loadout.md': '---\ntitle: x\n---\n',
      'automations/webex-watch/automation.yaml': WATCH,
      'automations/webex-watch/fetch.sh': 'curl -s "$URL"\n',
      'automations/not-an-automation/readme.md': 'no yaml here'
    });
    const src = await readLoadoutAutomations(dir);
    expect(src.map((s) => s.folder)).toEqual(['webex-watch']);
    const [p] = prepareLoadoutAutomations(src, 'T1', ctx, (ws) => (ws === 'WA' ? ['OTHER'] : []), 'WA');
    expect(p).toMatchObject({ ok: true, name: 'webex-watch', hostStep: false, missingSecrets: ['WEBEX_TOKEN'] });
    expect(p.definition!.steps[0]).toEqual({ id: 'fetch', script: { run: 'curl -s "$URL"\n', secrets: ['WEBEX_TOKEN'] } });
    expect(p.definition!.steps[1]).toMatchObject({ prompt: { workspace: 'T1', mode: 'fresh' } });
    expect(p.definition!.triggers[1]).toEqual({ manual: { allowFrom: ['T1'] } });
    expect(prepareLoadoutAutomations(src, 'T1', ctx, () => ['WEBEX_TOKEN'], 'WA')[0].missingSecrets).toEqual([]);
  });
  it('reports a missing script file, path escapes, invalid YAML, and host steps', async () => {
    const dir = loadout({
      'automations/a/automation.yaml': 'name: a\ntriggers: [{ manual: {} }]\nsteps: [{ id: s, script: { run: ./missing.sh } }]\n',
      'automations/b/automation.yaml': 'name: b\ntriggers: [{ manual: {} }]\nsteps: [{ id: s, script: { run: ./../a/automation.yaml } }]\n',
      'automations/c/automation.yaml': 'name: [oops',
      'automations/d/automation.yaml': 'name: d\ntriggers: [{ manual: {} }]\nsteps: [{ id: s, script: { run: "date", runIn: host, shell: bash } }]\n'
    });
    const ps = prepareLoadoutAutomations(await readLoadoutAutomations(dir), 'T1', ctx, () => [], null);
    expect(ps[0].errors[0]).toMatch(/\.\/missing\.sh isn't a file in this automation's folder/);
    expect(ps[1].errors[0]).toMatch(/isn't a file in this automation's folder/);
    expect(ps[2]).toMatchObject({ ok: false, errors: [expect.stringMatching(/not valid YAML/)] });
    expect(ps[3]).toMatchObject({ ok: true, hostStep: true });
  });
  it('copyName keeps the name when free, else suffixes the target workspace', () => {
    const taken = new Set(['webex-watch', 'webex-watch-ops-oncall']);
    expect(copyName('fresh', 'ops-oncall', (n) => taken.has(n))).toBe('fresh');
    expect(copyName('webex-watch', 'Build Bot', (n) => taken.has(n))).toBe('webex-watch-build-bot');
    expect(copyName('webex-watch', 'ops-oncall', (n) => taken.has(n))).toBe('webex-watch-ops-oncall-2');
  });
});
