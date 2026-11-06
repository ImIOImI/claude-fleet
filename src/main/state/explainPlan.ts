// Test support: the SQLite query plan of a Kysely query, as one string.
// Pins the SQL the store actually compiles, not a hand-copied string.
import type Database from 'better-sqlite3';
import type { Compilable } from 'kysely';

export function explainPlan(raw: Database.Database, query: Compilable): string {
  const { sql, parameters } = query.compile();
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as unknown[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}
