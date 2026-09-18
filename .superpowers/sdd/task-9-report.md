# Task 9 Report — qwen→fleet transcript sidecar

## Files Created

- `docker/qwen/lines.mjs` — pure `nextLines(buffer)` export; no deps.
- `docker/qwen/sidecar.mjs` — self-contained Node ESM watcher loop.
- `src/main/qwenSidecar.test.ts` — two-case vitest suite for `nextLines`.

## Not-yet-present import handling

Both `./qwenAdapter.mjs` (Task 11) and `./title.mjs` (Task 10) are imported at
the top of `sidecar.mjs` with block comments explaining:
- `qwenAdapter.mjs` will be emitted by an esbuild step in the qwen Dockerfile (Task 11) that bundles `src/main/qwenAdapter.ts`.
- `title.mjs` will be authored as the OSC busy/idle title helper in Task 10.

The sidecar cannot be started until both files exist; this is documented in the
file header and in each import's inline comment.

## TS-resolution handling for .mjs import in .test.ts

`tsconfig.node.json` uses `"moduleResolution": "Bundler"`, which does not
resolve `.mjs` extensions for files outside the TS project tree. The import
would produce a TS7016 ("Could not find a declaration file") error at
typecheck time. The fix is a single `// @ts-expect-error` directive immediately
above the import, with an explanatory comment. This suppresses the error without
adding `allowJs`, without creating a stub `.d.ts`, and without touching any
tsconfig. Vitest resolves `.mjs` files at runtime fine regardless.

## Test output

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  ~4s
```

## Typecheck output

```
npm run typecheck 2>&1 | grep -E "error TS" | grep -vE "TS6307|addon-webgl|addon-canvas"
(empty — no new errors)
```

## Concerns

1. The `// @ts-expect-error` suppressor will become stale (and cause a TS error
   itself) once Task 11 ships a `docker/qwen/lines.d.ts` or the tsconfig gains
   `paths` for it. Whoever ships Task 11 should remove the directive.
2. `sidecar.mjs` reads the full new-byte chunk into a single Buffer. For very
   long-running sessions with large backlogs this is fine (qwen JSONL lines are
   small); if future compaction produces multi-MB files the approach is still
   correct because the offset resets to 0 and re-reads from the top.
3. The `setInterval` poll fallback fires every 1 s even when `fs.watch` is
   working. This causes a harmless extra stat + readdir per second; acceptable
   for the single-session sidecar use case.
