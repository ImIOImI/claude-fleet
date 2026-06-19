import { afterEach, describe, expect, it } from 'vitest';
import {
  setWorkspaceDefault,
  setSessionOverride,
  learnMapping,
  effectiveForClaudeSession,
  _resetMirrorPolicyForTests
} from './mirrorPolicy.js';

const WS = '01WORKSPACEAAAAAAAAAAAAAAA';
const BROKER = 'broker-tab-1';
const CLAUDE = '11111111-2222-3333-4444-555555555555';

afterEach(() => _resetMirrorPolicyForTests());

describe('effectiveForClaudeSession', () => {
  it('defaults to on (factory) with no policy set', () => {
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(true);
  });

  it('follows the workspace default when there is no override', () => {
    setWorkspaceDefault(WS, 'off');
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(false);
    setWorkspaceDefault(WS, 'on');
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(true);
  });

  it('a session override wins over the workspace default once the mapping is learned', () => {
    setWorkspaceDefault(WS, 'on');
    setSessionOverride(WS, BROKER, 'off');
    // Before the broker→claude mapping is learned, the claude session still
    // follows the workspace default (the documented early-turn window).
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(true);
    learnMapping(WS, BROKER, CLAUDE);
    // After the mapping lands, the override applies.
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(false);
  });

  it('an on-override wins over an off workspace default', () => {
    setWorkspaceDefault(WS, 'off');
    setSessionOverride(WS, BROKER, 'on');
    learnMapping(WS, BROKER, CLAUDE);
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(true);
  });

  it('learnMapping with no pending override leaves the workspace default in force', () => {
    setWorkspaceDefault(WS, 'off');
    learnMapping(WS, BROKER, CLAUDE); // no setSessionOverride beforehand
    expect(effectiveForClaudeSession(WS, CLAUDE)).toBe(false);
  });

  it('keys are workspace-scoped — another workspace is unaffected', () => {
    setWorkspaceDefault(WS, 'off');
    expect(effectiveForClaudeSession('01OTHERWORKSPACEBBBBBBBBBB', CLAUDE)).toBe(true);
  });
});
