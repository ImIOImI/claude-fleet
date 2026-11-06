// The host bundle's stand-in for better-sqlite3: the host store is Postgres only.
export default function Database(): never {
  throw new Error('SQLite is not available in fleet-host');
}
