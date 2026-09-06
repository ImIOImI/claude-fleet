// Warm = shown as a strip chip; cold = lives in the Saved modal (#21: a
// workspace appears in exactly one place). Daemon-down (#380) extends warm
// to unreachable workspaces whose last-known state was warm, so chips don't
// vanish on a daemon flap. No App import — structural param avoids a cycle.
interface TemperatureInput {
  state: 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';
  lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted';
}

export function isWarm(w: TemperatureInput | undefined): boolean {
  if (!w) return false;
  if (w.state === 'running' || w.state === 'paused') return true;
  return w.state === 'unreachable' && (w.lastKnownState === 'running' || w.lastKnownState === 'paused');
}

export function isCold(w: TemperatureInput | undefined): boolean {
  if (!w) return false;
  return w.state === 'stopped' || w.state === 'deleted' || (w.state === 'unreachable' && !isWarm(w));
}
