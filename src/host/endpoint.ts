// host:port parsing for the two-pod layout's TCP endpoints.
export interface HostPort {
  host: string;
  port: number;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/** A DNS name or IPv4 address and a port; IPv6 literals are not accepted. */
export function parseHostPort(text: string): HostPort | null {
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = parsePort(m[2]);
  return port === null ? null : { host: m[1], port };
}
