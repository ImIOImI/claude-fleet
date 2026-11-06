// The store this run opened. config.json's choice applies at restart, so it
// can name another store than the one whose credentials are live.
import type { StoreConfig } from './storeConfig.js';

let active: StoreConfig | null = null;

export function setActiveStoreConfig(cfg: StoreConfig | null): void {
  active = cfg;
}

export function activeStoreConfig(): StoreConfig | null {
  return active;
}
