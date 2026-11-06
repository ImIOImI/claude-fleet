import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dockerodeManagedDocker } from './managedDocker.js';
import { MANAGED_PG_IMAGE } from './managedPostgres.js';

function fakeDockerode(o: { execStates?: Array<{ Running: boolean; ExitCode: number | null }>; streamEnds?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const execInspects = { n: 0 };
  const docker = {
    createContainer: async (opts: Record<string, unknown>) => { created.push(opts); },
    getContainer: () => ({
      modem: { demuxStream: (s: PassThrough) => s.resume() },
      exec: async () => ({
        start: async () => {
          const s = new PassThrough();
          if (o.streamEnds !== false) setImmediate(() => s.end());
          return s;
        },
        inspect: async () => {
          const states = o.execStates ?? [{ Running: false, ExitCode: 0 }];
          return states[Math.min(execInspects.n++, states.length - 1)];
        },
      }),
      inspect: async () => ({
        State: { Running: true },
        Config: { Image: MANAGED_PG_IMAGE, Labels: { 'com.claude-fleet.store': 'postgres' } },
        HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] } },
      }),
    }),
  };
  return { docker: docker as unknown as Docker, created, execInspects };
}

describe('dockerodeManagedDocker', () => {
  it('publishes Postgres on loopback only, at the given fixed host port, never restarting on its own', async () => {
    const { docker, created } = fakeDockerode();
    await dockerodeManagedDocker(docker).createContainer({
      name: 'n', image: MANAGED_PG_IMAGE, env: [], labels: {}, volume: 'v', hostPort: 41234,
    });
    const host = created[0].HostConfig as Record<string, unknown>;
    expect(host.PortBindings).toEqual({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] });
    expect(host.RestartPolicy).toEqual({ Name: 'no' });
    expect(host.Mounts).toEqual([{ Type: 'volume', Source: 'v', Target: '/var/lib/postgresql/data' }]);
  });

  it('reads the fixed host port back from the binding', async () => {
    const { docker } = fakeDockerode();
    expect(await dockerodeManagedDocker(docker).inspectContainer('n')).toEqual({
      running: true, image: MANAGED_PG_IMAGE, hostPort: 41234, hostIp: '127.0.0.1', labels: { 'com.claude-fleet.store': 'postgres' },
    });
  });

  it('exec waits for the process to stop running before reading its exit code', async () => {
    const { docker, execInspects } = fakeDockerode({
      execStates: [{ Running: true, ExitCode: null }, { Running: true, ExitCode: null }, { Running: false, ExitCode: 3 }],
    });
    expect(await dockerodeManagedDocker(docker).exec('n', ['true'])).toEqual({ exitCode: 3, output: '' });
    expect(execInspects.n).toBe(3);
  });

  it('exec gives up at its timeout', async () => {
    const { docker } = fakeDockerode({ streamEnds: false, execStates: [{ Running: true, ExitCode: null }] });
    expect((await dockerodeManagedDocker(docker).exec('n', ['pg_isready'], undefined, 50)).exitCode).toBe(-1);
  });
});
