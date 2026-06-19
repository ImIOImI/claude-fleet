// JsonlWatcher behavior against the real DB + chokidar — pre-existing
// JSONLs at startup, late-created workspace dirs. Skips mock mode
// (mock backend disables the watcher + DB per src/main/index.ts).

import { _electron as electron, test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

// Shared: env with CLAUDE_FLEET_MOCK stripped so the real watcher + DB run.
const realBackendEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
  ) as Record<string, string>;

const assistantEvent = (): string =>
  JSON.stringify({
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
  }) + '\n';

const summaryForWorkspace = (window: import('@playwright/test').Page, id: string): Promise<unknown> =>
  window.evaluate(async (n) => {
    type Api = { api: { observability: { summaryForWorkspace: (n: string) => Promise<unknown> } } };
    return (window as unknown as Api).api.observability.summaryForWorkspace(n);
  }, id);

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
  // State dirs keyed by id (the new ULID-shape identity). The startup
  // migration leaves these alone since the manifests already carry a
  // matching `id` + the new `env` field.
  const writeWorkspace = (id: string, name: string): string => {
    const stateDir = path.join(userDataDir, 'state', id);
    const jsonlDir = path.join(stateDir, '.claude', 'projects', '-workspace');
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'workspace.json'),
      JSON.stringify({
        id,
        name,
        labels: [],
        workspaceRoot: '/tmp/fleet-test-' + name,
        workspaceSubdir: '',
        kind: 'container',
        image: 'mock',
        authMode: 'oauth',
        env: { plain: {}, secretKeys: [] },
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

  // Use 26-char Crockford-base32 ids so the migration's path-shape check
  // recognizes them as already-migrated. Pad with leading chars; the
  // content is opaque to the test.
  const idAlpha = '01TESTALPHA00000000000000A';
  const idBeta = '01TESTBETA0000000000000000';
  writeWorkspace(idAlpha, 'watcher-alpha');
  writeWorkspace(idBeta, 'watcher-beta');

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
            }, idAlpha),
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
            }, idBeta)
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
  // State dir keyed by id (ULID-shape) so the startup migration treats
  // the pre-seeded manifest as already-current.
  const id = '01TESTLATECREATE0000000000';
  const name = 'late-create-ws';
  const stateDir = path.join(userDataDir, 'state', id);
  // Manifest exists at launch (workspace would have been created in a
  // prior session or earlier in this session) but the projects subdir
  // does NOT exist yet — claude hasn't written anything in this
  // workspace yet.
  mkdirSync(path.join(stateDir, '.claude'), { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name,
      labels: [],
      workspaceRoot: '/tmp/fleet-test-' + name,
      workspaceSubdir: '',
      kind: 'container',
      image: 'mock',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
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
          }, id);
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('Watcher: writes a durable mirror for mirror=on, none for mirror=off', async () => {
  // End-to-end through the REAL watcher + DB + mirrorPolicy (#10): a workspace
  // whose manifest says mirror.default='on' gets its transcript mirrored to the
  // host-private _history/ dir; one with 'off' does not. index.ts seeds the
  // per-workspace mirror default from the manifest before the watcher starts,
  // so this holds even with Docker unreachable (no renderer workspace:list).
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-mirror-'));

  const seed = (id: string, name: string, mirror: { default: string; cleanup: string }) => {
    const stateDir = path.join(userDataDir, 'state', id);
    const jsonlDir = path.join(stateDir, '.claude', 'projects', '-workspace');
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'workspace.json'),
      JSON.stringify({
        id,
        name,
        labels: [],
        workspaceRoot: '/tmp/fleet-test-' + name,
        workspaceSubdir: '',
        kind: 'container',
        image: 'mock',
        authMode: 'oauth',
        env: { plain: {}, secretKeys: [] },
        mirror,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      })
    );
    const session = randomUUID();
    // Pre-write the JSONL so the watcher ingests it at startup (ignoreInitial:
    // false), after index.ts has seeded the mirror policy from the manifest.
    writeFileSync(path.join(jsonlDir, `${session}.jsonl`), assistantEvent());
    return { stateDir, session };
  };

  const onId = '01TESTMIRRORON000000000000';
  const offId = '01TESTMIRROROFF0000000000A';
  const on = seed(onId, 'mirror-on', { default: 'on', cleanup: 'delete' });
  const off = seed(offId, 'mirror-off', { default: 'off', cleanup: 'delete' });

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: realBackendEnv()
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Both JSONLs ingested → the watcher's readAndIngest (which also does the
    // mirror append) has run for both sessions.
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([
            summaryForWorkspace(window, onId),
            summaryForWorkspace(window, offId)
          ]);
          return a !== null && b !== null;
        },
        { timeout: 12_000, intervals: [200, 500, 1000] }
      )
      .toBe(true);

    // mirror=on → host-private mirror file exists and carries the event.
    const onMirror = path.join(on.stateDir, '_history', `${on.session}.jsonl`);
    await expect.poll(() => existsSync(onMirror), { timeout: 5_000 }).toBe(true);
    expect(readFileSync(onMirror, 'utf8')).toContain('assistant');

    // mirror=off → no mirror file (ingestion already confirmed above).
    expect(existsSync(path.join(off.stateDir, '_history', `${off.session}.jsonl`))).toBe(false);
  } finally {
    await app.close();
  }
});
