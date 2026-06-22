// REAL-CONTAINER verification for committee post (#120). Skipped automatically
// when Docker or the runner image isn't available. Creates a real runner
// container, lets the renderer attach (live broker session), wires a manager
// grant, then drives committee.post against the real broker — the round-trip
// the mock harness can't exercise.

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { launch } from './_helpers.js';

const RUNNER = 'ghcr.io/imioimi/claude-fleet/runner:latest';

function dockerReady(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    const imgs = execSync('docker images --format "{{.Repository}}:{{.Tag}}"', { encoding: 'utf8' });
    return imgs.includes(RUNNER);
  } catch {
    return false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

test('REAL: committee.post round-trip against a live broker (#120)', async () => {
  test.skip(!dockerReady(), 'Docker daemon or runner image unavailable');
  test.setTimeout(180_000);

  const { app, window } = await launch({}); // no mock → real docker backend
  let expertContainerId: string | undefined;
  let expertId: string | undefined;
  try {
    // Create a real expert container (image is present, so this is a real run).
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('expert-real');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden({ timeout: 60_000 });

    // Resolve the expert's id + containerId once it shows up live.
    const expert = await window.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const list = (await (window as any).api.workspace.list()) as Array<{
          id: string;
          name: string;
          containerId?: string;
          state: string;
        }>;
        const w = list.find((x) => x.name === 'expert-real');
        if (w?.containerId) return { id: w.id, containerId: w.containerId };
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('expert-real never became live');
    });
    expertId = expert.id;
    expertContainerId = expert.containerId;

    // Make the expert reachable + grant a (manifest-only) manager `post`/`read`.
    const mgrId = '01MGRREAL0000000000000000A';
    await window.evaluate(
      async ([eId, mId]) => {
        const api = (window as any).api;
        const e = await api.workspace.getManifest(eId);
        await api.workspace.writeManifest({ ...e, accessibility: { reachable: true } });
        await api.workspace.writeManifest({
          id: mId,
          name: 'mgr-real',
          labels: [],
          workspaceSubdir: '',
          kind: 'container',
          authMode: 'oauth',
          env: { plain: {}, secretKeys: [] },
          mirror: { default: 'on', cleanup: 'delete' },
          control: { canControl: [{ id: eId, verbs: ['post', 'read'] }] },
          createdAt: Date.now(),
          lastUsedAt: Date.now()
        });
      },
      [expertId, mgrId]
    );

    // Drive committee.post. Retry while the broker session is still warming up
    // ("no live session yet"); capture the final outcome (success OR the
    // writer-conflict the renderer's always-mount attach would cause).
    const outcome = await window.evaluate(
      async ([mId, eId]) => {
        const api = (window as any).api;
        let last = '';
        for (let i = 0; i < 40; i++) {
          try {
            const r = await api.committee.post(mId, eId, 'committee: ping');
            return { ok: true, via: r.via, brokerSessionId: r.brokerSessionId };
          } catch (err) {
            last = String(err);
            if (/no live session yet/.test(last)) {
              await new Promise((r) => setTimeout(r, 2000));
              continue; // broker/claude still starting
            }
            return { ok: false, error: last };
          }
        }
        return { ok: false, error: `timed out; last: ${last}` };
      },
      [mgrId, expertId]
    );

    console.log('[committee.post REAL outcome]', JSON.stringify(outcome));
    expect(outcome.ok, `post outcome: ${JSON.stringify(outcome)}`).toBe(true);
    // The expert is renderer-attached (always-mount), so post must reuse that
    // attachment rather than open a competing one (the bug this test caught).
    expect(outcome.via).toBe('attached');
  } finally {
    if (expertContainerId) {
      await window
        .evaluate(
          ([cid, eid]) => (window as any).api.workspace.remove(cid, { id: eid, deleteState: true }),
          [expertContainerId, expertId ?? '']
        )
        .catch(() => undefined);
    }
    await app.close();
  }
});
