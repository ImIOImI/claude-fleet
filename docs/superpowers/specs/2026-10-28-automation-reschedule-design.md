# Automation reschedule — a run sets its own next fire (#437)

## Goal

Let an automation decide, from what a run found, when it should run next —
bounded below by a floor the user approved in the definition. Motivating case:
a desktop-watching automation that looks at the screen and decides how soon to
look again.

## Definition

```yaml
reschedule:
  min: 30m        # the floor; s/m/h/d; at least 5m, at most 30d
triggers:
  - manual: {}    # a cron is optional (already true today)
```

- `reschedule` present → runs may request their next fire. Absent → unchanged.
- No cron is valid. With no cron and no request, the automation idles until a
  manual run, an event, or a todo wakes it. Recovering from that is the
  automation's job (an optional cron, the `run-failed` notification, a todo) —
  there is deliberately no `max` / fallback.
- `parseDuration` gains a `d` unit.

## Requesting the next fire

- **Script steps:** a stdout line `{"next":{"in":"4h"}}` or
  `{"next":{"at":"<ISO-8601>"}}` (`fleet-emit next 4h` / `fleet-emit next --at <ISO>`).
- **Prompt steps:** MCP tool `schedule_next({run_id, in | at})`. Same gate as a
  `post_todo` with `run_id`: the run is live and one of its steps targets the
  caller; the automation must declare `reschedule`. Fresh sessions get the tool
  in `--allowedTools` only when it does.
- `in` resolves against the time of the request; `at` is absolute. Exactly one.
  Requests beyond 365 days are rejected.
- Last request in the run wins.
- Applied **when the run ends** with `succeeded` or `nothing-to-do`; a failed,
  timed-out or interrupted run applies nothing (like state). Not applied if the
  automation was edited, disabled or removed mid-run.
- Clamp: `applied = max(requested, runEnd + min)`. The run records
  `{requestedAt, appliedAt, by}` (`by` = step id); the detail flags a clamp.

## Scheduler (override)

- `automations.next_run_at` / `next_run_by` (inbox schema v5), plus
  `runs.reschedule` (JSON).
- While `next_run_at` is set it **replaces** the cron: due iff
  `now ≥ next_run_at`; `nextFireAt` reports it.
- When it fires: trigger `kind: 'rescheduled'` (param defaults as args),
  `next_run_at` cleared, `last_scheduled_at = now` so a cron resumes from there.
- A closed app gets one run on startup's first tick (like a catch-up). The rate
  cap and `skip`/`queue` still apply.
- Disable, a new version, or removal clears `next_run_at`.

## Classification

- Needs approval: adding `reschedule`; lowering `min`; dropping every schedule
  trigger while `reschedule` is present.
- Low-risk: raising `min`; removing `reschedule`.
- Flag: "sets its own next run (no sooner than 30m)".

## Surfaces

- Automation view: `nextFireAt` already drives "next"; add `nextSetByRun` so the
  UI says "set by a run", and `'rescheduled'` in the trigger labels. Run detail
  shows requested/applied.
- Drafting prompts' YAML reference + rules; the role brief picks the tool up
  from `TOOLS` automatically.
- SPEC: automations definition/running, MCP tool list, security (classification).
- `claude-fleet-loadouts`: update its automation-format docs if it has any.

## Testing

Unit: duration/definition validation; request parsing + clamp; script `next`
line; `dueSchedule`/`nextFireAt` with/without cron; classify rules. Service:
success/nothing-to-do apply, failure doesn't, last wins, edit/disable clears,
the fire clears and resumes the cron, `schedule_next` gate.
