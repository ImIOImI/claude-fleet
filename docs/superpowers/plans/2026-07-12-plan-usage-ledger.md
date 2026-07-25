# claude-fleet Token-Spend Ledger + `plan_usage` MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count all of claude-fleet's own token spend (container + local-backend + subagents), capture Anthropic's rate-limit signals as calibration anchors, and expose an app-wide aggregate `plan_usage` MCP tool.

**Architecture:** Bottom-up telemetry (ingest every fleet transcript source into the existing `events` table under real workspace ids) plus top-down anchors (a new `usage_anchors` table populated from 429 / `rateLimits` events). A new `plan_usage` MCP tool returns app-wide totals only, via an injected handler in `ipc.ts` (which alone knows backend kinds), mirroring the `setCommitteeHandlers` pattern.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3`, `chokidar` v5, `vitest`. Design: `docs/superpowers/specs/2026-07-12-plan-usage-ledger-design.md`.

## Global Constraints

- **Schema migrations are additive and versioned:** each `if (user_version < N)` block in `src/main/db.ts` ends with `d.pragma('user_version = N')`. The new table is **v9**.
- **The DB is rebuildable from JSONL** — never assume a table has data that isn't reconstructable by re-ingesting transcripts.
- **Pricing goes through `src/main/pricing.ts` `costFor(model, service_tier, tokens)`** — never hand-roll USD math.
- **MCP privacy contract:** `plan_usage` returns **app-wide aggregates only** — no per-workspace rows, no transcript content. It may read across all workspace ids (like the global-error carve-out) but must never emit a row finer than model/backend.
- **Cost/token aggregation filters `type='assistant'`** (only assistant events carry `usage`), matching `aggregateSessionCost` in `mcpServer.ts`.
- **SPEC discipline:** decision-bearing changes update `docs/SPEC.md` in the same change (final task).
- **Commit after every green test.** End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Pure anchor-detection module (`usageAnchors.ts`)

Pure functions that recognize a rate-limit event in a parsed transcript line and parse the human reset text. No DB, no fs — fully unit-testable.

**Files:**
- Create: `src/main/usageAnchors.ts`
- Test: `src/main/usageAnchors.test.ts`

**Interfaces:**
- Produces:
  - `type AnchorScope = 'session' | 'weekly' | 'opus-weekly'`
  - `interface AnchorInput { kind: 'limit-hit' | 'throttle'; httpStatus: number | null; scope: AnchorScope | null; resetAt: number | null; windowStart: number | null; message: string | null; rateLimits: string | null; dedupKey: string }`
  - `parseResetText(text: string, nowMs: number): { resetAt: number; scope: AnchorScope } | null`
  - `extractAnchor(parsed: Record<string, unknown>, tsMs: number, dedupKey: string): AnchorInput | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/usageAnchors.test.ts
import { describe, it, expect } from 'vitest';
import { parseResetText, extractAnchor } from './usageAnchors.js';

// 2026-07-12T13:54:34Z — the real limit-hit moment.
const NOW = Date.parse('2026-07-12T13:54:34Z');

describe('parseResetText', () => {
  it('parses an absolute UTC pm reset to the next such hour', () => {
    const r = parseResetText("You've hit your session limit · resets 6pm (UTC)", NOW);
    expect(r).toEqual({ resetAt: Date.parse('2026-07-12T18:00:00Z'), scope: 'session' });
  });

  it('rolls to the next day when the hour already passed', () => {
    const r = parseResetText('resets 6am (UTC)', NOW); // 6am already passed at 13:54
    expect(r).toEqual({ resetAt: Date.parse('2026-07-13T06:00:00Z'), scope: 'session' });
  });

  it('classifies weekly and opus-weekly scopes', () => {
    expect(parseResetText('weekly limit resets 6pm (UTC)', NOW)?.scope).toBe('weekly');
    expect(parseResetText('weekly Opus limit resets 6pm (UTC)', NOW)?.scope).toBe('opus-weekly');
  });

  it('returns null when no absolute UTC time is present', () => {
    expect(parseResetText('resets soon', NOW)).toBeNull();
  });
});

describe('extractAnchor', () => {
  it('detects the assistant 429 synthetic and derives the session window', () => {
    const parsed = {
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] },
    };
    const a = extractAnchor(parsed, NOW, 'uuid-1');
    expect(a?.kind).toBe('limit-hit');
    expect(a?.httpStatus).toBe(429);
    expect(a?.scope).toBe('session');
    expect(a?.resetAt).toBe(Date.parse('2026-07-12T18:00:00Z'));
    expect(a?.windowStart).toBe(Date.parse('2026-07-12T13:00:00Z')); // reset - 5h
    expect(a?.message).toContain('session limit');
    expect(a?.dedupKey).toBe('uuid-1');
  });

  it('detects a system/api_error carrying a populated rateLimits object', () => {
    const parsed = {
      type: 'system', subtype: 'api_error',
      error: { status: 429, formatted: '429 rate limited', rateLimits: { unified_remaining: 0 } },
    };
    const a = extractAnchor(parsed, NOW, 'uuid-2');
    expect(a?.kind).toBe('throttle');
    expect(a?.httpStatus).toBe(429);
    expect(a?.rateLimits).toBe(JSON.stringify({ unified_remaining: 0 }));
  });

  it('ignores a system/api_error whose rateLimits is null (e.g. 401 auth error)', () => {
    const parsed = { type: 'system', subtype: 'api_error', error: { status: 401, rateLimits: null } };
    expect(extractAnchor(parsed, NOW, 'k')).toBeNull();
  });

  it('ignores ordinary assistant events', () => {
    const parsed = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { output_tokens: 10 } } };
    expect(extractAnchor(parsed, NOW, 'k')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/usageAnchors.test.ts`
Expected: FAIL — `Cannot find module './usageAnchors.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/usageAnchors.ts
// Pure detection + parsing for Anthropic rate-limit "anchor" events (#plan-usage).
// No DB / fs — db.ts:ingestLine calls extractAnchor and persists the result.

export type AnchorScope = 'session' | 'weekly' | 'opus-weekly';

export interface AnchorInput {
  kind: 'limit-hit' | 'throttle';
  httpStatus: number | null;
  scope: AnchorScope | null;
  resetAt: number | null;
  windowStart: number | null;
  message: string | null;
  rateLimits: string | null;
  dedupKey: string;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Parse a human reset string like "…resets 6pm (UTC)" into the next matching
 *  absolute UTC epoch ms, plus the limit scope. Returns null when no absolute
 *  "(UTC)" clock time is present (we don't guess relative phrasings). */
export function parseResetText(text: string, nowMs: number): { resetAt: number; scope: AnchorScope } | null {
  const scope: AnchorScope = /week/i.test(text)
    ? (/opus/i.test(text) ? 'opus-weekly' : 'weekly')
    : 'session';
  const m = /resets?\s+(\d{1,2})\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[2])) hour += 12;
  const n = new Date(nowMs);
  const reset = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), hour, 0, 0, 0));
  if (reset.getTime() <= nowMs) reset.setUTCDate(reset.getUTCDate() + 1);
  return { resetAt: reset.getTime(), scope };
}

function firstText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message as Record<string, unknown> | null;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === 'string') return t;
      }
    }
  }
  return null;
}

/** Detect a rate-limit anchor in a parsed transcript line. Two shapes:
 *  (a) the assistant 429 synthetic (error:"rate_limit" / apiErrorStatus:429),
 *      whose content text carries the human reset string; and
 *  (b) a system/api_error whose error.rateLimits is a populated object. */
export function extractAnchor(
  parsed: Record<string, unknown>,
  tsMs: number,
  dedupKey: string
): AnchorInput | null {
  if (parsed.error === 'rate_limit' || parsed.apiErrorStatus === 429) {
    const message = firstText(parsed);
    const reset = message ? parseResetText(message, tsMs) : null;
    return {
      kind: 'limit-hit',
      httpStatus: typeof parsed.apiErrorStatus === 'number' ? (parsed.apiErrorStatus as number) : 429,
      scope: reset?.scope ?? null,
      resetAt: reset?.resetAt ?? null,
      windowStart: reset && reset.scope === 'session' ? reset.resetAt - FIVE_HOURS_MS : null,
      message,
      rateLimits: null,
      dedupKey,
    };
  }

  if (parsed.type === 'system' && parsed.subtype === 'api_error') {
    const err = parsed.error as Record<string, unknown> | null;
    const rl = err && typeof err === 'object' ? err.rateLimits : null;
    if (rl && typeof rl === 'object') {
      return {
        kind: 'throttle',
        httpStatus: typeof err?.status === 'number' ? (err.status as number) : null,
        scope: null,
        resetAt: null,
        windowStart: null,
        message: typeof err?.formatted === 'string' ? (err.formatted as string) : null,
        rateLimits: JSON.stringify(rl),
        dedupKey,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/usageAnchors.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/usageAnchors.ts src/main/usageAnchors.test.ts
git commit -m "feat: pure anchor detection + reset-text parsing for rate-limit events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Schema v9 `usage_anchors` table + DB accessors

**Files:**
- Modify: `src/main/db.ts` (migration block after the v8 block ~line 285; new statement in `getStmts`; new exported functions near `costForWorkspace` ~line 1106)
- Test: `src/main/db.usageAnchors.test.ts`

**Interfaces:**
- Consumes: `AnchorInput` (Task 1).
- Produces:
  - `insertUsageAnchor(workspaceId: string, sessionId: string, tsMs: number, a: AnchorInput): void` — `tsMs` is the source event's timestamp.
  - `interface UsageAnchorRow { id: number; ts: number; workspaceId: string | null; sessionId: string | null; kind: string; httpStatus: number | null; scope: string | null; resetAt: number | null; windowStart: number | null; message: string | null }`
  - `latestAnchorCovering(atMs: number): UsageAnchorRow | null` — most recent session-scope anchor with `window_start <= atMs <= reset_at`.
  - `latestLimitHitAnchor(): UsageAnchorRow | null` — most recent `kind='limit-hit'` row with a non-null `window_start`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db.usageAnchors.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, insertUsageAnchor, latestAnchorCovering, latestLimitHitAnchor } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-anchor-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const RESET = Date.parse('2026-07-12T18:00:00Z');
const WSTART = Date.parse('2026-07-12T13:00:00Z');
const HIT = Date.parse('2026-07-12T13:54:34Z');

const limitHit = {
  kind: 'limit-hit' as const, httpStatus: 429, scope: 'session' as const,
  resetAt: RESET, windowStart: WSTART, message: 'session limit', rateLimits: null, dedupKey: 'k1',
};

describe('usage_anchors', () => {
  it('inserts and finds the anchor covering a moment inside its window', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    const cov = latestAnchorCovering(HIT);
    expect(cov?.resetAt).toBe(RESET);
    expect(cov?.windowStart).toBe(WSTART);
    expect(cov?.kind).toBe('limit-hit');
    expect(cov?.ts).toBe(HIT);
  });

  it('returns null when the moment is outside every window', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    expect(latestAnchorCovering(Date.parse('2026-07-12T19:00:00Z'))).toBeNull();
  });

  it('dedups on dedup_key (idempotent re-ingest)', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    expect(latestLimitHitAnchor()?.resetAt).toBe(RESET);
  });

  it('latestLimitHitAnchor ignores throttle rows', () => {
    insertUsageAnchor('ws1', 's', HIT, { kind: 'throttle', httpStatus: 429, scope: null, resetAt: null, windowStart: null, message: null, rateLimits: '{}', dedupKey: 't1' });
    expect(latestLimitHitAnchor()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/db.usageAnchors.test.ts`
Expected: FAIL — `insertUsageAnchor is not a function`.

- [ ] **Step 3a: Add the v9 migration block** (in `migrate`, immediately after the `user_version = 8` block)

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 9) {
    // Account-level rate-limit anchors — the only account-wide-true checkpoints
    // (429 reset messages + populated rateLimits payloads). Rebuildable from JSONL.
    d.exec(`
      CREATE TABLE usage_anchors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT,
        session_id   TEXT,
        kind         TEXT NOT NULL,      -- 'limit-hit' | 'throttle'
        http_status  INTEGER,
        scope        TEXT,               -- 'session' | 'weekly' | 'opus-weekly'
        reset_at     INTEGER,
        window_start INTEGER,
        message      TEXT,
        rate_limits  TEXT,
        dedup_key    TEXT NOT NULL,
        UNIQUE(dedup_key)
      );
      CREATE INDEX idx_usage_anchors_ts ON usage_anchors(ts);
    `);
    d.pragma('user_version = 9');
  }
```

- [ ] **Step 3b: Add the prepared statement** in `getStmts` (mirror `insertSessionChapter`'s registration in the returned object)

```ts
  insertUsageAnchor: d.prepare(`
    INSERT OR IGNORE INTO usage_anchors
      (ts, workspace_id, session_id, kind, http_status, scope, reset_at, window_start, message, rate_limits, dedup_key)
    VALUES
      (@ts, @workspace_id, @session_id, @kind, @http_status, @scope, @reset_at, @window_start, @message, @rate_limits, @dedup_key)
  `),
```

- [ ] **Step 3c: Add the exported functions** (near `costForWorkspace`)

```ts
export interface UsageAnchorRow {
  id: number;
  ts: number;
  workspaceId: string | null;
  sessionId: string | null;
  kind: string;
  httpStatus: number | null;
  scope: string | null;
  resetAt: number | null;
  windowStart: number | null;
  message: string | null;
}

interface UsageAnchorSql {
  id: number; ts: number; workspace_id: string | null; session_id: string | null;
  kind: string; http_status: number | null; scope: string | null;
  reset_at: number | null; window_start: number | null; message: string | null;
}

function toAnchorRow(r: UsageAnchorSql): UsageAnchorRow {
  return {
    id: r.id, ts: r.ts, workspaceId: r.workspace_id, sessionId: r.session_id,
    kind: r.kind, httpStatus: r.http_status, scope: r.scope,
    resetAt: r.reset_at, windowStart: r.window_start, message: r.message,
  };
}

export function insertUsageAnchor(
  workspaceId: string,
  sessionId: string,
  tsMs: number,
  a: import('./usageAnchors.js').AnchorInput
): void {
  const d = openDbOrThrow();
  getStmts(d).insertUsageAnchor.run({
    ts: tsMs,
    workspace_id: workspaceId,
    session_id: sessionId,
    kind: a.kind,
    http_status: a.httpStatus,
    scope: a.scope,
    reset_at: a.resetAt,
    window_start: a.windowStart,
    message: a.message,
    rate_limits: a.rateLimits,
    dedup_key: a.dedupKey,
  });
}

export function latestAnchorCovering(atMs: number): UsageAnchorRow | null {
  const d = openDbOrThrow();
  const r = d.prepare(`
    SELECT id, ts, workspace_id, session_id, kind, http_status, scope, reset_at, window_start, message
    FROM usage_anchors
    WHERE scope = 'session' AND window_start IS NOT NULL AND reset_at IS NOT NULL
      AND window_start <= ? AND ? <= reset_at
    ORDER BY ts DESC LIMIT 1
  `).get(atMs, atMs) as UsageAnchorSql | undefined;
  return r ? toAnchorRow(r) : null;
}

export function latestLimitHitAnchor(): UsageAnchorRow | null {
  const d = openDbOrThrow();
  const r = d.prepare(`
    SELECT id, ts, workspace_id, session_id, kind, http_status, scope, reset_at, window_start, message
    FROM usage_anchors
    WHERE kind = 'limit-hit' AND window_start IS NOT NULL
    ORDER BY ts DESC LIMIT 1
  `).get() as UsageAnchorSql | undefined;
  return r ? toAnchorRow(r) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/db.usageAnchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/db.usageAnchors.test.ts
git commit -m "feat: usage_anchors table (schema v9) + anchor accessors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire anchor extraction into `ingestLine`

**Files:**
- Modify: `src/main/db.ts` (`ingestLine`, after the event insert / before `return`)
- Test: `src/main/db.ingestAnchor.test.ts`

**Interfaces:**
- Consumes: `extractAnchor` (Task 1), `insertUsageAnchor` (Task 2, with the `tsMs` argument).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db.ingestAnchor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, latestLimitHitAnchor } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-ingest-anchor-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const LINE_429 = JSON.stringify({
  type: 'assistant',
  uuid: 'ebc349f7-f938-4798-a930-533183e64d62',
  timestamp: '2026-07-12T13:54:34.503Z',
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] },
});

describe('ingestLine → usage_anchors', () => {
  it('records a limit-hit anchor from a 429 assistant line', () => {
    ingestLine('ws1', 'sess1', LINE_429);
    const a = latestLimitHitAnchor();
    expect(a?.kind).toBe('limit-hit');
    expect(a?.resetAt).toBe(Date.parse('2026-07-12T18:00:00Z'));
    expect(a?.windowStart).toBe(Date.parse('2026-07-12T13:00:00Z'));
    expect(a?.ts).toBe(Date.parse('2026-07-12T13:54:34.503Z'));
  });

  it('does not record an anchor for an ordinary assistant line', () => {
    ingestLine('ws1', 'sess1', JSON.stringify({ type: 'assistant', uuid: 'u2', message: { model: 'claude-opus-4-8', usage: { output_tokens: 5 } } }));
    expect(latestLimitHitAnchor()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/db.ingestAnchor.test.ts`
Expected: FAIL — no anchor recorded (`latestLimitHitAnchor()` returns null).

- [ ] **Step 3: Add the wiring** in `ingestLine`, immediately before `return { inserted: info.changes > 0, sessionId, type };`

```ts
  // Rate-limit anchors (#plan-usage): the account-wide-true checkpoints.
  // Only on a genuinely-new insert so re-reads after compaction don't re-fire.
  if (info.changes > 0) {
    const anchor = extractAnchor(parsed, ts ?? Date.now(), dedupKey);
    if (anchor) insertUsageAnchor(workspaceId, sessionId, ts ?? Date.now(), anchor);
  }
```

Add the import at the top of `db.ts`:

```ts
import { extractAnchor } from './usageAnchors.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/db.ingestAnchor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/db.ingestAnchor.test.ts
git commit -m "feat: record usage_anchors during ingestLine for rate-limit events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Watcher — local-backend workspace host-dir ingestion

Register each local workspace's host `~/.claude/projects/<encoded-root>/` and resolve its files back to the real workspace id.

**Files:**
- Modify: `src/main/paths.ts` (add `encodeClaudeProjectDir` + `hostLocalProjectsDir`)
- Modify: `src/main/jsonlWatcher.ts` (`hostDirs` map, `registerLocalWorkspace`/`unregisterLocalWorkspace`, id-resolution precedence)
- Test: `src/main/paths.test.ts` (new or existing), `src/main/jsonlWatcher.localdir.test.ts`

**Interfaces:**
- Produces:
  - `encodeClaudeProjectDir(absPath: string): string` — matches claude's cwd→dir sanitization.
  - `hostLocalProjectsDir(workspaceRoot: string): string` — `join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(workspaceRoot))`.
  - `JsonlWatcher.registerLocalWorkspace(id: string, workspaceRoot: string): void`
  - `JsonlWatcher.unregisterLocalWorkspace(id: string): void`

- [ ] **Step 1: Write the failing test (encoding)**

```ts
// src/main/paths.test.ts  (add these cases; create the file if absent)
import { describe, it, expect } from 'vitest';
import { encodeClaudeProjectDir } from './paths.js';

describe('encodeClaudeProjectDir', () => {
  // Anchor: the container cwd '/workspace' is known to encode as '-workspace'.
  it('encodes an absolute path by replacing non-alphanumerics with dashes', () => {
    expect(encodeClaudeProjectDir('/workspace')).toBe('-workspace');
    expect(encodeClaudeProjectDir('/home/amber/my-proj')).toBe('-home-amber-my-proj');
    expect(encodeClaudeProjectDir('/home/amber/my.proj')).toBe('-home-amber-my-proj');
  });
});
```

> **VERIFY BEFORE RELYING ON THIS:** the exact sanitization is claude's, not ours. On a machine with a real local workspace, run `ls ~/.claude/projects` and confirm the encoding of a known `workspaceRoot`. If claude preserves any character this regex replaces (e.g. `_`), widen the allow-list in the implementation and this test. The `/workspace` → `-workspace` anchor is confirmed from container transcripts.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/paths.test.ts`
Expected: FAIL — `encodeClaudeProjectDir is not a function`.

- [ ] **Step 3: Implement encoding in `paths.ts`**

```ts
import { homedir } from 'node:os';

/** Reproduce claude's cwd→project-dir sanitization: every character that is
 *  not [A-Za-z0-9] becomes '-'. So '/workspace' → '-workspace'. Load-bearing:
 *  a local workspace's transcripts live in ~/.claude/projects/<this>/ . */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Absolute host transcript dir for a local-backend workspace rooted at
 *  `workspaceRoot`. Local claude uses the real ~/.claude (SPEC §Local backend). */
export function hostLocalProjectsDir(workspaceRoot: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(workspaceRoot));
}
```

- [ ] **Step 4: Run encoding test to verify it passes**

Run: `npx vitest run src/main/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing watcher test**

```ts
// src/main/jsonlWatcher.localdir.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher } from './jsonlWatcher.js';
import { openDb, closeDb, costForWorkspace } from './db.js';

let dir: string;
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-localdir-')); openDb(dir); });
afterEach(async () => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const line = JSON.stringify({
  type: 'assistant', uuid: 'e1', timestamp: '2026-07-12T13:10:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 1000, input_tokens: 10 } },
});

describe('local-workspace host-dir ingestion', () => {
  it('attributes a file under a registered host dir to the real workspace id', async () => {
    // A fake "host projects" dir standing in for ~/.claude/projects/<encoded>/
    const hostProjectDir = join(dir, 'projects', '-fake-root');
    mkdirSync(hostProjectDir, { recursive: true });

    const w = new JsonlWatcher();
    await w.start([]);
    // Register by explicit dir (test seam): see implementation note.
    w.registerLocalDirForTest('ws-local', hostProjectDir);

    writeFileSync(join(hostProjectDir, `${UUID}.jsonl`), line + '\n');
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();

    expect(costForWorkspace('ws-local').outputTokens).toBe(1000);
  });
});
```

> **Implementation seam:** `registerLocalWorkspace(id, workspaceRoot)` computes `hostLocalProjectsDir(workspaceRoot)` then delegates to a private `addHostDir(id, dir)`. Expose a thin `registerLocalDirForTest(id, dir)` that calls `addHostDir` directly, so the test doesn't depend on the real `homedir()`. Keep it a one-line test-only wrapper.

- [ ] **Step 6: Run watcher test to verify it fails**

Run: `npx vitest run src/main/jsonlWatcher.localdir.test.ts`
Expected: FAIL — `registerLocalDirForTest is not a function`.

- [ ] **Step 7: Implement in `jsonlWatcher.ts`**

Add a field and methods to the `JsonlWatcher` class:

```ts
  // Registered host transcript dirs for local-backend workspaces:
  //   ~/.claude/projects/<encoded-root>/  →  real workspace id.
  // Consulted before the '.claude'-parent path rule (which is wrong for
  // host paths). Watched at the specific subdir only, so unrelated personal
  // projects in the same ~/.claude/projects tree are never ingested.
  private readonly hostDirs = new Map<string, string>(); // dir → workspaceId

  registerLocalWorkspace(id: string, workspaceRoot: string): void {
    this.addHostDir(id, hostLocalProjectsDir(workspaceRoot));
  }

  /** @internal test seam — register a host dir directly. */
  registerLocalDirForTest(id: string, dir: string): void {
    this.addHostDir(id, dir);
  }

  private addHostDir(id: string, dir: string): void {
    if (!this.watcher) return;
    if (this.hostDirs.has(dir)) return;
    this.hostDirs.set(dir, id);
    this.watchedDirs.add(dir);
    try { mkdirSync(dir, { recursive: true }); } catch { /* see registerWorkspace */ }
    this.watcher.add(dir);
  }

  unregisterLocalWorkspace(id: string): void {
    if (!this.watcher) return;
    for (const [dir, wsId] of [...this.hostDirs]) {
      if (wsId !== id) continue;
      this.hostDirs.delete(dir);
      this.watchedDirs.delete(dir);
      this.watcher.unwatch(dir);
      const prefix = dir + pathSep;
      for (const path of [...this.files.keys()]) {
        if (path === dir || path.startsWith(prefix)) { this.files.delete(path); this.chains.delete(path); }
      }
    }
  }
```

Add `hostLocalProjectsDir` to the paths import. Then replace `initState`'s id derivation so host dirs win:

```ts
  private initState(path: string): FileState | null {
    const workspaceId = this.workspaceIdForPath(path);
    const parsed = parseTranscriptFilename(path);
    if (!workspaceId || !parsed) return null;
    const state: FileState = { workspaceId, sessionId: parsed.sessionId, sidecar: parsed.sidecar, offset: 0 };
    this.files.set(path, state);
    return state;
  }

  /** Host-dir map first (local workspaces), then the '.claude'-parent rule. */
  private workspaceIdForPath(path: string): string | null {
    for (const [dir, wsId] of this.hostDirs) {
      if (path === dir || path.startsWith(dir + pathSep)) return wsId;
    }
    return workspaceIdFromPath(path);
  }
```

- [ ] **Step 8: Run watcher test to verify it passes**

Run: `npx vitest run src/main/jsonlWatcher.localdir.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/paths.ts src/main/paths.test.ts src/main/jsonlWatcher.ts src/main/jsonlWatcher.localdir.test.ts
git commit -m "feat: ingest local-backend workspace transcripts from host ~/.claude

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Watcher — subagent transcript ingestion

Ingest `<projectdir>/<parent-session-uuid>/subagents/agent-*.jsonl`, attributing events to the parent session + workspace. Requires reaching one level deeper than the current `depth:0`.

**Files:**
- Modify: `src/main/jsonlWatcher.ts` (raise depth for registered dirs; add `parseSubagentPath`; route subagent files)
- Test: `src/main/jsonlWatcher.subagent.test.ts`

**Interfaces:**
- Produces: `parseSubagentPath(path: string): { parentSessionId: string } | null` (exported for unit test).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/jsonlWatcher.subagent.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher, parseSubagentPath } from './jsonlWatcher.js';
import { openDb, closeDb, costForSession } from './db.js';

const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-subagent-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const subLine = JSON.stringify({
  type: 'assistant', uuid: 'sa1', timestamp: '2026-07-12T13:20:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 500 } },
});

describe('parseSubagentPath', () => {
  it('extracts the parent session id from a subagent file path', () => {
    const p = `/x/projects/-workspace/${PARENT}/subagents/agent-123.jsonl`;
    expect(parseSubagentPath(p)).toEqual({ parentSessionId: PARENT });
  });
  it('returns null for a primary transcript path', () => {
    expect(parseSubagentPath(`/x/projects/-workspace/${PARENT}.jsonl`)).toBeNull();
  });
});

describe('subagent ingestion', () => {
  it('rolls subagent tokens up into the parent session', async () => {
    const projectDir = join(dir, 'projects', '-workspace');
    const subDir = join(projectDir, PARENT, 'subagents');
    mkdirSync(subDir, { recursive: true });

    const w = new JsonlWatcher();
    await w.start([]);
    w.registerLocalDirForTest('ws1', projectDir); // reuse Task 4 seam for a watched dir

    writeFileSync(join(subDir, 'agent-123.jsonl'), subLine + '\n');
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();

    expect(costForSession(PARENT).outputTokens).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/jsonlWatcher.subagent.test.ts`
Expected: FAIL — `parseSubagentPath` undefined and/or subagent tokens not ingested (depth:0 hides them).

- [ ] **Step 3a: Raise chokidar depth** in `start()` — change `depth: 0` to `depth: 2`

```ts
    this.watcher = chokidar.watch([], {
      depth: 2, // reach <projectdir>/<session>/subagents/agent-*.jsonl (#plan-usage)
      ignoreInitial: false,
      persistent: true,
    });
```

- [ ] **Step 3b: Add `parseSubagentPath`** (exported, near `parseTranscriptFilename`)

```ts
const AGENT_FILE_RE = /^agent-.*\.jsonl$/i;

/** Parent session id from a subagent transcript path
 *  `.../<parent-session-uuid>/subagents/agent-*.jsonl`, or null. */
export function parseSubagentPath(path: string): { parentSessionId: string } | null {
  const segs = path.split(/[\\/]/);
  const file = segs[segs.length - 1] ?? '';
  if (!AGENT_FILE_RE.test(file)) return null;
  if (segs[segs.length - 2] !== 'subagents') return null;
  const parent = segs[segs.length - 3] ?? '';
  return UUID_RE.test(parent) ? { parentSessionId: parent } : null;
}
```

- [ ] **Step 3c: Route subagent files** — in `initState`, before the primary-transcript parse, detect a subagent path and build state under the parent session:

```ts
  private initState(path: string): FileState | null {
    const workspaceId = this.workspaceIdForPath(path);
    if (!workspaceId) return null;

    const sub = parseSubagentPath(path);
    if (sub) {
      // Subagent transcript — attribute to the parent session; never a
      // 'new-session' (the parent already exists) and never mirrored.
      const state: FileState = { workspaceId, sessionId: sub.parentSessionId, sidecar: true, offset: 0 };
      this.files.set(path, state);
      return state;
    }

    const parsed = parseTranscriptFilename(path);
    if (!parsed) return null;
    const state: FileState = { workspaceId, sessionId: parsed.sessionId, sidecar: parsed.sidecar, offset: 0 };
    this.files.set(path, state);
    return state;
  }
```

> **Why `sidecar: true` for subagents:** the `sidecar` flag already means "ingest events but don't fire 'new-session' and don't mirror" (see `process()` and `readAndIngest`). Subagents want exactly that behavior, so reuse it rather than adding a parallel flag.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/jsonlWatcher.subagent.test.ts`
Expected: PASS (both `parseSubagentPath` cases and the roll-up).

- [ ] **Step 5: Run the full watcher suite to guard against depth regressions**

Run: `npx vitest run src/main/jsonlWatcher.test.ts src/main/jsonlWatcherMirror.test.ts`
Expected: PASS (existing behavior unchanged at the deeper watch depth).

- [ ] **Step 6: Commit**

```bash
git add src/main/jsonlWatcher.ts src/main/jsonlWatcher.subagent.test.ts
git commit -m "feat: ingest subagent transcripts, rolling tokens up to the parent session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: DB — windowed app-wide usage rows

**Files:**
- Modify: `src/main/db.ts` (new function near `costForWorkspace`)
- Test: `src/main/db.planUsage.test.ts`

**Interfaces:**
- Produces:
  - `interface PlanUsageRow { workspaceId: string; model: string | null; serviceTier: string | null; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }`
  - `planUsageRows(fromMs: number, toMs: number): PlanUsageRow[]` — assistant events across **all** workspaces in `[fromMs, toMs)`, grouped by `(workspace_id, model, service_tier)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/db.planUsage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, planUsageRows } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-planrows-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

function assistant(uuid: string, tsIso: string, out: number, model = 'claude-opus-4-8') {
  return JSON.stringify({ type: 'assistant', uuid, timestamp: tsIso, message: { model, usage: { output_tokens: out } } });
}

describe('planUsageRows', () => {
  it('sums assistant tokens across workspaces within the window only', () => {
    ingestLine('wsA', 's1', assistant('a', '2026-07-12T13:10:00Z', 100));
    ingestLine('wsB', 's2', assistant('b', '2026-07-12T13:20:00Z', 200, 'claude-haiku-4-5'));
    ingestLine('wsA', 's1', assistant('c', '2026-07-12T09:00:00Z', 999)); // before window
    const rows = planUsageRows(Date.parse('2026-07-12T13:00:00Z'), Date.parse('2026-07-12T18:00:00Z'));
    const total = rows.reduce((n, r) => n + r.outputTokens, 0);
    expect(total).toBe(300);
    expect(rows.some((r) => r.workspaceId === 'wsA')).toBe(true);
    expect(rows.some((r) => r.workspaceId === 'wsB')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/db.planUsage.test.ts`
Expected: FAIL — `planUsageRows is not a function`.

- [ ] **Step 3: Implement**

```ts
export interface PlanUsageRow {
  workspaceId: string;
  model: string | null;
  serviceTier: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function planUsageRows(fromMs: number, toMs: number): PlanUsageRow[] {
  const d = openDbOrThrow();
  const rows = d.prepare(`
    SELECT workspace_id, model, service_tier, ${COST_COLUMNS}
    FROM events
    WHERE type = 'assistant' AND ts IS NOT NULL AND ts >= ? AND ts < ?
    GROUP BY workspace_id, model, service_tier
  `).all(fromMs, toMs) as Array<CostGroupRow & { workspace_id: string }>;
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    model: r.model,
    serviceTier: r.service_tier,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/db.planUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/db.planUsage.test.ts
git commit -m "feat: planUsageRows — windowed app-wide assistant-token aggregate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Pure plan-usage folding + `computePlanUsage`

The fold (rows + backend map → aggregate) is pure and unit-tested; a thin `computePlanUsage` in `ipc.ts` supplies the DB/manifest I/O.

**Files:**
- Create: `src/main/planUsage.ts` (pure fold)
- Create: `src/main/planUsage.test.ts`
- Modify: `src/main/ipc.ts` (`computePlanUsage`, IPC channel, handler injection)

**Interfaces:**
- Consumes: `PlanUsageRow` (Task 6), `UsageAnchorRow` (Task 2), `costFor` (`pricing.ts`).
- Produces:
  - `interface PlanUsage { window: { startMs: number; endMs: number; source: 'anchor' | 'rolling' }; spend: { usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }; byModel: Array<{ model: string; usd: number }>; byBackend: Array<{ backend: 'container' | 'local'; usd: number }>; latestAnchor: { kind: string; scope: string | null; resetAtIso: string | null; message: string | null } | null; estimate: { capUsd: number | null; usedPct: number | null; basis: 'seed' | 'calibrated' } }`
  - `foldPlanUsage(rows: PlanUsageRow[], localIds: Set<string>): { spend; byModel; byBackend }`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/planUsage.test.ts
import { describe, it, expect } from 'vitest';
import { foldPlanUsage } from './planUsage.js';
import type { PlanUsageRow } from './db.js';

const row = (ws: string, model: string, out: number): PlanUsageRow => ({
  workspaceId: ws, model, serviceTier: 'standard',
  inputTokens: 0, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
});

describe('foldPlanUsage', () => {
  it('sums usd by model and by backend without leaking per-workspace rows', () => {
    const rows = [row('wsC', 'claude-opus-4-8', 1_000_000), row('wsL', 'claude-opus-4-8', 1_000_000)];
    const out = foldPlanUsage(rows, new Set(['wsL']));
    // opus output = $75/Mtok → each row $75.
    expect(out.spend.usd).toBeCloseTo(150, 5);
    expect(out.byModel).toEqual([{ model: 'claude-opus-4-8', usd: 150 }]);
    expect(out.byBackend).toContainEqual({ backend: 'container', usd: 75 });
    expect(out.byBackend).toContainEqual({ backend: 'local', usd: 75 });
    // no per-workspace field anywhere:
    expect(JSON.stringify(out)).not.toContain('wsC');
    expect(JSON.stringify(out)).not.toContain('wsL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/planUsage.test.ts`
Expected: FAIL — `Cannot find module './planUsage.js'`.

- [ ] **Step 3: Implement the pure fold**

```ts
// src/main/planUsage.ts
// Pure fold: windowed usage rows + the set of local-backend workspace ids →
// app-wide aggregates (totals, byModel, byBackend). No DB / manifests / IPC.
// The privacy contract lives here: the output has no per-workspace field.
import { costFor } from './pricing.js';
import type { PlanUsageRow } from './db.js';

export interface PlanUsageSpend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface PlanUsageFold {
  spend: PlanUsageSpend;
  byModel: Array<{ model: string; usd: number }>;
  byBackend: Array<{ backend: 'container' | 'local'; usd: number }>;
}

export function foldPlanUsage(rows: PlanUsageRow[], localIds: Set<string>): PlanUsageFold {
  const spend: PlanUsageSpend = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  const byModel = new Map<string, number>();
  const byBackend = new Map<'container' | 'local', number>([['container', 0], ['local', 0]]);

  for (const r of rows) {
    const usd = costFor(r.model, r.serviceTier, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadInputTokens: r.cacheReadInputTokens,
      cacheCreationInputTokens: r.cacheCreationInputTokens,
    });
    spend.usd += usd;
    spend.inputTokens += r.inputTokens;
    spend.outputTokens += r.outputTokens;
    spend.cacheReadTokens += r.cacheReadInputTokens;
    spend.cacheCreateTokens += r.cacheCreationInputTokens;

    const modelKey = r.model ?? '(unknown)';
    byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + usd);
    const backend = localIds.has(r.workspaceId) ? 'local' : 'container';
    byBackend.set(backend, (byBackend.get(backend) ?? 0) + usd);
  }

  return {
    spend,
    byModel: [...byModel].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    byBackend: [...byBackend].map(([backend, usd]) => ({ backend, usd })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/planUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `computePlanUsage` + IPC + handler injection in `ipc.ts`**

Add imports:

```ts
import { planUsageRows, latestAnchorCovering, latestLimitHitAnchor } from './db.js';
import { foldPlanUsage, type PlanUsageFold } from './planUsage.js';
import { setPlanUsageHandler } from './mcpServer.js';
```

Add the function (near the other `observability:*` handlers):

```ts
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export interface PlanUsage extends PlanUsageFold {
  window: { startMs: number; endMs: number; source: 'anchor' | 'rolling' };
  latestAnchor: { kind: string; scope: string | null; resetAtIso: string | null; message: string | null } | null;
  estimate: { capUsd: number | null; usedPct: number | null; basis: 'seed' | 'calibrated' };
}

/** App-wide plan usage for the window covering `at` (default: now). Reads every
 *  workspace; returns aggregates only. `localIds` distinguishes backends. */
async function computePlanUsage(opts?: { windowS?: number; at?: number }): Promise<PlanUsage> {
  const at = opts?.at ?? Date.now();
  const windowMs = (opts?.windowS ?? 5 * 60 * 60) * 1000;

  const covering = latestAnchorCovering(at);
  const window = covering && covering.windowStart != null && covering.resetAt != null
    ? { startMs: covering.windowStart, endMs: covering.resetAt, source: 'anchor' as const }
    : { startMs: at - windowMs, endMs: at, source: 'rolling' as const };

  const all = await listAllWorkspaces();
  const localIds = new Set(all.filter((w) => w.kind === 'local').map((w) => w.id));

  const fold = foldPlanUsage(planUsageRows(window.startMs, window.endMs), localIds);

  // Cap seed: the window cost recomputed at the most recent limit-hit anchor
  // (now including local + subagent spend). null until a limit-hit exists.
  const hit = latestLimitHitAnchor();
  let capUsd: number | null = null;
  if (hit && hit.windowStart != null && hit.resetAt != null) {
    capUsd = foldPlanUsage(planUsageRows(hit.windowStart, hit.resetAt), localIds).spend.usd;
  }

  return {
    ...fold,
    window,
    latestAnchor: hit
      ? { kind: hit.kind, scope: hit.scope, resetAtIso: hit.resetAt ? new Date(hit.resetAt).toISOString() : null, message: hit.message }
      : null,
    estimate: {
      capUsd,
      usedPct: capUsd && capUsd > 0 ? fold.spend.usd / capUsd : null,
      basis: 'seed',
    },
  };
}
```

Register the IPC channel and inject the MCP handler (near the other `ipcMain.handle('observability:*')` calls and the `setCommitteeHandlers({...})` block):

```ts
  ipcMain.handle('observability:planUsage', (_e, opts?: { windowS?: number; at?: number }) => computePlanUsage(opts));
  setPlanUsageHandler((opts) => computePlanUsage(opts));
```

- [ ] **Step 6: Run the pure suite again + typecheck**

Run: `npx vitest run src/main/planUsage.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS + no type errors. (If `setPlanUsageHandler` is undefined, it lands in Task 8 — temporarily comment the `setPlanUsageHandler` line, finish Task 8, then re-enable. Prefer doing Task 8 before this typecheck.)

- [ ] **Step 7: Commit**

```bash
git add src/main/planUsage.ts src/main/planUsage.test.ts src/main/ipc.ts
git commit -m "feat: computePlanUsage + observability:planUsage IPC (aggregate-only fold)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: MCP `plan_usage` tool + handler injection setter

**Files:**
- Modify: `src/main/mcpServer.ts` (`setPlanUsageHandler`, the `plan_usage` Tool entry in `TOOLS`)
- Test: `src/main/mcpServer.planUsage.test.ts`

**Interfaces:**
- Consumes: `PlanUsage` shape (Task 7).
- Produces:
  - `type PlanUsageHandler = (opts?: { windowS?: number; at?: number }) => Promise<unknown>`
  - `setPlanUsageHandler(fn: PlanUsageHandler): void`
  - Tool `plan_usage({ window_s?, at? })` — callable by any workspace, ignores `allowedWorkspaces`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/mcpServer.planUsage.test.ts
import { describe, it, expect } from 'vitest';
import { setPlanUsageHandler, __getToolForTest } from './mcpServer.js';

describe('plan_usage tool', () => {
  it('delegates to the injected handler and needs no grant', async () => {
    setPlanUsageHandler(async (opts) => ({ echoedAt: opts?.at ?? 0, spend: { usd: 42 } }));
    const tool = __getToolForTest('plan_usage');
    expect(tool).toBeTruthy();
    // Empty allowedWorkspaces proves it is not gated on read scope.
    const res = await tool!.run({} as never, { at: 123 }, { callerId: 'anyone', allowedWorkspaces: new Set() });
    expect(res).toEqual({ echoedAt: 123, spend: { usd: 42 } });
  });
});
```

> If `mcpServer.ts` has no test accessor for a single tool, add a tiny one:
> `export function __getToolForTest(name: string): Tool | undefined { return TOOLS.find((t) => t.name === name); }`
> (Mirrors the file's existing test-only exports; keep it at the bottom.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/mcpServer.planUsage.test.ts`
Expected: FAIL — `setPlanUsageHandler is not a function`.

- [ ] **Step 3: Implement in `mcpServer.ts`**

Add the injection setter (beside `setCommitteeHandlers`, ~line 107):

```ts
export type PlanUsageHandler = (opts?: { windowS?: number; at?: number }) => Promise<unknown>;
let planUsageHandler: PlanUsageHandler | null = null;
export function setPlanUsageHandler(fn: PlanUsageHandler): void {
  planUsageHandler = fn;
}
```

Add the tool to the `TOOLS` array (after `list_errors`):

```ts
  {
    name: 'plan_usage',
    description:
      'App-wide claude-fleet token spend for the current 5-hour usage window: ' +
      'USD + token totals, byModel/byBackend splits, the latest account limit anchor, ' +
      'and a provisional plan-usage %. Aggregates ONLY — no per-workspace or transcript ' +
      'detail (use get_cost for your own session). No grant required. usedPct measures ' +
      "claude-fleet's own consumption, not the whole Anthropic account.",
    inputSchema: {
      type: 'object',
      properties: {
        window_s: { type: 'number', description: 'trailing window seconds when no anchor covers `at` (default 18000)' },
        at: { type: 'number', description: 'epoch ms to evaluate (default now)' },
      },
    },
    run: async (_db, a) => {
      if (!planUsageHandler) throw new Error('plan_usage is unavailable (no handler wired)');
      const windowS = typeof a.window_s === 'number' ? a.window_s : undefined;
      const at = typeof a.at === 'number' ? a.at : undefined;
      return planUsageHandler({ windowS, at });
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/mcpServer.planUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Guard the isolation suite** (the tool must appear but not widen scoped reads)

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.planUsage.test.ts
git commit -m "feat: plan_usage MCP tool (aggregate-only, no-grant carve-out)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Startup wiring + SPEC update

Register local workspaces with the watcher at startup and on create/remove, and record the decisions in `docs/SPEC.md`.

**Files:**
- Modify: `src/main/index.ts` (after `jsonlWatcher.start(...)`)
- Modify: `src/main/ipc.ts` (`workspace:create` / `workspace:remove` handlers — near existing `jsonlWatcher?.registerWorkspace(input.id)` at ~line 714)
- Modify: `docs/SPEC.md`

**Interfaces:**
- Consumes: `JsonlWatcher.registerLocalWorkspace` / `unregisterLocalWorkspace` (Task 4).

- [ ] **Step 1: Register local workspaces at startup** — in `index.ts`, after `await jsonlWatcher.start(manifests.map((m) => m.id));`

```ts
    // Local-backend workspaces write to the host's real ~/.claude, not the
    // per-workspace state dir — register those host project dirs so their
    // (and their subagents') token spend is ingested (#plan-usage).
    for (const m of manifests) {
      if (m.kind === 'local' && m.workspaceRoot) {
        jsonlWatcher.registerLocalWorkspace(m.id, m.workspaceRoot);
      }
    }
```

> Confirm `listWorkspaceManifests()` entries expose `kind` and `workspaceRoot`. If a manifest field name differs, use the manifest's actual root property (the same one `local.ts` reads as the working dir).

- [ ] **Step 2: Register/unregister on create + remove** — in `ipc.ts`, beside the existing container registration:

```ts
      // (workspace:create) after jsonlWatcher?.registerWorkspace(input.id):
      if (spec.kind === 'local' && spec.workspaceRoot) {
        jsonlWatcher?.registerLocalWorkspace(input.id, spec.workspaceRoot);
      }
```

```ts
      // (workspace:remove) beside the container unregister:
      jsonlWatcher?.unregisterLocalWorkspace(id);
```

> Match the exact variable names in each handler (`input.id` / `spec` / `id`) to what the surrounding code already uses; the create handler already calls `jsonlWatcher?.registerWorkspace(...)`, so mirror its scope.

- [ ] **Step 3: Manual smoke check (no automated test — wiring only)**

Run: `npx vitest run src/main` (full main suite) then `npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 4: Update `docs/SPEC.md`** — make these edits in place:

1. **§ JSONL→SQLite cache, schema block:** bump the heading to **v9** and add the `usage_anchors` table definition (copy the `CREATE TABLE` from Task 2) with a one-line rationale: "account-level rate-limit anchors — the only account-wide-true checkpoints; rebuilt from JSONL like every other table."
2. **§ JSONL→SQLite cache, "Subagent JSONLs … deliberately not ingested" bullet (line ~582):** replace it — subagent transcripts (`<session>/subagents/agent-*.jsonl`) **are** now ingested at `depth:2`, attributed to the parent session (reusing the `sidecar` no-new-session/no-mirror path).
3. **§ Local (non-container) backend:** add a bullet — a local workspace's transcripts live in the host's `~/.claude/projects/<encodeClaudeProjectDir(workspaceRoot)>/`; the watcher registers that specific dir (mapped to the real workspace id via `JsonlWatcher.hostDirs`), so local spend is ingested while unrelated personal projects in the same tree are not.
4. **§ In-container SQLite access via MCP, Tool surface:** add `plan_usage({ window_s?, at? })` → app-wide aggregate (USD + tokens, byModel/byBackend, latest anchor, provisional `usedPct`); **no grant, aggregates only** — the same non-private carve-out as global-error rows; never emits per-workspace or transcript detail. Injected via `setPlanUsageHandler` from `ipc.ts` (which alone knows backend kinds).
5. **§9 Security model:** one line — `plan_usage` reads across all workspace ids but is structurally aggregate-only (`foldPlanUsage` has no per-workspace field); totals cross the boundary, content and per-workspace detail never do.
6. **§11 Open decisions / Observability:** note the deferred pieces — cross-device/account sync is a permanent non-goal; observability-rail UI consumes `observability:planUsage` later; `estimate.capUsd` calibration (fitting from multiple anchors) is a follow-up (`basis:'seed'` today).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/ipc.ts docs/SPEC.md
git commit -m "feat: wire local-workspace ingestion at startup + SPEC for plan-usage ledger

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the whole main-process suite: `npx vitest run src/main`
- [ ] Typecheck: `npx tsc -p tsconfig.node.json --noEmit`
- [ ] Confirm schema is v9: open a scratch DB and check `PRAGMA user_version` = 9.
- [ ] Open a PR against `ImIOImI/claude-fleet` (per repo norm).

## Self-review notes (coverage against the spec)

- Piece 1a (local-backend ingestion) → Tasks 4, 9. 1b (subagents) → Task 5.
- Piece 2 (anchors) → Tasks 1–3.
- Piece 3 (`plan_usage`) → Tasks 6, 7, 8; privacy (aggregates only, no per-workspace) enforced in `foldPlanUsage` (Task 7) and asserted in Tasks 7 & 8.
- IPC `observability:planUsage` → Task 7. SPEC updates → Task 9.
- Out of scope confirmed absent: no cross-device sync, no rail UI, no `__host__` sentinel.
