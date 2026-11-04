// Knowledge capture (#483): session ids of capture forks, so the Sessions rail
// can file them under their own collapsed group and the scheduler never
// captures a capture.
const forks = new Set<string>();
export function markCaptureFork(id: string): void { forks.add(id); }
export function isCaptureFork(id: string): boolean { return forks.has(id); }
export function loadCaptureForks(ids: Iterable<string>): void { for (const id of ids) forks.add(id); }
