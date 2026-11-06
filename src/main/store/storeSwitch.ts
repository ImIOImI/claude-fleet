// Settings → Storage's switch from a running Postgres store back to SQLite
// (part 4b D53). The inbox writers stop before the copy and start again only
// once it has committed or failed, so no write lands in a store the copy has
// already read.
import type { StoreChoice } from '../../preload/storeTypes.js';
import type { SwitchBackOutcome, SwitchBackPlan } from './firstSwitch.js';

export interface SwitchResult {
  switched: boolean;
  /** What the user should know: a refusal, a failure, or what was kept. */
  notice: string | null;
}

export interface SwitchBackDeps<S> {
  /** Where the inbox lives in this run. */
  inboxOn(): 'postgres' | 'sqlite' | null;
  /** Runs `fn` with the bring-up and pings held; `stores` is null until the store is ready. */
  exclusive<T>(fn: (stores: S | null) => Promise<T>): Promise<T>;
  plan(): SwitchBackPlan;
  /** The marker that says the Postgres inbox is the live one. */
  postgresInboxLive(): boolean;
  /** Open the store just for the copy, when the supervisor never got it ready. */
  open(): Promise<S>;
  close(stores: S): Promise<void>;
  /** Refuse new inbox writes, stop the timers, wait for writes in flight. */
  quiesce(stores: S): Promise<void>;
  /** switchBackToSqlite; `commit` runs only once inbox.db is in place. */
  copy(stores: S, commit: () => Promise<void>): Promise<SwitchBackOutcome>;
  /** Writes config.json's choice. */
  commit(): Promise<void>;
  /** Start the inbox writers again, on the store the inbox now lives in. */
  resume(on: 'postgres' | 'sqlite'): Promise<void>;
  /** No bring-up may run once SQLite is chosen: its copy would retire the new inbox.db. */
  stopBringUp(): void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const stays = (why: string): string => `Not switched; the app stays on Postgres: ${why}`;

export async function switchBackLive<S>(d: SwitchBackDeps<S>): Promise<SwitchResult> {
  if (d.inboxOn() === 'sqlite') {
    await d.commit();
    return { switched: true, notice: null };
  }
  return d.exclusive(async (live) => {
    if (live) return copyBack(d, live, true);
    const plan = d.plan();
    if (plan.kind === 'refuse') return { switched: false, notice: plan.notice };
    if (plan.kind === 'keep-inbox-db' || !d.postgresInboxLive()) {
      await d.commit();
      d.stopBringUp();
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
  if (writersLive) await d.quiesce(stores);
  let out: SwitchBackOutcome;
  try {
    out = await d.copy(stores, () => d.commit());
  } catch (e) {
    if (writersLive) await d.resume('postgres');
    return { switched: false, notice: stays(message(e)) };
  }
  if (out.status !== 'switched') {
    if (writersLive) await d.resume('postgres');
    return { switched: false, notice: out.notice };
  }
  if (writersLive) await d.resume('sqlite');
  return { switched: true, notice: out.notice ?? null };
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
