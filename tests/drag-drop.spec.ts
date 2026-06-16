// Drag-and-drop ingestion against the real files module. We can't synthesize
// a real OS drag event in Electron, so we drive the IPC the renderer calls
// (window.api.files.*) and assert the saved files + returned container paths
// + collision suffixing + .gitignore. A fresh CLAUDE_FLEET_ROOT isolates the
// dropbox so paths are deterministic.

import { _electron as electron, test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

const WS_ID = 'dropws01';

function dropText(window: Page, mime: 'text/plain' | 'text/html', text: string): Promise<string> {
  return window.evaluate(
    ([m, t]) =>
      (window as unknown as {
        api: { files: { dropText: (w: string, p: { mime: string; text: string }) => Promise<string> } };
      }).api.files.dropText('dropws01', { mime: m as 'text/plain', text: t }),
    [mime, text] as const
  );
}
function dropBytes(window: Page, suggestedName: string | undefined, mime: string, bytes: number[]): Promise<string> {
  return window.evaluate(
    ([name, m, arr]) =>
      (window as unknown as {
        api: {
          files: {
            dropBytes: (
              w: string,
              p: { suggestedName?: string; mime?: string; bytes: Uint8Array }
            ) => Promise<string>;
          };
        };
      }).api.files.dropBytes('dropws01', {
        suggestedName: name as string | undefined,
        mime: m as string,
        bytes: new Uint8Array(arr as number[])
      }),
    [suggestedName, mime, bytes] as const
  );
}

test('Drag-and-drop: text + bytes land in the dropbox with container paths, collisions suffixed', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-drop-'));
  const fleetRoot = mkdtempSync(path.join(tmpdir(), 'claude-fleet-root-'));
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_FLEET_ROOT: fleetRoot } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const dropboxDir = path.join(fleetRoot, WS_ID, '_dropped');

  try {
    // Regression: a `dragover` must be preventDefault'd so the window is a
    // valid drop target (otherwise the OS shows the "not-allowed" cursor and
    // the drop never fires). A bare Event has no dataTransfer — the exact
    // case that previously short-circuited before preventDefault.
    const prevented = await window.evaluate(() => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);

    // Text drop → /workspace/_dropped/dropped-<stamp>.txt, content preserved.
    const textPath = await dropText(window, 'text/plain', 'hello from a drag');
    expect(textPath).toMatch(/^\/workspace\/_dropped\/dropped-.*\.txt$/);
    const hostTextPath = path.join(dropboxDir, path.basename(textPath));
    expect(readFileSync(hostTextPath, 'utf8')).toBe('hello from a drag');

    // The dropbox is git-ignored regardless of the consumer repo's rules.
    expect(readFileSync(path.join(dropboxDir, '.gitignore'), 'utf8')).toContain('*');

    // Bytes with no suggested name + PNG magic → sniffed .png extension.
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    const p1 = await dropBytes(window, undefined, '', pngMagic);
    expect(p1).toMatch(/^\/workspace\/_dropped\/paste-.*\.png$/);

    // Explicit name twice → collision suffixing (foo.bin, foo-2.bin).
    const a = await dropBytes(window, 'foo.bin', 'application/octet-stream', [1, 2, 3]);
    const b = await dropBytes(window, 'foo.bin', 'application/octet-stream', [4, 5, 6]);
    expect(path.basename(a)).toBe('foo.bin');
    expect(path.basename(b)).toBe('foo-2.bin');
    expect(existsSync(path.join(dropboxDir, 'foo.bin'))).toBe(true);
    expect(existsSync(path.join(dropboxDir, 'foo-2.bin'))).toBe(true);
  } finally {
    await app.close();
  }
});
