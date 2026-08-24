# Task 8 Report — qwen-record → claude-dialect JSONL mapper

## Status

COMPLETE. Commit `056f696` on branch `feat/qwen-code-harness-spec`.

---

## Files created

- `src/main/qwenAdapter.ts` — pure `mapQwenRecord(raw: unknown): string | null`
- `src/main/qwenAdapter.test.ts` — 5 tests (TDD: red → green)

---

## Field-name verification against real qwen-code source

Fetched from GitHub before finalizing (2026-08-24):
- `https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/services/chatRecordingService.ts`
- `https://raw.githubusercontent.com/googleapis/js-genai/main/src/types.ts` (for Content/Part)
- `https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/core/turn.ts` (for ToolCallResponseInfo)
- `https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/core/coreToolScheduler.ts` (for Status)

### Confirmed (brief was correct)

| Field | Location | Real type | Status |
|---|---|---|---|
| `usageMetadata.promptTokenCount` | ChatRecord | number | ✓ Confirmed |
| `usageMetadata.candidatesTokenCount` | ChatRecord | number | ✓ Confirmed |
| `usageMetadata.cachedContentTokenCount` | ChatRecord | number | ✓ Confirmed |
| `functionCall.name` | Part | string | ✓ Confirmed |
| `functionCall.args` | Part | object | ✓ Confirmed |
| `functionCall.id` | Part | string (optional) | ✓ Confirmed — mapper uses `fc.id ?? cryptoId()` |
| `functionResponse.name` | Part | string | ✓ Confirmed |
| `functionResponse.response` | Part | object | ✓ Confirmed |
| `toolCallResult.callId` | ToolCallResponseInfo | string | ✓ Confirmed |
| `toolCallResult.status` | ChatRecord (& Status) | 'success' \| 'error' \| ... | ✓ Confirmed |
| `ChatRecord.type` | ChatRecord | 'user' \| 'assistant' \| 'tool_result' \| 'system' | ✓ Confirmed |
| `ChatRecord.uuid`, `parentUuid`, `timestamp`, `model` | ChatRecord | string | ✓ Confirmed |

### Discrepancy found and corrected

| Field | Brief draft assumed | Real qwen-code source | Action taken |
|---|---|---|---|
| Parts array field on `message` | `msg.content` | `msg.parts` (from `@google/genai` `Content` interface: `{ role?: string; parts?: Part[] }`) | **Fixed** — mapper reads `msg.parts`; test fixtures updated from `content: [...]` to `parts: [...]` |

The brief's draft test fixtures used `message: { role: 'assistant', content: [{...}] }` (Claude-dialect shape). The real qwen-code `Content` type from `@google/genai` uses `parts: Part[]`. Both the mapper and all test fixtures were corrected to use `parts`.

---

## Output contract compliance (db.ts:ingestLine)

The mapper produces lines that satisfy every field `ingestLine` reads:

| db.ts field | Mapper output |
|---|---|
| `parsed.type` | `'user'` or `'assistant'` (tool_result folds to `'user'`) |
| `parsed.uuid` | forwarded from `rec.uuid` |
| `parsed.parentUuid` | forwarded |
| `parsed.timestamp` | forwarded (ISO string) |
| `message.model` | forwarded from `rec.model` |
| `message.usage.input_tokens` | from `usageMetadata.promptTokenCount` |
| `message.usage.output_tokens` | from `usageMetadata.candidatesTokenCount` |
| `message.usage.cache_read_input_tokens` | from `usageMetadata.cachedContentTokenCount` |
| `message.usage.cache_creation_input_tokens` | `0` (qwen doesn't track separately) |
| `message.usage.service_tier` | `'standard'` |
| `message.content[]` tool_use block | `{type:'tool_use', id, name, input}` from `functionCall` parts |
| `message.content[]` tool_result block | `{type:'tool_result', tool_use_id, is_error, content}` from `functionResponse` parts |
| `message.content` (string) | joined text for user records — satisfies `first_user_message` path at db.ts:618 |

The `extractToolDetail` function in db.ts (line 1864) reads `block.type === 'tool_use'`, `block.name`, `block.id`, `block.tool_use_id`, `block.is_error` — all correctly emitted.

---

## Test output

```
 RUN  v4.1.7

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  23:12:20
   Duration  6.23s (transform 235ms, setup 0ms, import 648ms, tests 13ms, environment 0ms)
```

## Typecheck output

```
npm run typecheck 2>&1 | grep -E "error TS" | grep -vE "TS6307|addon-webgl|addon-canvas"
(empty — zero new semantic errors)
```

---

## Fields that remain UNVERIFIED

None material. All fields used by the mapper were confirmed against the live GitHub source. The one known unknown is whether the `@google/genai` package version pinned in qwen-code's `package.json` has a different Part shape — but the current `types.ts` in `js-genai` main clearly uses `parts[]` and that's what the fetched `chatRecordingService.ts` also relies on.

---

## Review-finding fixes (commit `09c10c8`)

### Bug: user text emitted as array, not string

**Root cause:** `content()` returned `[textChunks.join('')]` (a one-element array) for plain-text user records. `db.ts:ingestLine` at line 616 checks `typeof message?.content === 'string'` before updating `first_user_message`, so the title was never populated.

**Fix:** Changed `content()` return type from `unknown[]` to `string | unknown[]`. For `rec.type === 'user'` records with no tool blocks, now returns `textChunks.join('')` (bare string). Tool_result records and records with tool blocks still return an array.

### False-green test fixed

Replaced `.toContain('do the thing')` (passes for both array and string) with:
```typescript
expect(typeof out.message.content).toBe('string');
expect(out.message.content).toBe('do the thing');
```
This assertion fails against the old mapper (array) and passes after the fix.

### New test coverage added

- **`functionCall.id` fast-path:** fixture with `functionCall: { id: 'fc_id_123', ... }` asserts `tu.id === 'fc_id_123'` (not synthesized).
- **Mixed text+functionCall:** asserts emitted content has both `text` and `tool_use` blocks, and text precedes tool_use.
- **No `usageMetadata`:** asserts `message.usage` is `undefined`.

### Minor: Gemini envelope comment

Added inline comment at `functionResponse.response` read: `// part.functionResponse.response is the conventional Gemini FunctionResponse envelope.`

### Test output (post-fix)

```
 RUN  v4.1.7

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  23:21:05
   Duration  3.81s (transform 110ms, setup 0ms, import 368ms, tests 7ms, environment 0ms)
```

### Typecheck output (post-fix)

```
npm run typecheck 2>&1 | grep -E "error TS" | grep -vE "TS6307|addon-webgl|addon-canvas"
(empty — zero new semantic errors)
```
