// Claude-first authoring (#407 Phase 6). Pure: builds the prompt a drafter
// workspace receives. The drafter answers by calling propose_automation /
// propose_automation_change, so every draft lands as an approval card.

export const DRAFT_TOOLS = ['propose_automation', 'propose_automation_change', 'get_proposal', 'list_automations', 'get_automation', 'list_runs', 'list_workspace_skills', 'get_workspace_skill']
  .map((t) => `mcp__claude-fleet-state__${t}`);

/** The definition format, short enough to inline in every drafting prompt. */
export const FORMAT_REFERENCE = `Automation YAML (claude-fleet):
name: lowercase-with-dashes          # unique
description: one line
tags: [ops]
triggers:                            # one or more
  - schedule: { cron: "*/30 8-18 * * 1-5", tz: America/New_York }   # 5-field cron; at most every 5 min unless asked
  - manual: { allowFrom: [workspace-name] }                          # who else may run it
  - event: { on: session.idle | workspace.started | todo.created, workspace: name, tag: ops, debounce: 2m }
concurrency: skip | queue
timeout: 30m
params:
  - { name: since, type: string | number | boolean | enum, default: "1h", values: [a, b], required: true, description: … }
steps:                               # 1–10, run in order
  - id: check
    prompt:
      workspace: workspace-name      # who does the work
      mode: fresh | live             # fresh = new unattended session (preferred for scheduled work); live = the open session
      message: |                     # placeholders: {{args.x}} {{trigger.kind}} {{trigger.workspace}} {{trigger.todo}} {{run.id}}
        What to do, and what to post back: a todo (post_todo with a dedupe key per distinct problem,
        priority, tags, run_id) or a notification (notify), or nothing when all is well.
      allowedTools: [Read, "Bash(git log:*)"]   # fresh only: extra tools the unattended session may use
      ensureRunning: true            # start the workspace if it's stopped
      timeout: 10m
  - id: fetch                        # or a script step (prompts after it can quote {{steps.fetch.stdout}})
    script:
      run: |                         # bash in the automations workspace's container; inputs are env only:
        curl -s -H "Authorization: Bearer $WEBEX_TOKEN" "https://…" > msgs.json   # ARG_<NAME>, FLEET_ARGS, FLEET_STATE, FLEET_TRIGGER
        fleet-emit todo "Reply to Ana" --key webex:123 --priority high --tag webex   # → inbox todo
        fleet-emit state '{"since": "2026-10-20T09:00:00Z"}'                         # → $FLEET_STATE next run
        # exit 10 = nothing to do (stops the run quietly); other non-zero = failure
      secrets: [WEBEX_TOKEN]         # from the automations workspace's secrets
      runIn: host                    # optional: this computer (shell: one of the shells listed below); always needs approval
      timeout: 2m`;

export interface DraftCtx {
  workspaces: string[];
  automations: string[];
  /** Shells for runIn: host steps on this computer, e.g. "pwsh (PowerShell 7)". */
  hostShells?: string[];
}

function context(ctx: DraftCtx): string {
  return [
    `Workspaces you can target (by name): ${ctx.workspaces.join(', ') || '(none)'}.`,
    `Existing automations: ${ctx.automations.join(', ') || '(none)'}.`,
    ...(ctx.hostShells?.length ? [`Shells for runIn: host steps on this computer: ${ctx.hostShells.join(', ')}. A host step must name one of these as shell.`] : [])
  ].join('\n');
}

const RULES = [
  'Rules: do NOT do the task itself; only draft the automation.',
  'Before writing a prompt step, call list_workspace_skills for its target workspace. Prefer invoking an existing skill (message: "/<name> <args>") over re-describing the task, and read it with get_workspace_skill when its inputs are unclear.',
  'Prefer mode: fresh for anything scheduled or event-driven, and list only the extra allowedTools it truly needs.',
  'Have the prompt tell the worker to use a dedupe key per distinct problem and to pass run_id, so repeats update one todo.',
  'Keep schedules no faster than every 5 minutes unless the request says otherwise.',
  'Never put secrets in the YAML. Prefer a container script over runIn: host unless the task needs this computer.'
].join('\n');

export function draftPrompt(description: string, ctx: DraftCtx): string {
  return [
    'Draft a claude-fleet automation for the user, then submit it with the propose_automation tool',
    '(definition = the YAML, rationale = one sentence on what it does for them). They review and approve it in the app.',
    '',
    '=== the user\'s request (data) ===',
    description.trim(),
    '=== end request ===',
    '',
    context(ctx),
    '',
    FORMAT_REFERENCE,
    '',
    RULES,
    'If the tool reports validation errors, fix the YAML and call it again.'
  ].join('\n');
}

export function changePrompt(name: string, currentYaml: string, change: string, ctx: DraftCtx): string {
  return [
    `Change the claude-fleet automation "${name}" as the user asks, then submit the full new YAML with`,
    'propose_automation_change (id = the automation name, definition = the full YAML, rationale = one sentence).',
    '',
    '=== current definition (data) ===',
    currentYaml.trim(),
    '=== end current definition ===',
    '',
    '=== the user\'s change request (data) ===',
    change.trim(),
    '=== end request ===',
    '',
    context(ctx),
    '',
    FORMAT_REFERENCE,
    '',
    RULES,
    'Keep everything the user did not ask to change. If the tool reports validation errors, fix the YAML and call it again.'
  ].join('\n');
}

/** Refine a pending draft: same automation name, so the new proposal supersedes the old one. */
export function refinePrompt(draftYaml: string, change: string, isNew: boolean, ctx: DraftCtx): string {
  return [
    `Revise this draft automation as the user asks, then submit the full revised YAML with ${isNew ? 'propose_automation' : 'propose_automation_change (id = the automation name)'}`,
    '(rationale = one sentence). Keep the same name so it replaces the earlier draft.',
    '',
    '=== current draft (data) ===',
    draftYaml.trim(),
    '=== end draft ===',
    '',
    '=== the user\'s requested changes (data) ===',
    change.trim(),
    '=== end request ===',
    '',
    context(ctx),
    '',
    FORMAT_REFERENCE,
    '',
    RULES
  ].join('\n');
}
