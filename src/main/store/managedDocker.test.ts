import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { dockerodeManagedDocker } from './managedDocker.js';
import { MANAGED_PG_IMAGE } from './managedPostgres.js';

function fakeDockerode() {
  const created: Array<Record<string, unknown>> = [];
  const docker = {
    createContainer: async (opts: Record<string, unknown>) => { created.push(opts); },
    getContainer: () => ({
      inspect: async () => ({
        State: { Running: true },
        Config: { Image: MANAGED_PG_IMAGE },
        HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] } },
      }),
    }),
  };
  return { docker: docker as unknown as Docker, created };
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
    expect(await dockerodeManagedDocker(docker).inspectContainer('n')).toEqual({ running: true, image: MANAGED_PG_IMAGE, hostPort: 41234 });
  });
});
