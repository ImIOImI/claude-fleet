// Guard for the MCP `query` escape hatch. The read-only DB connection is the
// hard guarantee — better-sqlite3 opened `{ readonly: true }` rejects any write
// at the engine level. This check is defense-in-depth: it rejects writes (and
// multi-statement injection) earlier, with a clearer message than a raw SQLite
// error, before the statement ever reaches the connection.

export interface SqlCheck {
  ok: boolean;
  reason?: string;
}

// Read-only statement kinds. PRAGMA is allowed only in its query form (no `=`),
// since `PRAGMA user_version = 5` is a write.
const ALLOWED_LEADING = /^(SELECT|WITH|EXPLAIN|VALUES|PRAGMA)\b/i;

/** Strip -- line and / * * / block comments so a comment can't mask the keyword. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

export function isReadOnlySql(sql: string): SqlCheck {
  if (typeof sql !== 'string') return { ok: false, reason: 'sql must be a string.' };
  const stripped = stripComments(sql).trim();
  if (!stripped) return { ok: false, reason: 'Empty query.' };

  // Allow at most one statement (a single optional trailing semicolon). This
  // blocks `SELECT 1; DROP TABLE events` style injection through the escape hatch.
  const body = stripped.replace(/;\s*$/, '');
  if (body.includes(';')) {
    return { ok: false, reason: 'Only a single statement is allowed.' };
  }

  if (!ALLOWED_LEADING.test(body)) {
    return {
      ok: false,
      reason: 'Only read-only statements are allowed (SELECT / WITH / EXPLAIN / VALUES / PRAGMA).'
    };
  }

  if (/^PRAGMA\b/i.test(body) && body.includes('=')) {
    return { ok: false, reason: 'Assignment PRAGMAs (writes) are not allowed.' };
  }

  return { ok: true };
}
