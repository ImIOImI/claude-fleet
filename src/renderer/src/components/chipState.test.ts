import { describe, it, expect } from 'vitest';
import { dotClass } from './chipState';

describe('dotClass', () => {
  it('waiting wins over busy', () => {
    expect(dotClass({ base: 'dot running', busy: true, waiting: true })).toBe('dot running waiting');
  });
  it('busy when not waiting', () => {
    expect(dotClass({ base: 'dot running', busy: true, waiting: false })).toBe('dot running busy');
  });
  it('plain when neither', () => {
    expect(dotClass({ base: 'dot running', busy: false, waiting: false })).toBe('dot running');
  });
});
