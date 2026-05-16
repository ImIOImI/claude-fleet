# claude-fleet — project conventions

Project-scoped rules for anyone (human or agent) working in this repo.

## Rules

Operative rules live under `.claude/rules/`. Read them before touching the repo:

- [`.claude/rules/spec-maintenance.md`](.claude/rules/spec-maintenance.md) — keep [`docs/SPEC.md`](docs/SPEC.md) in sync with every product or architecture decision

## Spec

[`docs/SPEC.md`](docs/SPEC.md) is the single source of truth for what claude-fleet is and how it's built. It should be detailed enough that, if the codebase were deleted, a competent engineer (or Claude) could rebuild a functionally equivalent application from it. If you find yourself making a decision that isn't reflected there, update the spec in the same change.
