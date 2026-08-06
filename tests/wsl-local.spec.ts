// WSL local workspaces e2e (#253).
//
// Exercises the full WSL launcher flow: create a workspace with launcherMode='wsl',
// verify a fake-claude script runs inside the distro, transcript ingestion via the
// polled UNC watcher, and pause (SIGSTOP) / resume (SIGCONT) via the pidfile.
//
// Self-skips on non-win32 and when no WSL distro is installed. Intended to run on
// the e2e-windows CI job which installs Alpine via Vampire/setup-wsl.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { launch } from './_helpers.js';

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

function wslAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf16le',
      timeout: 8_000,
    });
    // --quiet output on Windows is UTF-16LE and may include NUL bytes between chars.
    return out.replace(/\0/g, '').trim().length > 0;
  } catch {
    return false;
  }
}

/** Returns the first distro name from `wsl.exe --list --quiet`, or '' on failure. */
function firstDistro(): string {
  try {
    const out = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf16le',
      timeout: 8_000,
    });
    const lines = out
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines[0] ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Fake claude script written into the WSL distro
// ---------------------------------------------------------------------------
//
// The script:
// 1. Prints FAKE-CLAUDE-READY to stdout (proves spawn ran inside the distro).
// 2. Writes one valid JSONL transcript line to ~/.claude/projects/<cwd-slug>/<SID>.jsonl
//    (triggers the polled-watcher ingest path).
// 3. Stays alive with `cat` (echoes stdin, keeps the PTY open; NOT exec cat —
//    see NOTE below for why exec cat breaks the signal guard).
//
// The JSONL line shape matches what db.ingestLine accepts: type + uuid are
// sufficient for a non-assistant event; message.role and message.content make
// the session surfaceable as a "user" turn (sets first_user_message).
// Verified against src/main/db.test.ts realSession() helper:
//   { type: 'user', uuid: '<uuid>', message: { role: 'user', content: '...' } }
//
// The sessionId in the JSON payload is not used by the watcher (it derives the
// session from the file path), but including it for debugging clarity.
//
// NOTE: The script ends with plain `cat` (not `exec cat`) so that the pidfile's
// $$ remains the `sh` interpreter process, whose /proc/<pid>/cmdline contains
// "claude" (matching the signal-guard grep in src/main/local.ts).  With `exec
// cat` the process image is replaced and cmdline becomes "cat", causing the
// guard to treat the live session as stale (no signal sent, pause fails).
// SIGSTOP on the sh pid is observable as state T in /proc/<pid>/stat; `cat`
// runs as a child but the sh parent is what the pidfile records.

const FAKE_CLAUDE = `#!/bin/sh
echo FAKE-CLAUDE-READY
SID=""
PREV=""
for ARG in "$@"; do
  if [ "$PREV" = "--session-id" ] || [ "$PREV" = "--resume" ]; then SID="$ARG"; fi
  PREV="$ARG"
done
[ -n "$SID" ] || SID=$(cat /proc/sys/kernel/random/uuid)
DIR="$HOME/.claude/projects/$(pwd | sed 's/[^a-zA-Z0-9]/-/g')"
mkdir -p "$DIR"
printf '{"type":"user","uuid":"%s-u1","message":{"role":"user","content":"hi"}}\\n' "$SID" > "$DIR/$SID.jsonl"
cat
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('wsl local workspaces', () => {
  test.skip(!wslAvailable(), 'requires Windows with a WSL distro installed');

  test(
    'create → probe → attach → transcript ingested → pause/resume',
    async () => {
      test.setTimeout(120_000);
      const distro = firstDistro();
      if (!distro) {
        test.skip(true, 'no WSL distro found (wslAvailable returned true but list is empty)');
        return;
      }

      // 1. Seed the fake claude into the distro via a base64-encoded write so the
      //    script content survives Windows shell quoting intact. Alpine's busybox
      //    has base64 (decode with -d) and printf.
      const b64 = Buffer.from(FAKE_CLAUDE, 'utf8').toString('base64');
      execFileSync(
        'wsl.exe',
        [
          '-d', distro, '--',
          'sh', '-c',
          `mkdir -p ~/.local/bin && printf '%s' '${b64}' | base64 -d > ~/.local/bin/claude && chmod +x ~/.local/bin/claude`,
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );

      // Ensure ~/.local/bin is on PATH for login shells (alpine uses /etc/profile.d).
      execFileSync(
        'wsl.exe',
        [
          '-d', distro, '--',
          'sh', '-c',
          'grep -qF "/.local/bin" /etc/profile 2>/dev/null || printf "\\nexport PATH=\\$HOME/.local/bin:\\$PATH\\n" >> /etc/profile',
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );

      // 2. Pre-create the working directory inside the distro.
      execFileSync(
        'wsl.exe',
        ['-d', distro, '--', 'sh', '-c', 'mkdir -p /tmp/cf-e2e'],
        { encoding: 'utf8', timeout: 10_000 }
      );

      // 3. Launch the app with the real backend (no CLAUDE_FLEET_MOCK).
      const { app, window, userDataDir } = await launch();

      try {
        // 4. Open the New workspace modal and configure a WSL local workspace.
        await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

        // Navigate to the New tab if it isn't already active.
        const newTab = window.getByRole('tab', { name: 'New' });
        if (await newTab.isVisible()) await newTab.click();

        // Select Local kind.
        await window.getByRole('radio', { name: /Local/ }).check();

        // The "Run claude in" section must be visible.
        await expect(window.getByLabel('Run claude in')).toBeVisible();

        // If the app-side distro listing comes back empty the WSL radio never
        // renders and the visibility wait times out cryptically — fail loudly
        // with the real cause instead.
        const listed = await window.evaluate(() =>
          (window as unknown as { api: { local: { listWslDistros(): Promise<{ distros: string[] }> } } })
            .api.local.listWslDistros()
        );
        expect(listed.distros, 'app listWslDistros returned no distros — setup-wsl distro not visible to the app').not.toHaveLength(0);

        // The WSL radio must be visible (we are on win32 with distros).
        // Use /WSL/ regex because the accessible name includes the kind-help span text.
        const wslRadio = window.getByRole('radio', { name: /WSL/ });
        await expect(wslRadio).toBeVisible({ timeout: 10_000 });
        await wslRadio.check();

        // Wait for the distro dropdown to appear and contain our distro.
        const distroSelect = window.getByLabel('WSL distro');
        await expect(distroSelect).toBeVisible({ timeout: 8_000 });
        await expect(distroSelect.locator('option', { hasText: distro })).toHaveCount(1);
        await distroSelect.selectOption(distro);

        // Wait for the probe to complete and confirm claude is found.
        await expect(window.locator('.form-hint', { hasText: /claude found at/ })).toBeVisible({
          timeout: 20_000,
        });

        // 5. Fill in the working directory.
        await window.getByLabel('Working directory').fill('/tmp/cf-e2e');

        // Fill in a workspace name.
        await window.getByLabel('Workspace name').fill('wsl-e2e');

        // 6. Create the workspace.
        await window.getByRole('button', { name: 'Create & start' }).click();

        // The chip should appear in the top strip.
        const chip = window.locator('.ws-chip', { hasText: 'wsl-e2e' });
        await expect(chip).toBeVisible({ timeout: 15_000 });
        await chip.click();

        // Terminal pane must mount.
        const termPane = window.locator('.terminal-pane:not([aria-hidden="true"]) .terminal-host');
        await expect(termPane).toBeVisible({ timeout: 10_000 });

        // 7. Wait for FAKE-CLAUDE-READY in the terminal output — proves the spawn
        //    ran inside the distro through the login shell.
        await expect(
          window.locator('.terminal-pane:not([aria-hidden="true"])', { hasText: 'FAKE-CLAUDE-READY' })
        ).toBeVisible({ timeout: 20_000 });

        // 8. Poll until the fake transcript session appears in the observability
        //    pipeline. Resolve the workspace id first, then repeatedly invoke
        //    summaryForWorkspace until it returns non-null (the polled UNC watcher
        //    fires after each ingest tick). Allow ~20s: WSL FS propagation +
        //    1500ms watcher poll + ingest + IPC round-trip.

        // Find the workspace id for 'wsl-e2e' from the live list.
        const wslWorkspaceId = await window.evaluate(async () => {
          type Api = { api: { workspace: { list: () => Promise<Array<{ id: string; name: string }>> } } };
          const list = await (window as unknown as Api).api.workspace.list();
          return list.find((w) => w.name === 'wsl-e2e')?.id ?? null;
        });

        // Loud non-null guard — fail early with a clear message rather than a
        // cryptic null-dereference inside the poll below.
        expect(wslWorkspaceId, 'created WSL workspace not found in workspace:list').not.toBeNull();

        await expect
          .poll(
            async () =>
              window.evaluate(async (targetId) => {
                type Api = {
                  api: {
                    observability: {
                      summaryForWorkspace: (id: string) => Promise<unknown | null>;
                    };
                  };
                };
                const summary = await (window as unknown as Api).api.observability.summaryForWorkspace(targetId!);
                return summary !== null;
              }, wslWorkspaceId),
            { timeout: 20_000, intervals: [500, 1_000, 2_000] }
          )
          .toBe(true);

        // 9. Pause → assert SIGSTOP (proc state = T) → resume → state back to S/R.
        const group = window.locator('.ws-chip-group', { hasText: 'wsl-e2e' });
        await group.locator('.ws-chip-menu-trigger').click();
        await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();

        // After pause, the pidfile should exist and the process should be in state T.
        // Allow up to 8s for the SIGSTOP to land (WSL process scheduling latency).
        // /proc/<pid>/stat field 3 is the process state character (T = stopped).
        const procStateScript = [
          'PIDF=$(ls /tmp/claude-fleet-*.pid 2>/dev/null | head -1)',
          '[ -n "$PIDF" ] || exit 1',
          'PID=$(cat "$PIDF")',
          'cut -d\\ -f3 /proc/$PID/stat',
        ].join('; ');

        const paused = await (async () => {
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            try {
              const state = execFileSync(
                'wsl.exe',
                ['-d', distro, '--', 'sh', '-c', procStateScript],
                { encoding: 'utf8', timeout: 5_000 }
              ).trim();
              if (state === 'T') return true;
            } catch { /* keep polling */ }
            await new Promise((r) => setTimeout(r, 500));
          }
          return false;
        })();

        expect(paused, 'process should be in state T (SIGSTOP) after Pause').toBe(true);

        // Resume — chip menu again.
        await group.locator('.ws-chip-menu-trigger').click();
        await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Resume' }).click();

        // State should return to S (sleeping) or R (running) within 5s.
        const resumed = await (async () => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try {
              const state = execFileSync(
                'wsl.exe',
                ['-d', distro, '--', 'sh', '-c', procStateScript],
                { encoding: 'utf8', timeout: 5_000 }
              ).trim();
              if (state === 'S' || state === 'R' || state === 'I') return true;
            } catch { /* keep polling */ }
            await new Promise((r) => setTimeout(r, 500));
          }
          return false;
        })();

        expect(resumed, 'process should be back to S/R/I (SIGCONT) after Resume').toBe(true);
      } finally {
        await app.close();
      }
    }
  );
});
