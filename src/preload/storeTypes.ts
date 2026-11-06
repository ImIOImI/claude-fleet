// The store choice and status (Settings → Storage, the store banner). Shared
// by main (type-only) and the renderer.

export type StoreChoice = 'sqlite' | 'managed' | 'external';
export type StorePhase = 'ready' | 'starting' | 'importing' | 'down';

export interface ImportProgress {
  source: 'inbox' | 'state';
  table: string;
  copied: number;
  total: number;
}

export interface StoreStatus {
  choice: StoreChoice;
  phase: StorePhase;
  /** Why the store is down (secret-free), or null. */
  detail: string | null;
  progress: ImportProgress | null;
  /** A one-off note from the first-switch copy (e.g. inbox.db not copied), or null. */
  notice: string | null;
}

export interface StoreSettings {
  /** What config.json names now. */
  configured: StoreChoice;
  /** What this run opened; differs from `configured` until a restart. */
  active: StoreChoice;
  restartRequired: boolean;
  status: StoreStatus;
}
