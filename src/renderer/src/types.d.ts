import type { FleetApi } from '../../preload';

declare global {
  interface Window {
    api: FleetApi;
  }
}
export {};
