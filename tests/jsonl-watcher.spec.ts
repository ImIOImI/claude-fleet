// JsonlWatcher behavior against the real DB + chokidar — pre-existing
// JSONLs at startup, late-created workspace dirs. Skips mock mode
// (mock backend disables the watcher + DB per src/main/index.ts).

import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

test('Watcher: ingests JSONL events for every workspace manifest, not just the first', async () => {
  // Regression guard for the "plucky-lemur has JSONLs on disk but
  // summaryForWorkspace returns null" bug. With multiple workspace
  // manifests present at app startup, `jsonlWatcher.start(names)`
  // iterates `for (const name of names) registerWorkspace(name)`. Each
  // registerWorkspace adds a chokidar watch on that workspace's
  // `<state>/<name>/.claude/projects/-workspace/` dir; chokidar's
  // `ignoreInitial: false` should fire 'add' events for existing JSONL
  // files in each watched dir at watcher startup.
  //
  // What the user observed: with 2 workspaces, only the first
  // (gentle-crane) had events ingested into the DB; the second
  // (plucky-lemur) had identical filesystem structure but zero rows
  // in `events`/`sessions`. Possibly a chokidar quirk with multi-add
  // at startup, possibly something in our registerWorkspace path —
  // this test will tell us.
  //
  // Test design: pre-populate a fresh userDataDir with manifests +
  // existing JSONLs for two synthetic workspaces, then launch the app.
  // The watcher should pick up the existing files (ignoreInitial:false)
  // and ingest them. After launch, summaryForWorkspace must return
  // non-null for BOTH workspaces.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-watcher-'));
  const writeWorkspace = (name: string): string => {
    const stateDir = path.join(userDataDir, 'state', name);
    const jsonlDir = path.join(stateDir, '.claude', 'projects', '-workspace');
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'workspace.json'),
      JSON.stringify({
        name,
        workspaceRoot: '/tmp/fleet-test-' + name,
        workspaceSubdir: '',
        profile: 'oauth',
        kind: 'container',
        image: 'mock',
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      })
    );
    const sessionId = randomUUID();
    const event = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard'
        }
      }
    };
    writeFileSync(path.join(jsonlDir, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');
    return sessionId;
  };

  writeWorkspace('watcher-alpha');
  writeWorkspace('watcher-beta');

  // Launch with the pre-populated userDataDir. No CLAUDE_FLEET_MOCK —
  // we need the real watcher + DB. Docker being unreachable is fine
  // (workspaces with no live container appear as "deleted" in the list,
  // but the watcher only cares about manifests + JSONLs on disk).
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    // Strip CLAUDE_FLEET_MOCK so this test exercises the REAL JsonlWatcher
    // (mock mode skips watcher+DB entirely per main/index.ts). The
    // mock-mode env var leaks in from the outer suite runner; the
    // watcher itself doesn't depend on Docker so the test runs fine
    // without it.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Wait for the watcher to ingest both workspaces' pre-existing
    // JSONLs. summaryForWorkspace polls the DB; when both return
    // non-null, ingestion has reached both.
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([
            window.evaluate(async (name) => {
              type Api = {
                api: {
                  observability: {
                    summaryForWorkspace: (n: string) => Promise<unknown>;
                  };
                };
              };
              return await (window as unknown as Api).api.observability.summaryForWorkspace(
                name
              );
            }, 'watcher-alpha'),
            window.evaluate(async (name) => {
              type Api = {
                api: {
                  observability: {
                    summaryForWorkspace: (n: string) => Promise<unknown>;
                  };
                };
              };
              return await (window as unknown as Api).api.observability.summaryForWorkspace(
                name
              );
            }, 'watcher-beta')
          ]);
          return { alphaNull: a === null, betaNull: b === null };
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toEqual({ alphaNull: false, betaNull: false });
  } finally {
    await app.close();
  }
});

test('Watcher: picks up JSONLs written to a workspace whose dir was missing at registerWorkspace time', async () => {
  // The user's real-world scenario: workspace gets created (so
  // `registerWorkspace(name)` runs and calls `chokidar.add(dir)`), but
  // the `.claude/projects/-workspace/` dir doesn't yet exist on disk —
  // claude inside the container hasn't run for the first time. Later
  // (could be seconds or hours), claude writes its first JSONL into
  // that path. If chokidar's `add()` on a missing path gives up
  // silently rather than waiting for the dir to be created, the
  // watcher never sees the JSONLs and `summaryForWorkspace` keeps
  // returning null. That's the plucky-lemur symptom.
  //
  // This test pre-creates the manifest but NOT the projects dir, then
  // creates the dir + JSONL after launch and asserts the watcher
  // catches it.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-watcher-late-'));
  const name = 'late-create-ws';
  const stateDir = path.join(userDataDir, 'state', name);
  // Manifest exists at launch (workspace would have been created in a
  // prior session or earlier in this session) but the projects subdir
  // does NOT exist yet — claude hasn't written anything in this
  // workspace yet.
  mkdirSync(path.join(stateDir, '.claude'), { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      name,
      workspaceRoot: '/tmp/fleet-test-' + name,
      workspaceSubdir: '',
      profile: 'oauth',
      kind: 'container',
      image: 'mock',
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Let the app's startup complete (watcher initialized, registerWorkspace
    // called for our late-create-ws name, chokidar.add() on the missing
    // projects dir).
    await new Promise((r) => setTimeout(r, 500));

    // Now simulate claude inside the container creating its projects
    // dir and writing a JSONL. The watcher SHOULD pick this up if it
    // properly handles late-created paths.
    const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
    mkdirSync(projectsDir, { recursive: true });
    const sessionId = randomUUID();
    const event = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard'
        }
      }
    };
    writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');

    // Watcher must catch this within a reasonable window. chokidar can
    // take a moment to notice newly-created dirs depending on its
    // polling/native-fs mode; 8s is generous.
    await expect
      .poll(
        async () => {
          return await window.evaluate(async (n) => {
            type Api = {
              api: {
                observability: { summaryForWorkspace: (n: string) => Promise<unknown> };
              };
            };
            const s = await (window as unknown as Api).api.observability.summaryForWorkspace(
              n
            );
            return s !== null;
          }, name);
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});
