import { describe, expect, it } from 'vitest';
import { portPopupCopy } from './portToast';

const base = { workspaceId: 'W', port: 5173, label: null, reason: null, cmdline: null, declared: true };

describe('portPopupCopy', () => {
  it('declared: names the workspace, label and port, with the reason when given', () => {
    expect(portPopupCopy({ ...base, label: 'Vite dev server', reason: 'new header' }, 'Work')).toEqual({
      eyebrow: 'Preview',
      message: 'Work wants to show you Vite dev server on :5173 — new header'
    });
    expect(portPopupCopy({ ...base, label: 'Vite dev server' }, 'Work').message).toBe(
      'Work wants to show you Vite dev server on :5173'
    );
  });

  it('undeclared fallback: tagged, with the command when known', () => {
    expect(portPopupCopy({ ...base, declared: false, cmdline: 'node server.js' }, 'Work')).toEqual({
      eyebrow: 'Preview · undeclared',
      message: 'Server on port 5173 in Work (node server.js)'
    });
    expect(portPopupCopy({ ...base, declared: false }, 'Work').message).toBe('Server on port 5173 in Work');
  });
});
