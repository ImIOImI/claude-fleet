import { describe, it, expect } from 'vitest';
import { validateHarnessSelection } from './harness.js';

describe('validateHarnessSelection', () => {
  it('requires a harness for endpoint workspaces', () => {
    expect(validateHarnessSelection('endpoint', undefined)).toMatch(/harness/i);
  });
  it('accepts endpoint + a harness', () => {
    expect(validateHarnessSelection('endpoint', 'qwen-code')).toBeNull();
  });
  it('ignores harness for non-endpoint auth', () => {
    expect(validateHarnessSelection('oauth', undefined)).toBeNull();
  });
});
