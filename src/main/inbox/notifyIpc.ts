// Electron wiring for notifications (#407 Phase 2): delivery (in-app toast when
// the window is focused, OS notification otherwise), `notifications:*` IPC,
// the 30 s quiet/digest ticker, daily retention prune, and the input-wait hook.
import { BrowserWindow, ipcMain, Notification } from 'electron';
import type {
  Downtime, NotificationRow, NotifyLevel, PauseState, RuleScopeKind, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';
import { listWorkspaceManifests } from '../workspaces.js';
import { setInputWaitObserver } from '../ipc.js';
import { logError } from '../errorLog.js';
import type { InboxStore } from './inboxDb.js';
import { NotifyStore } from './notifyStore.js';
import { createNotifyService, type NotifyService } from './notifyService.js';
import { emitInboxChanged, inboxEvents } from './inboxEvents.js';

const LEVELS = new Set<NotifyLevel>(['all', 'high', 'urgent', 'off']);
const SCOPES = new Set<RuleScopeKind>(['key', 'source', 'tag']);

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send(channel, payload);
    } catch {
      // window mid-teardown
    }
  }
}

function focusMain(): BrowserWindow | null {
  const w = BrowserWindow.getAllWindows()[0] ?? null;
  if (!w) return null;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
}

/** Wire notifications. Returns the service so inboxIpc can route post side-effects. */
export function registerNotifyIpc(inbox: InboxStore): NotifyService & { stop(): void } {
  const store = new NotifyStore(inbox.kysely);
  const names = new Map<string, string>();
  const refreshNames = () =>
    listWorkspaceManifests()
      .then((ms) => { for (const m of ms) names.set(m.id, m.name); })
      .catch(() => {});
  void refreshNames();
  const viewing = { workspaceId: null as string | null, inboxOpen: false };
  const live: Notification[] = [];
  const warn = (type: string) => (e: unknown) => logError({ source: 'main', type, level: 'warn', message: String(e) });

  const svc = createNotifyService({
    store,
    now: Date.now,
    name: (id) => names.get(id) ?? 'a workspace',
    viewing: () => ({ focused: BrowserWindow.getAllWindows().some((w) => w.isFocused()), ...viewing }),
    changed: () => {
      void svc.quietState().then((q) => send('notifications:changed', q), warn('notify-changed'));
      emitInboxChanged();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    onError: warn('notify-timer'),
    deliver: (n: NotificationRow) => {
      const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
      if (focused || !Notification.isSupported()) {
        send('notifications:toast', n);
        return 'in-app';
      }
      const os = new Notification({ title: n.title, body: n.body ?? '', silent: n.priority === 'low' });
      os.on('click', () => {
        focusMain();
        send('notifications:open', { notificationId: n.id, todoId: n.todoId, workspaceId: n.workspaceId, kind: n.kind });
      });
      os.on('close', () => {
        const i = live.indexOf(os);
        if (i >= 0) live.splice(i, 1);
      });
      live.push(os); // keep a reference so the click handler survives GC
      if (live.length > 20) live.shift();
      os.show();
      if (n.priority === 'urgent') inboxEvents.emit('attention');
      return 'os';
    }
  });

  setInputWaitObserver((workspaceId, ids) => {
    if (!names.has(workspaceId)) void refreshNames();
    svc.onInputWait(workspaceId, ids).catch(warn('notify-input-wait'));
    emitInboxChanged();
  });

  // Quit (#457): stop() flips `stopped` and clears both intervals so a tick
  // already queued when stop() runs is a no-op, and cancels the input-wait
  // timers — all before the main process closes inbox.db.
  let stopped = false;
  const tick = setInterval(() => { if (!stopped) svc.tick().catch(warn('notify-tick')); }, 30_000);
  tick.unref?.();
  svc.prune().catch(warn('notify-prune'));
  const daily = setInterval(() => { if (!stopped) svc.prune().catch(() => { /* next day */ }); }, 86_400_000);
  daily.unref?.();

  const settings = async () => {
    const [defaultLevel, q, downtimes, rules] = await Promise.all([store.getDefaultLevel(), svc.quietState(), store.downtimes(), store.rules()]);
    return { defaultLevel, pause: q.pause, downtimes, rules };
  };
  const after = async <T>(v: T | Promise<T>): Promise<T> => {
    const r = await v;
    await svc.tick();
    send('notifications:changed', await svc.quietState());
    return r;
  };

  ipcMain.handle('notifications:list', (_e, filter?: 'all' | 'delivered' | 'held', limit?: number) => store.list({ filter, limit }));
  ipcMain.handle('notifications:settings', () => settings());
  ipcMain.handle('notifications:quietState', () => svc.quietState());
  ipcMain.handle('notifications:scopesFor', (_e, item: { source: TodoSource; dedupeKey: string | null; tags: string[] }) => svc.scopesFor(item));
  ipcMain.handle('notifications:effective', (_e, item: { priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }) => svc.effectiveFor(item));
  ipcMain.handle('notifications:effectiveMany', (_e, items: Array<{ id: string; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }>) =>
    svc.effectiveForMany(items ?? []));
  ipcMain.handle('notifications:setRule', (_e, r: { scopeKind: RuleScopeKind; scopeValue: string; level: NotifyLevel; snoozeUntil?: number | null }) => {
    if (!SCOPES.has(r?.scopeKind) || typeof r.scopeValue !== 'string' || !LEVELS.has(r.level)) throw new Error('invalid rule');
    return after(store.setRule({ scopeKind: r.scopeKind, scopeValue: r.scopeValue, level: r.level, snoozeUntil: r.snoozeUntil ?? null }));
  });
  ipcMain.handle('notifications:removeRule', (_e, id: string) => after(store.removeRule(id)));
  ipcMain.handle('notifications:setDefaultLevel', (_e, level: NotifyLevel) => {
    if (!LEVELS.has(level)) throw new Error('invalid level');
    return after(store.setDefaultLevel(level));
  });
  ipcMain.handle('notifications:pause', async (_e, p: { until: number | null; letUrgent: boolean }) => {
    const pause: PauseState = { until: typeof p?.until === 'number' ? p.until : null, letUrgent: p?.letUrgent === true, setAt: Date.now() };
    await store.setPause(pause);
    return after(pause);
  });
  ipcMain.handle('notifications:resume', async () => {
    await store.clearPause();
    return after(null);
  });
  ipcMain.handle('notifications:saveDowntime', (_e, d: Omit<Downtime, 'id'> & { id?: string }) => {
    if (!d || !Array.isArray(d.days) || typeof d.startMin !== 'number' || typeof d.endMin !== 'number') throw new Error('invalid downtime');
    const bypass = d.bypass === 'urgent' || d.bypass === 'urgent+input' ? d.bypass : 'none';
    return after(store.saveDowntime({ ...d, bypass, enabled: d.enabled !== false, name: String(d.name ?? '') }));
  });
  ipcMain.handle('notifications:removeDowntime', (_e, id: string) => after(store.removeDowntime(id)));
  ipcMain.handle('notifications:test', () => svc.test());
  ipcMain.handle('notifications:setViewing', (_e, v: { workspaceId: string | null; inboxOpen: boolean }) => {
    viewing.workspaceId = typeof v?.workspaceId === 'string' ? v.workspaceId : null;
    viewing.inboxOpen = v?.inboxOpen === true;
  });
  ipcMain.handle('notifications:permission', () => ({ supported: Notification.isSupported() }));

  /** Quit (#457): idempotent — clears both intervals and the pending input-wait timers. */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    clearInterval(daily);
    svc.cancelPending();
  }

  return Object.assign(svc, { stop });
}
