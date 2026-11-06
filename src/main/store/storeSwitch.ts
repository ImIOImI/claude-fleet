// Settings → Storage's switch from a running Postgres store back to SQLite
// (part 4b D53). Inbox and history writers stop before the copy (and before the
// D54 merge reads Postgres); a committed switch then relaunches the app, so
// nothing writes the store it left. A failure restarts the writers on Postgres.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreChoice } from '../../preload/storeTypes.js';
import type { SwitchBackOutcome, SwitchBackPlan } from './firstSwitch.js';
import { INBOX_PG_MARKER } from './sqliteFiles.js';

export interface SwitchResult {
  switched: boolean;
  /** What the user should know: a refusal, a failure, or what was kept. */
  notice: string | null;
}

export interface SwitchBackDeps<S> {
  /** Runs `fn` with the bring-up and pings held; `stores` is null until the store is ready. */
  exclusive<T>(fn: (stores: S | null) => Promise<T>): Promise<T>;
  plan(): SwitchBackPlan;
  /** The marker that says the Postgres inbox is the live one. */
  postgresInboxLive(): boolean;
  /** Open the store just for the copy, when the supervisor never got it ready. */
  open(): Promise<S>;
  close(stores: S): Promise<void>;
  /** Refuse new inbox and history writes, stop the timers, wait for writes in flight. */
  quiesce(stores: S): Promise<void>;
  /** Checked once quiesced: a run in progress would lose its result. */
  automationRunning(): boolean;
  /** switchBackToSqlite; `commit` runs only once inbox.db is in place. */
  copy(stores: S, commit: () => Promise<void>): Promise<SwitchBackOutcome>;
  /** Writes config.json's choice. */
  commit(): Promise<void>;
  /** After a failed or refused switch: the writers start again on Postgres. */
  resume(): Promise<void>;
  /** No bring-up may run once SQLite is chosen: its copy would retire the new inbox.db. */
  stopBringUp(): void;
  /** Restart on the committed choice. */
  relaunch(): void;
}

export const AUTOMATION_RUNNING = 'An automation is running; switch when it finishes.';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const stays = (why: string): string => `Not switched; the app stays on Postgres: ${why}`;

export async function switchBackLive<S>(d: SwitchBackDeps<S>): Promise<SwitchResult> {
  return d.exclusive(async (live) => {
    if (live) return copyBack(d, live, true);
    const plan = d.plan();
    if (plan.kind === 'refuse') return { switched: false, notice: plan.notice };
    if (plan.kind === 'keep-inbox-db' || !d.postgresInboxLive()) {
      await d.commit();
      d.stopBringUp();
      d.relaunch();
      return { switched: true, notice: plan.kind === 'keep-inbox-db' ? plan.notice : null };
    }
    let opened: S;
    try {
      opened = await d.open();
    } catch (e) {
      return { switched: false, notice: stays(`the inbox lives in Postgres, which can't be reached (${message(e)}).`) };
    }
    try {
      const r = await copyBack(d, opened, false);
      if (r.switched) d.stopBringUp();
      return r;
    } finally {
      await d.close(opened).catch(() => undefined);
    }
  });
}

async function copyBack<S>(d: SwitchBackDeps<S>, stores: S, writersLive: boolean): Promise<SwitchResult> {
  if (writersLive) {
    try {
      await d.quiesce(stores);
    } catch (e) {
      await d.resume();
      return { switched: false, notice: stays(message(e)) };
    }
    if (d.automationRunning()) {
      await d.resume();
      return { switched: false, notice: AUTOMATION_RUNNING };
    }
  }
  let out: SwitchBackOutcome;
  try {
    out = await d.copy(stores, () => d.commit());
  } catch (e) {
    if (writersLive) await d.resume();
    return { switched: false, notice: stays(message(e)) };
  }
  if (out.status !== 'switched') {
    if (writersLive) await d.resume();
    return { switched: false, notice: out.notice };
  }
  d.relaunch();
  return { switched: true, notice: out.notice ?? null };
}

/** A SQLite start whose inbox lives in Postgres: the inbox stays closed rather than starting empty. */
export function inboxOnPostgresNotice(userData: string): string | null {
  if (!existsSync(join(userData, INBOX_PG_MARKER))) return null;
  return `The inbox lives in the Postgres store (${join(userData, INBOX_PG_MARKER)} says so), so it is unavailable on SQLite. `
    + 'Choose Postgres in Settings → Storage and restart to use it, or switch back to SQLite from a Postgres start to copy it here.';
}

export interface ChoiceDeps {
  configured: StoreChoice;
  /** What this run opened. */
  active: StoreChoice;
  write(choice: 'sqlite' | 'managed'): Promise<void>;
  /** Set while a managed store runs: leaving it must carry the inbox back first. */
  switchBack: (() => Promise<SwitchResult>) | null;
}

/** store:setChoice. Returns the notice for Settings, or null. */
export async function applyStoreChoice(choice: 'sqlite' | 'managed', d: ChoiceDeps): Promise<string | null> {
  if (choice === d.configured) return null;
  if (choice === 'sqlite' && d.active !== 'sqlite' && d.switchBack) return (await d.switchBack()).notice;
  await d.write(choice);
  return null;
}
