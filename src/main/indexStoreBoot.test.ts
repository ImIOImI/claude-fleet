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
      'if (sqlite) {\n    // Authoritative inbox',
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
    // The only SQLite inbox opens: the SQLite boot, and the committed switch back.
    expect(boot.match(/InboxStore\.open\(/g)).toHaveLength(2);
    expect(boot).toMatch(/if \(sqlite\) \{\n\s*\/\/ Authoritative inbox[\s\S]{0,200}?inboxStore = InboxStore\.open\(userData\);/);
    expect(closure('resumeInbox')).toMatch(/if \(on === 'sqlite'\) \{[\s\S]*?InboxStore\.open\(userData\)/);
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

  it('the MCP read source and history open only when the store is ready, after the copy', () => {
    expect(boot.match(/setReadSource\(/g)).toHaveLength(1);
    expect(boot.match(/openDbPostgres\(/g)).toHaveLength(1);
    const ready = boot.slice(boot.indexOf('ready: async (stores) => {'), boot.indexOf('ping: (stores) =>'));
    inOrder(ready, ['await openDbPostgres(stores.pool, { migrate: false });', 'await startStateWrites();', 'setReadSource(await openPgMcpReadSource(', 'await startWatcher(', 'startInboxServices(stores.inbox);']);
    expect(boot).toMatch(/startMcpServer\(userData, sqlite \? \{\} : \{ readSource: null \}\)/);
  });

  it('every Postgres inbox write passes the gate', () => {
    expect(closure('openStores')).toMatch(/afterBeginWrite: inboxGate\.hook,/);
  });

  it('the switch back quiesces: gate closed, timers stopped, writes in flight drained', () => {
    inOrder(closure('quiesceInbox'), ["inboxGate.close('", 'stopInboxWriters();', 'await inboxGate.drain(stores.inbox.kysely);']);
    expect(closure('quiesceInbox')).not.toMatch(/inboxGate\.open|startInboxServices/);
  });

  it('writers restart only through resumeInbox, after tearing down the old ones', () => {
    const resume = closure('resumeInbox');
    inOrder(resume, ['teardownInboxServices();', "if (on === 'sqlite')", 'inboxGate.open();', 'startInboxServices(inboxStore);']);
    const wiring = boot.slice(boot.indexOf('() => switchBackLive<PgStores>({'));
    expect(wiring).toMatch(/quiesce: quiesceInbox,/);
    expect(wiring).toMatch(/resume: resumeInbox,/);
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

  it('quit stops the supervisor first and the managed container last', () => {
    const quit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('window-all-closed'"));
    inOrder(quit, ['markQuitting();', 'supervisor?.stop();', 'notifySvc?.stop()', 'inboxStore?.close()', 'await pgStores?.end();', 'await stopManagedPostgres(managedDocker)']);
  });
});
