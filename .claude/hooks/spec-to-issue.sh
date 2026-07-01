#!/usr/bin/env bash
# PostToolUse hook: when a brainstorming design spec is written under
# docs/superpowers/specs/, open a matching GitHub issue — exactly once.
#
# Reads the Claude Code hook payload JSON on stdin; acts only on spec markdown
# files, so it is a no-op for every other Write/Edit. Dedupes by exact issue
# title (open OR closed) so the repeated writes during spec self-review don't
# spawn duplicate issues. Set SPEC_ISSUE_DRY_RUN=1 to log intent without
# calling `gh` (used for testing the hook safely).
set -uo pipefail

payload=$(cat)
f=$(printf '%s' "$payload" | jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)

# Only fire for spec markdown files; silently skip anything else.
case "$f" in
  */docs/superpowers/specs/*.md) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0

# Title = first H1 heading in the spec, else the filename.
title=$(grep -m1 '^# ' "$f" 2>/dev/null | sed 's/^#[[:space:]]*//')
[ -n "$title" ] || title=$(basename "$f" .md)

# Dedup: if an issue (any state) already carries this exact title, do nothing.
# Uses the list API (immediately consistent) rather than `--search`, whose index
# lags by seconds — a search-based check lets rapid re-writes create duplicates.
existing=$(gh issue list --state all --limit 300 --json title -q '.[].title' 2>/dev/null)
if printf '%s\n' "$existing" | grep -Fxq "$title"; then
  exit 0
fi

if [ -n "${SPEC_ISSUE_DRY_RUN:-}" ]; then
  echo "[dry-run] would create GitHub issue titled: $title"
  exit 0
fi

url=$(gh issue create --title "$title" --body-file "$f" 2>/dev/null)
[ -n "$url" ] && printf '{"systemMessage": "Opened GitHub issue for spec: %s"}\n' "$url"
exit 0
