// index.ts's store boot (part 4b D50, D52, D53), checked by source text as
// indexQuitTimers.test.ts does: standing up the real main process needs
// Electron, Docker and a display.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const boot = src.slice(src.indexOf('app.whenReady().then('), src.indexOf("app.on('activate'"));

/** The source of `const <name> = …` inside the boot, up to its closing `};`. */
function closure(name: string): string {
  const start = boot.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`index.ts: no const ${name}`);
  const indent = boot.slice(boot.lastIndexOf('\n', start) + 1, start);
  const end = boot.indexOf(`\n${indent}};`, start);
  if (end < 0) throw new Error(`index.ts: no end of const ${name}`);
  return boot.slice(start, end);
}

/** Asserts each needle occurs in `text`, in this order. */
function inOrder(text: string, needles: string[]): void {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    expect(i, `${n} after the previous step`).toBeGreaterThan(at);
    at = i;
  }
}

describe('index.ts store boot', () => {
  it('keeps the SQLite boot order', () => {
    inOrder(boot, [
      'if (sqlite && !inboxElsewhere) {\n    // Authoritative inbox',
      'inboxStore = InboxStore.open(userData);',
      'if (sqlite) {\n      openDb(userData);\n      await startStateWrites();',
      "perfSpan('claude_fleet.boot.mcp_server'",
      'setQueryEmbedder(embedFn);',
      'if (sqlite && inboxStore) startClaims(inboxStore, embedFn);',
      "jsonlWatcher.on('ingest', ({ sessionId })",
      'setMcpStatusListener(',
      "perfSpan('claude_fleet.boot.workspace_sockets'",
      'ensureWorkspaceClaudeJson(',
      'await startWatcher(jsonlWatcher, manifests);',
      'await startCaptureScheduler(jsonlWatcher);',
      'registerLocalDirs(jsonlWatcher, manifests);',
      "perfSpanAsync('claude_fleet.boot.peer_status_start'",
      'if (sqlite) startEmbedBackfill(embedFn);',
      'instrumentIpcHandle(ipcMain);',
      "perfSpan('claude_fleet.boot.register_ipc'",
      'if (sqlite && inboxStore) startInboxServices(inboxStore);',
      'registerPresenceIpc(',
      'mainWindow = createWindow();',
      'startPresenceServices(mainWindow);',
      'void supervisor?.run();',
    ]);
  });

  it('never falls back to SQLite while Postgres is configured', () => {
    // The only SQLite inbox open is the SQLite boot's.
    expect(boot.match(/InboxStore\.open\(/g)).toHaveLength(1);
    expect(boot).toMatch(/if \(sqlite && !inboxElsewhere\) \{\n\s*\/\/ Authoritative inbox[\s\S]{0,200}?inboxStore = InboxStore\.open\(userData\);/);
    expect(boot.match(/openDb\(userData\)/g)).toHaveLength(1);
    expect(boot).toMatch(/const sqlite = storeCfg\.kind === 'sqlite';/);
    // A config error is the Quit dialog (or the user's explicit continue on unreadable JSON).
    expect(boot).toMatch(/catch \(e\) \{\s*logError\(\{ source: 'main', type: 'store-open-failed'[\s\S]*?storeStartupOutcome\(prompt, response\) === 'quit'/);
    expect(boot).toMatch(/if \(isMock\) storeCfg = \{ kind: 'sqlite' \};/);
  });

  it('a Postgres store comes up under the supervisor, after the window exists', () => {
    expect(boot).toMatch(/const sup = new StoreSupervisor<PgStores>\(/);
    inOrder(boot, ['mainWindow = createWindow();', 'void supervisor?.run();']);
    expect(boot).toMatch(/setActiveStore\(storeChoiceOf\(storeCfg\), \(\) => sup\.status\(\)/);
    expect(boot).toMatch(/sup\.on\('status', \(s: StoreStatus\) => broadcastStoreStatus\(s, BrowserWindow\.getAllWindows\(\)\)\)/);
    expect(boot).toMatch(/setActiveStoreConfig\(storeCfg\);/);
  });

  it('a SQLite start with the inbox on Postgres keeps the inbox closed and says so', () => {
    expect(boot).toMatch(/const inboxElsewhere = sqlite \? inboxOnPostgresNotice\(userData\) : null;/);
    expect(boot).toMatch(/setActiveStore\('sqlite', inboxElsewhere\s*\? \(\) => \(\{ choice: 'sqlite', phase: 'ready', detail: inboxElsewhere, progress: null, notice: inboxElsewhere \}\)/);
  });

  it('the services start as retried steps when the store is ready: inbox first, history gated, after the copy', () => {
    expect(boot.match(/setReadSource\(/g)).toHaveLength(1);
    expect(boot.match(/openDbPostgres\(/g)).toHaveLength(1);
    const steps = boot.slice(boot.indexOf('const services = new ServiceSteps<PgStores>(['), boot.indexOf('const quiesceStores'));
    inOrder(steps, [
      "name: 'claims', group: 'inbox'",
      "name: 'inbox-services', group: 'inbox', run: (s) => startInboxServices(s.inbox)",
      "name: 'presence', group: 'inbox'",
      "name: 'state-db', group: 'history', run: (s) => openDbPostgres(s.pool, { migrate: false, afterBeginWrite: historyGate.hook })",
      "name: 'state-writes', group: 'history'",
      "name: 'read-source', group: 'history', run: async (s) => setReadSource(await openPgMcpReadSource(",
      "name: 'watcher', group: 'history'",
      "name: 'local-dirs', group: 'history'",
      "name: 'capture-scheduler', group: 'inbox', after: ['claims', 'watcher']",
    ]);
    expect(boot).toMatch(/ready: async \(stores\) => \{\s*pgStores = stores;\s*inboxStore = stores\.inbox;\s*await services\.run\(stores\);\s*\}/);
    expect(boot).toMatch(/prepare: \(stores, onProgress\) => firstSwitchCopy\(/);
    expect(boot).toMatch(/startMcpServer\(userData, sqlite \? \{\} : \{ readSource: null \}\)/);
  });

  it('managed start progress reaches the status detail', () => {
    expect(closure('openStores')).toMatch(/const cfg = await resolveCfg\(progress\);/);
    expect(boot).toMatch(/ensureManagedPostgres\(\{[\s\S]*?onProgress: progress,/);
  });

  it('every Postgres inbox write passes the gate', () => {
    expect(closure('openStores')).toMatch(/afterBeginWrite: inboxGate\.hook,/);
  });

  it('the switch back quiesces inbox and history: gates closed, timers stopped, writes in flight drained', () => {
    inOrder(closure('quiesceStores'), ["inboxGate.close('", "historyGate.close('", 'stopInboxWriters();', 'await inboxGate.drain(stores.inbox.kysely);', 'await historyGate.drain(state);']);
    expect(closure('quiesceStores')).not.toMatch(/Gate\.open|startInboxServices|restartServices/);
  });

  it('a refused or failed switch back restarts the writers on Postgres; a committed one relaunches', () => {
    inOrder(closure('resumeWriters'), ['teardownInboxServices();', 'inboxGate.open();', 'historyGate.open();', "services.reset('inbox');", 'await supervisor?.restartServices();', 'replayInputWait();', 'jsonlWatcher?.requeueAll();']);
    const wiring = boot.slice(boot.indexOf('() => switchBackLive<PgStores>({'));
    expect(wiring).toMatch(/quiesce: quiesceStores,/);
    expect(wiring).toMatch(/resume: resumeWriters,/);
    expect(wiring).toMatch(/relaunch: \(\) => \{\s*app\.relaunch\(\);\s*app\.quit\(\);\s*\}/);
    expect(wiring).toMatch(/automationRunning: \(\) => auto\?\.automations\.hasActiveRuns\(\) \?\? false,/);
    expect(wiring).toMatch(/commit: \(\) => setStoreChoice\('sqlite'\),/);
    expect(wiring).toMatch(/copy: \(stores, commit\) => switchBackToSqlite\(\{ pool: stores\.pool, userData, commit,/);
    expect(wiring).toMatch(/stopBringUp: \(\) => sup\.stop\(\),/);
    expect(boot).toMatch(/pgCfg\.kind !== 'managed' \? undefined : \(\) => switchBackLive<PgStores>/);
  });

  it('inbox IPC is recorded so a switch back can register it again', () => {
    expect(closure('startInboxServices')).toMatch(/const scope = recordHandlers\(ipcMain, \(\) => \{\s*notifySvc = registerNotifyIpc\(inbox\);\s*auto = registerAutomationIpc\(inbox, notifySvc\);/);
    expect(closure('startInboxServices')).toMatch(/inboxTeardown\.push\(\(\) => scope\.dispose\(\)\);/);
  });

  it('recovery re-reads transcripts and refreshes the inbox', () => {
    expect(boot).toMatch(/recovered: \(\) => \{\s*jsonlWatcher\?\.requeueAll\(\);/);
  });

  it('quit is held once, bounded, ordered, and ends in app.exit (#485)', () => {
    const quit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('window-all-closed'"));
    inOrder(quit, [
      'if (shuttingDown) return;', 'shuttingDown = true;', 'e.preventDefault();', 'markQuitting();', 'supervisor?.stop();',
      'void withinMs((async () => {', 'await withinMs(supervisor.exclusive(async () => undefined)',
      'notifySvc?.stop()', 'inboxStore?.close()', 'await closeDb();', 'await pgStores?.end();', 'await stopManagedPostgres(managedDocker)',
      'QUIT_BOUND_MS)', '.then(() => app.exit(0));',
    ]);
    expect(src).toMatch(/const QUIT_BOUND_MS = 10_000;/);
  });
});
