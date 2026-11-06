// dockerode behind managedPostgres.ts's ManagedDocker.
import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { pullErrorFromEvent } from '../imagePull.js';
import type { ManagedContainer, ManagedContainerSpec, ManagedDocker } from './managedPostgres.js';

const PG_PORT = '5432/tcp';

const notFound = (e: unknown): boolean => (e as { statusCode?: number }).statusCode === 404;

export function dockerodeManagedDocker(docker: Docker = new Docker()): ManagedDocker {
  return {
    async ping() {
      try { await docker.ping(); return true; } catch { return false; }
    },
    async hasImage(ref) {
      try { await docker.getImage(ref).inspect(); return true; } catch (e) { if (notFound(e)) return false; throw e; }
    },
    async pull(ref, onProgress) {
      const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
      await new Promise<void>((resolve, reject) => {
        // A failed pull is an in-stream error line on a cleanly ending stream (imagePull.ts).
        let streamError: string | null = null;
        docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : streamError ? reject(new Error(streamError)) : resolve()),
          (event: Record<string, unknown>) => {
            const err = pullErrorFromEvent(event);
            if (err) { streamError ??= err; return; }
            if (typeof event.status === 'string') onProgress(event.status);
          },
        );
      });
    },
    async inspectVolume(name) {
      try {
        const v = await docker.getVolume(name).inspect();
        return { labels: (v.Labels ?? {}) as Record<string, string> };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async createVolume(name, labels) {
      await docker.createVolume({ Name: name, Labels: labels });
    },
    async inspectContainer(name): Promise<ManagedContainer | null> {
      try {
        const info = await docker.getContainer(name).inspect();
        const binding = info.HostConfig?.PortBindings?.[PG_PORT]?.[0]?.HostPort;
        return { running: info.State.Running, image: info.Config.Image, hostPort: binding ? Number(binding) : null };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async createContainer(spec: ManagedContainerSpec) {
      await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Env: spec.env,
        Labels: spec.labels,
        ExposedPorts: { [PG_PORT]: {} },
        Healthcheck: {
          Test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
          Interval: 5e9, Timeout: 3e9, Retries: 5, StartPeriod: 30e9,
        },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: spec.volume, Target: '/var/lib/postgresql/data' }],
          // A fixed host port, so the store pool's address survives a container restart.
          PortBindings: { [PG_PORT]: [{ HostIp: '127.0.0.1', HostPort: String(spec.hostPort) }] },
          RestartPolicy: { Name: 'no' },
        },
      });
    },
    async start(name) {
      await docker.getContainer(name).start();
    },
    async stop(name, timeoutS) {
      try {
        await docker.getContainer(name).stop({ t: timeoutS });
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode !== 304) throw e;
      }
    },
    async remove(name) {
      await docker.getContainer(name).remove();
    },
    async exec(name, cmd, env) {
      const container = docker.getContainer(name);
      const exec = await container.exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      let output = '';
      await new Promise<void>((resolve, reject) => {
        const sink = new Writable({ write(chunk, _enc, cb) { if (output.length < 100_000) output += chunk.toString('utf8'); cb(); } });
        container.modem.demuxStream(stream, sink, sink);
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', reject);
      });
      const info = await exec.inspect();
      return { exitCode: info.ExitCode ?? -1, output };
    },
  };
}
