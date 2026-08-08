/** Relative uptime for a Serving row, coarsest single unit ("up 12m"). */
export function formatUptime(firstSeenAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - firstSeenAt) / 1000));
  if (s < 60) return `up ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `up ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `up ${h}h`;
  return `up ${Math.floor(h / 24)}d`;
}
