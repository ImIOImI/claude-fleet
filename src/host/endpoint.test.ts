import { describe, expect, it } from 'vitest';
import { parseHostPort, parsePort } from './endpoint.js';

describe('parsePort', () => {
  it('takes 1-65535 as plain digits only', () => {
    expect(parsePort('8081')).toBe(8081);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('1')).toBe(1);
    for (const bad of ['0', '65536', '99999', '-1', '80.5', ' 80', '80 ', '0x50', '1e3', '123456', '']) expect(parsePort(bad), bad).toBeNull();
  });
});

describe('parseHostPort', () => {
  it('takes a DNS name or IPv4 with a port', () => {
    expect(parseHostPort('fleet-agent-workspace.platform-ops.svc:7070')).toEqual({ host: 'fleet-agent-workspace.platform-ops.svc', port: 7070 });
    expect(parseHostPort('10.0.0.7:8081')).toEqual({ host: '10.0.0.7', port: 8081 });
  });
  it('refuses schemes, paths, IPv6 literals and missing parts', () => {
    for (const bad of ['http://h:1', 'h:1/x', '[::1]:1', '::1:1', 'h', ':1', 'h:', 'h:0', 'h:65536', 'a b:1', ' h:1', 'h:1 ', 'h:1\n', 'u@h:1', 'h:1:2'])
      expect(parseHostPort(bad), bad).toBeNull();
  });
});
