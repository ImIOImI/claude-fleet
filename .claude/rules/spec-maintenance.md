# Rule: keep `docs/SPEC.md` in sync with decisions

## Why this rule exists

`docs/SPEC.md` is the single source of truth for **what** claude-fleet is and **how** it's built. The bar is: if every line of code were deleted, a competent engineer (or Claude) reading only the spec could rebuild a functionally equivalent application. If the spec drifts from reality, that property is lost and the document becomes worthless — and worse, misleading.

The spec is also the artifact you hand to Claude (or anyone else) to onboard them. Conversation context is ephemeral; the spec is the durable record.

## What counts as a decision worth recording

Update the spec when you:

- **Pick or change a runtime piece** — library, framework, runtime version, build tool (e.g., swap `keytar` for `safeStorage`, add `better-sqlite3`, move from Vite to esbuild).
- **Add, remove, or rename an IPC channel** — or change its payload shape.
- **Change a data model** — container labels, vault keys, sqlite schema, on-disk JSONL layout, env-var contract with the runner container.
- **Add or change a user-facing flow** — what the user clicks, what the app does in response.
- **Change the security model** — what runs in which process, what has access to what, how secrets are handled.
- **Decide what is explicitly out of scope** — non-goals are decisions too. Recording them prevents re-litigation.

Trivial changes do **not** warrant a spec update: bug fixes that don't change behavior, typo fixes, refactors that preserve the externally observable shape, dependency version bumps within the same major.

## When to update

Update `docs/SPEC.md` **in the same commit (or PR) as the implementing change**. Do not promise to "catch up later" — the spec gets stale fast and catch-up never happens.

If you make a decision but haven't implemented it yet, record it under the spec's **Open decisions** section so the next person doesn't re-litigate. Move it into the body of the spec when the implementation lands.

## How to write the update

- **Edit in place.** The spec describes the *current* state, not the history. Old decisions live in `git log`.
- **No changelog prose.** Don't write "previously we considered X but switched to Y." Just describe Y. Reasoning belongs in the spec only when it affects future judgment calls (e.g., "we chose dockerode over the docker CLI *because* we need streaming exec attach"). Pure historical narrative does not.
- **Dense, not exhaustive.** Skip restating what code already makes obvious. Capture what's non-obvious: invariants, constraints, the *why* behind a structural choice.
- **Concrete, not aspirational.** If a section describes something that doesn't exist yet, mark it under **Open decisions** or **Non-goals**. Do not describe vapor as if it's real.

## Handoff-readiness check

After updating, ask yourself: *if a fresh Claude session read only `docs/SPEC.md` and rebuilt the app from scratch, would the result be functionally equivalent to what's actually shipping?*

If the answer is "no, because X is missing or wrong," the update isn't done. The spec should always answer at least these questions:

- **Stack** — what runtime pieces, and *why* each major piece (so substitutions can be made knowingly).
- **Architecture** — processes, data flow, the IPC surface between them.
- **Data model** — container labels, vault keys, sqlite schema, on-disk layout, env-var contract.
- **User flows** — what the user does and what the app does in response, end to end.
- **Security model** — what runs in which process, what has access to what, where secrets live.
- **Non-goals** — what we deliberately do not build.
- **Open decisions** — known unresolved questions, with enough context that the next person can pick them up.
