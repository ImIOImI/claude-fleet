// REAL-CONTAINER investigation for #211: a workspace recreate re-attaches the
// terminal to the DEAD (old) container several times before switching to the
// new one — ~3 wasted attach→end cycles and a long delay before the tab works.
//
// Skipped automatically when Docker or the runner image isn't available.
//
// The recreate driven here is the same sequence `applyContainerEdit` runs from
// the restart-to-apply banner (stop → remove keeping state → create with the
// same id). It's driven through the workspace API rather than the Edit modal's
// env fields on purpose: the bug is in how the renderer reacts to a container
// swap underneath a mounted pane, not in how the swap was triggered, and the
// modal path adds a lot of brittle UI driving for no extra coverage.
//
// `pty-attach` carries the containerId it attached to, so error.log is the
// timeline: every attach after the recreate begins should name the NEW
// container, exactly once.

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch } from './_helpers.js';

const RUNNER = 'ghcr.io/imioimi/claude-fleet/runner:latest';
const NAME = 'recreate-real';

function dockerReady(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    const imgs = execSync('docker images --format "{{.Repository}}:{{.Tag}}"', { encoding: 'utf8' });
    return imgs.includes(RUNNER);
  } catch {
    return false;
  }
}

interface LogEntry {
  ts: string;
  type: string;
  message?: string;
  extra?: Record<string, unknown>;
}

function readLog(userDataDir: string): LogEntry[] {
  try {
    return readFileSync(path.join(userDataDir, 'error.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

test('REAL: recreate attaches once to the new container, never to the old (#211)', async () => {
  test.skip(!dockerReady(), 'Docker daemon or runner image unavailable');
  test.setTimeout(300_000);

  const { app, window, userDataDir } = await launch({}); // no mock → real docker
  let wsId: string | undefined;
  let lastContainerId: string | undefined;

  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill(NAME);
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden({ timeout: 120_000 });

    const live = await window.evaluate(async (name) => {
      for (let i = 0; i < 90; i++) {
        const list = (await (window as any).api.workspace.list()) as Array<{
          id: string;
          name: string;
          containerId?: string;
          state: string;
        }>;
        const w = list.find((x) => x.name === name);
        if (w?.containerId && w.state === 'running') return { id: w.id, containerId: w.containerId };
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`${name} never became live`);
    }, NAME);
    wsId = live.id;
    const oldContainerId = live.containerId;
    lastContainerId = oldContainerId;

    // Select the chip so the pane mounts and the first attach happens.
    await window.locator('.ws-chip', { hasText: NAME }).click();
    await expect(async () => {
      const attached = readLog(userDataDir).some(
        (e) => e.type === 'pty-attach' && e.extra?.containerId === oldContainerId
      );
      expect(attached, 'pane never attached to the original container').toBe(true);
    }).toPass({ timeout: 90_000 });

    const t0 = Date.now();

    // The recreate itself — exactly what the restart banner does.
    await window.evaluate(
      async ([id, cid]) => {
        const api = (window as any).api;
        const spec = await api.workspace.getManifest(id);
        await api.workspace.ensureImage(() => {}, spec.image);
        await api.workspace.stop(cid);
        await api.workspace.remove(cid, { deleteState: false, id });
        await api.workspace.create({
          id: spec.id,
          name: spec.name,
          description: spec.description,
          labels: spec.labels,
          color: spec.color,
          workspaceSubdir: spec.workspaceSubdir,
          kind: spec.kind,
          workspaceRoot: spec.workspaceRoot,
          image: spec.image,
          authMode: spec.authMode,
          env: spec.env,
          resources: spec.resources,
          mirror: spec.mirror
        });
      },
      [wsId, oldContainerId]
    );

    // Wait for the workspace to come back live on a DIFFERENT container.
    const recreated = await window.evaluate(
      async ([name, oldCid]) => {
        for (let i = 0; i < 120; i++) {
          const list = (await (window as any).api.workspace.list()) as Array<{
            id: string;
            name: string;
            containerId?: string;
            state: string;
          }>;
          const w = list.find((x) => x.name === name);
          if (w?.containerId && w.containerId !== oldCid && w.state === 'running') {
            return { containerId: w.containerId };
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error('workspace never came back on a new container');
      },
      [NAME, oldContainerId]
    );
    const newContainerId = recreated.containerId;
    lastContainerId = newContainerId;

    // Let the renderer settle: it must land on the new container and stay.
    await expect(async () => {
      const attachedNew = readLog(userDataDir).some(
        (e) =>
          e.type === 'pty-attach' &&
          Date.parse(e.ts) >= t0 &&
          e.extra?.containerId === newContainerId
      );
      expect(attachedNew, 'pane never attached to the recreated container').toBe(true);
    }).toPass({ timeout: 120_000 });
    await window.waitForTimeout(15_000); // catch any late redundant attaches

    const post = readLog(userDataDir).filter((e) => Date.parse(e.ts) >= t0);
    const attaches = post.filter((e) => e.type === 'pty-attach');
    const toOld = attaches.filter((e) => e.extra?.containerId === oldContainerId);
    const toNew = attaches.filter((e) => e.extra?.containerId === newContainerId);

    console.log(
      '[#211 timeline]\n' +
        post
          .filter((e) =>
            ['pty-attach', 'pty-attach-failed', 'pty-stream-end', 'pty-attach-error'].includes(
              e.type
            )
          )
          .map((e) => {
            const cid = String(e.extra?.containerId ?? '');
            const which = cid === oldContainerId ? 'OLD' : cid === newContainerId ? 'NEW' : cid || '-';
            return `  ${e.ts} ${e.type.padEnd(18)} ${which}`;
          })
          .join('\n')
    );
    console.log(`[#211] attaches after recreate: OLD=${toOld.length} NEW=${toNew.length}`);

    // The issue: ~3 attaches against the dead container before switching.
    expect(toOld.length, `${toOld.length} attach(es) against the DEAD container`).toBe(0);
    expect(toNew.length, `${toNew.length} attach(es) against the new container`).toBe(1);
  } finally {
    if (lastContainerId) {
      await window
        .evaluate(
          ([cid, id]) => (window as any).api.workspace.remove(cid, { id, deleteState: true }),
          [lastContainerId, wsId ?? '']
        )
        .catch(() => undefined);
    }
    await app.close();
  }
});
