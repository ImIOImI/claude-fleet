import { describe, expect, it } from 'vitest';
import type { StoreSettings, StoreStatus } from '../../preload/storeTypes';
import { STORE_CHOICES, storeBannerText, storeErrorText, storeNotices, storeSwitchConfirm, storeSwitchNote } from './storeView';

const st = (p: Partial<StoreStatus>): StoreStatus => ({ choice: 'managed', phase: 'ready', detail: null, progress: null, notice: null, ...p });
const settings = (p: Partial<StoreSettings>): StoreSettings => ({
  configured: 'managed', active: 'managed', restartRequired: false, status: st({}), notice: null, ...p,
});

describe('storeBannerText', () => {
  it('is silent on SQLite and when ready with nothing failed', () => {
    expect(storeBannerText(null)).toBeNull();
    expect(storeBannerText(st({ choice: 'sqlite', phase: 'ready' }))).toBeNull();
    expect(storeBannerText(st({ choice: 'sqlite', phase: 'down' }))).toBeNull();
    expect(storeBannerText(st({ phase: 'ready' }))).toBeNull();
  });
  it('names the phase, the copy progress and the reason', () => {
    expect(storeBannerText(st({ phase: 'starting' })))
      .toBe('Starting the Postgres store. History and inbox are unavailable until it is up.');
    expect(storeBannerText(st({ phase: 'starting', detail: 'pulling the image' })))
      .toBe('Starting the Postgres store (pulling the image). History and inbox are unavailable until it is up.');
    expect(storeBannerText(st({ phase: 'importing', progress: { source: 'state', table: 'events', copied: 1500, total: 20000 } })))
      .toBe('Copying your history to Postgres: events, 1,500 of 20,000 rows. History and inbox are unavailable until it finishes.');
    expect(storeBannerText(st({ phase: 'importing', progress: { source: 'inbox', table: 'todos', copied: 0, total: 3 } })))
      .toMatch(/^Copying your inbox to Postgres: todos, 0 of 3 rows\./);
    expect(storeBannerText(st({ phase: 'importing' }))).toMatch(/^Copying your inbox and history to Postgres\./);
    expect(storeBannerText(st({ phase: 'down', detail: 'Docker is not running: the managed Postgres store needs it' })))
      .toBe('Postgres store unreachable. History and inbox are unavailable: Docker is not running: the managed Postgres store needs it');
    expect(storeBannerText(st({ phase: 'down' }))).toBe('Postgres store unreachable. History and inbox are unavailable.');
  });
  it('shows a service that failed on a ready store, and a SQLite start whose inbox lives in Postgres', () => {
    expect(storeBannerText(st({ phase: 'ready', detail: 'History unavailable: db not opened' })))
      .toBe('Postgres store is up, but History unavailable: db not opened. Retrying.');
    expect(storeBannerText(st({ choice: 'sqlite', phase: 'ready', detail: 'The inbox lives in the Postgres store.' })))
      .toBe('The inbox lives in the Postgres store.');
  });
});

describe('storeSwitchNote', () => {
  it('describes the next start only when the choice changed', () => {
    expect(storeSwitchNote('sqlite', 'sqlite')).toBeNull();
    expect(storeSwitchNote('managed', 'managed')).toBeNull();
    expect(storeSwitchNote('sqlite', 'managed')).toMatch(/copies your SQLite inbox and history/);
    expect(storeSwitchNote('managed', 'sqlite')).toMatch(/uses SQLite again/);
    expect(storeSwitchNote('external', 'sqlite')).toMatch(/uses SQLite again/);
  });
});

describe('storeSwitchConfirm', () => {
  it('is null when nothing changes', () => {
    expect(storeSwitchConfirm('sqlite', 'sqlite', 'sqlite')).toBeNull();
    expect(storeSwitchConfirm('managed', 'managed', 'managed')).toBeNull();
  });
  it('to managed: writes config now; the copy, what carries over and the volume happen at the next start', () => {
    const c = storeSwitchConfirm('sqlite', 'sqlite', 'managed')!;
    expect(c.relaunches).toBe(false);
    const all = c.steps.join(' ');
    expect(all).toMatch(/next start/);
    expect(all).toMatch(/Docker/);
    expect(all).toMatch(/copies your SQLite inbox and history/);
    expect(all).toMatch(/inbox\.db\.migrated-<time>/);
    expect(all).toMatch(/renames, tags, tab links, port exposures and usage/i);
    expect(all).toMatch(/Summaries and embeddings regenerate in the background after a switch\./);
    expect(all).toMatch(/outlives uninstalling/);
    expect(c.confirmLabel).toBe('Switch at next start');
  });
  it('back to SQLite from a running Postgres store: copy back, then relaunch; refusals stay on Postgres', () => {
    const c = storeSwitchConfirm('managed', 'managed', 'sqlite')!;
    expect(c.relaunches).toBe(true);
    const all = c.steps.join(' ');
    expect(all).toMatch(/copies the Postgres inbox .* into a new inbox\.db/);
    expect(all).toMatch(/renames, tags, tab links, port exposures and usage/i);
    expect(all).toMatch(/relaunches/);
    expect(all).toMatch(/stays on Postgres/);
    expect(all).toMatch(/move inbox\.db \(with any inbox\.db-wal and inbox\.db-shm\) out of/);
    expect(all).toMatch(/claude-fleet-postgres-data/);
    expect(c.confirmLabel).toBe('Copy and relaunch');
  });
  it('undoing a choice that has not applied yet only rewrites config.json', () => {
    const c = storeSwitchConfirm('sqlite', 'managed', 'sqlite')!;
    expect(c.relaunches).toBe(false);
    expect(c.steps.join(' ')).toMatch(/Nothing is copied/);
    expect(storeSwitchConfirm('managed', 'sqlite', 'managed')!.steps.join(' ')).toMatch(/Nothing is copied/);
  });
});

describe('storeNotices', () => {
  it('lists the last change outcome and the store notice, without duplicates', () => {
    expect(storeNotices(settings({}))).toEqual([]);
    expect(storeNotices(settings({ notice: 'a', status: st({ notice: 'b' }) }))).toEqual(['a', 'b']);
    expect(storeNotices(settings({ notice: 'same', status: st({ notice: 'same' }) }))).toEqual(['same']);
  });
});

describe('STORE_CHOICES', () => {
  it('offers SQLite and the managed container, and says what the managed store needs', () => {
    expect(STORE_CHOICES.map((c) => c.id)).toEqual(['sqlite', 'managed']);
    const managed = STORE_CHOICES[1].desc;
    expect(managed).toMatch(/needs Docker running/);
    expect(managed).toMatch(/other database roles .* see no history rows/i);
    expect(managed).toMatch(/outlives uninstalling/);
  });
});

describe('storeErrorText', () => {
  it('drops the IPC wrapper', () => {
    expect(storeErrorText(new Error("Error invoking remote method 'store:setChoice': Error: config.json is unreadable"))).toBe('config.json is unreadable');
    expect(storeErrorText('plain')).toBe('plain');
  });
});
