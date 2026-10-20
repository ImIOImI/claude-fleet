import { describe, it, expect } from 'vitest';
import { draftPrompt, changePrompt, refinePrompt, DRAFT_TOOLS, FORMAT_REFERENCE } from './authoring.js';
import { parseDefinitionText } from './definition.js';

const ctx = { workspaces: ['ops-oncall', 'webex-triage'], automations: ['log-watch'] };

describe('authoring prompts', () => {
  it('a draft asks for propose_automation, quotes the request as data, lists targets, and carries the format', () => {
    const p = draftPrompt('Every weekday at 9, check prod errors and make todos', ctx);
    expect(p).toMatch(/submit it with the propose_automation tool/);
    expect(p).toContain("=== the user's request (data) ===\nEvery weekday at 9, check prod errors and make todos\n=== end request ===");
    expect(p).toContain('Workspaces you can target (by name): ops-oncall, webex-triage.');
    expect(p).toContain(FORMAT_REFERENCE);
    expect(p).toMatch(/do NOT do the task itself/);
  });
  it('a change keeps the current YAML and asks for the full new YAML via propose_automation_change', () => {
    const p = changePrompt('log-watch', 'name: log-watch\n', 'run every 30 min', ctx);
    expect(p).toMatch(/propose_automation_change \(id = the automation name/);
    expect(p).toContain('=== current definition (data) ===\nname: log-watch\n=== end current definition ===');
    expect(p).toMatch(/Keep everything the user did not ask to change/);
  });
  it('a refinement keeps the name so it supersedes the earlier draft', () => {
    expect(refinePrompt('name: x', 'skip bots', true, ctx)).toMatch(/with propose_automation\n/);
    expect(refinePrompt('name: x', 'skip bots', false, ctx)).toMatch(/propose_automation_change/);
    expect(refinePrompt('name: x', 'skip bots', true, ctx)).toMatch(/Keep the same name/);
  });
  it('the inline format reference is itself close to a valid definition, and the drafter gets only authoring tools', () => {
    expect(parseDefinitionText(FORMAT_REFERENCE.split('\n').slice(1).join('\n')).ok).toBe(true);
    expect(DRAFT_TOOLS.every((t) => t.startsWith('mcp__claude-fleet-state__'))).toBe(true);
    expect(DRAFT_TOOLS).toContain('mcp__claude-fleet-state__propose_automation');
    expect(DRAFT_TOOLS.some((t) => /post_todo|run_automation/.test(t))).toBe(false);
  });
});
