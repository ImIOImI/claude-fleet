// Text for Settings › Storage and the store banner. Pure, so it unit-tests.
import type { StoreChoice, StoreSettings, StoreStatus } from '../../preload/storeTypes';

export type SettableChoice = Exclude<StoreChoice, 'external'>;

const CARRIED = 'Renames, tags, tab links, port exposures and usage carry over.';
const REGENERATE = 'Summaries and embeddings regenerate in the background after a switch.';
const VOLUME =
  'The Postgres data stays in the Docker volume claude-fleet-postgres-data, which outlives uninstalling the app ' +
  '(docker volume rm claude-fleet-postgres-data removes it).';

export const STORE_CHOICES: ReadonlyArray<{ id: SettableChoice; label: string; desc: string }> = [
  {
    id: 'sqlite',
    label: 'SQLite (built in)',
    desc: 'History and inbox live in files in the app data folder. No setup, and works without Docker.',
  },
  {
    id: 'managed',
    label: 'Postgres, managed by claude-fleet',
    desc:
      'A local Postgres + pgvector container that the app starts and stops, reachable only on 127.0.0.1. ' +
      'It needs Docker running: while Docker is down, history and inbox are unavailable. ' +
      'Other database roles you add (for reporting, say) see no history rows unless given their own row policy. ' +
      'Its data volume outlives uninstalling the app.',
  },
];

/** What the next start does after a switch, or null when nothing changes. */
export function storeSwitchNote(active: StoreChoice, configured: StoreChoice): string | null {
  if (active === configured) return null;
  if (configured === 'managed') {
    return 'At the next start the app starts the container and copies your SQLite inbox and history into it.';
  }
  if (configured === 'sqlite') return 'At the next start the app uses SQLite again.';
  return null;
}

export interface StoreSwitchConfirm {
  title: string;
  steps: string[];
  confirmLabel: string;
  /** The switch copies now and the app relaunches itself when it succeeds. */
  relaunches: boolean;
}

/** The confirm shown before `store:setChoice`, or null when `choice` is already configured. */
export function storeSwitchConfirm(active: StoreChoice, configured: StoreChoice, choice: SettableChoice): StoreSwitchConfirm | null {
  if (choice === configured) return null;
  if (choice === active) {
    return {
      title: choice === 'sqlite' ? 'Keep SQLite' : 'Keep Postgres',
      steps: [`The switch chosen earlier hasn't applied yet; config.json names ${choice === 'sqlite' ? 'SQLite' : 'Postgres'} again. Nothing is copied.`],
      confirmLabel: 'Keep',
      relaunches: false,
    };
  }
  if (choice === 'managed') {
    return {
      title: 'Switch to managed Postgres',
      steps: [
        'Now: config.json is updated. Nothing else changes until the next start.',
        'At the next start the app starts the claude-fleet-postgres container (Docker must be running) and copies your SQLite inbox and history into it. ' +
          'A banner shows the copy; history and inbox are unavailable until it finishes. An interrupted copy resumes.',
        'inbox.db then moves into inbox.db.migrated-<time>/ in the app data folder; state.db stays as the cache a switch back resumes from.',
        `${CARRIED} ${REGENERATE}`,
        VOLUME,
      ],
      confirmLabel: 'Switch at next start',
      relaunches: false,
    };
  }
  if (active === 'managed') {
    return {
      title: 'Switch back to SQLite',
      steps: [
        'Now: inbox and history writes pause, and the app copies the Postgres inbox (todos, automations, proposals, notifications) into a new inbox.db. ' +
          'Renames, tags, tab links, port exposures and usage merge into state.db. Then the app relaunches on SQLite.',
        `History resumes from state.db and the transcripts. ${REGENERATE}`,
        'If the copy fails or an automation is running, nothing changes and the app stays on Postgres. ' +
          'If inbox.db in the app data folder already holds a separate inbox, the switch is refused: quit the app and move inbox.db ' +
          '(with any inbox.db-wal and inbox.db-shm) out of the app data folder first.',
        VOLUME,
      ],
      confirmLabel: 'Copy and relaunch',
      relaunches: true,
    };
  }
  return {
    title: 'Switch to SQLite',
    steps: ['Now: config.json is updated. At the next start the app uses the SQLite files; nothing is copied from the external Postgres store.'],
    confirmLabel: 'Switch at next start',
    relaunches: false,
  };
}

/** The banner under the strip, or null when there is nothing to say. */
export function storeBannerText(s: StoreStatus | null): string | null {
  if (!s) return null;
  if (s.choice === 'sqlite') return s.detail;
  if (s.phase === 'ready') return s.detail ? `Postgres store is up, but ${s.detail}. Retrying.` : null;
  if (s.phase === 'starting') {
    return `Starting the Postgres store${s.detail ? ` (${s.detail})` : ''}. History and inbox are unavailable until it is up.`;
  }
  if (s.phase === 'importing') {
    const p = s.progress;
    const what = p
      ? `Copying your ${p.source === 'inbox' ? 'inbox' : 'history'} to Postgres: ${p.table}, ` +
        `${p.copied.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} rows.`
      : 'Copying your inbox and history to Postgres.';
    return `${what} History and inbox are unavailable until it finishes.`;
  }
  return `Postgres store unreachable. History and inbox are unavailable${s.detail ? `: ${s.detail}` : '.'}`;
}

/** Notices for Settings: the last change's outcome, then the store's own (a copy that was skipped). */
export function storeNotices(s: StoreSettings): string[] {
  return [...new Set([s.notice, s.status.notice].filter((n): n is string => !!n))];
}

const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

/** An IPC rejection as the user should read it. */
export function storeErrorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e).replace(IPC_PREFIX, '');
}
