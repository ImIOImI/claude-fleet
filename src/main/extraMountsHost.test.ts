import { mkdtemp, mkdir, symlink, unlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dockerSocketDirs, mountsForWrite, toDockerMounts, validateExtraMounts, type MountCtx } from './extraMountsHost';

const OWN = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01JBBBBBBBBBBBBBBBBBBBBBBB';
let root: string;
let ctx: MountCtx;
let data: string;
let sockDir: string;
let cfgDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mounts-'));
  const userData = join(root, 'userData');
  const fleetRoot = join(root, 'fleet');
  data = join(root, 'data');
  await mkdir(join(userData, 'state'), { recursive: true });
  await mkdir(join(fleetRoot, OWN), { recursive: true });
  await mkdir(join(fleetRoot, OTHER), { recursive: true });
  await mkdir(data);
  sockDir = join(root, 'dockerd', 'run');
  await mkdir(sockDir, { recursive: true });
  cfgDir = join(root, 'home', '.docker');
  await mkdir(cfgDir, { recursive: true });
  ctx = {
    ownId: OWN,
    userData,
    fleetRoot,
    docker: { socketDirs: [await realpath(sockDir)], dockerConfigDirs: [await realpath(cfgDir)] }
  };
});

describe('validateExtraMounts', () => {
  it('returns undefined for no mounts', async () => {
    expect(await validateExtraMounts(undefined, ctx)).toBeUndefined();
    expect(await validateExtraMounts([], ctx)).toBeUndefined();
  });

  it('normalizes the container path and fills the default', async () => {
    expect(
      await validateExtraMounts(
        [
          { hostPath: data, containerPath: '/mnt//d/', readOnly: true },
          { hostPath: data, containerPath: '', readOnly: false }
        ],
        ctx
      )
    ).toEqual([
      { hostPath: data, containerPath: '/mnt/d', readOnly: true },
      { hostPath: data, containerPath: '/mnt/data', readOnly: false }
    ]);
  });

  it('rejects a missing host folder', async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(root, 'nope'), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow(`Mount 1: ${join(root, 'nope')} doesn't exist or isn't a folder.`);
  });

  it('rejects a file', async () => {
    const f = join(root, 'f.txt');
    await writeFile(f, '');
    await expect(validateExtraMounts([{ hostPath: f, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      "doesn't exist or isn't a folder"
    );
  });

  it('rejects a relative host path', async () => {
    await expect(
      validateExtraMounts([{ hostPath: 'relative/path', containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow('Mount 1: relative/path must be a full path.');
  });

  it('rejects userData and a symlink into it', async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.userData, 'state'), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: that folder holds the app's private data and can't be mounted.");
    const link = join(root, 'sneaky');
    await symlink(ctx.userData, link);
    await expect(
      validateExtraMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("app's private data");
  });

  it("treats a '..x'-named child as inside its parent, not outside", async () => {
    const dotted = join(ctx.userData, '..x');
    await mkdir(dotted);
    await expect(
      validateExtraMounts([{ hostPath: dotted, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("app's private data");
  });

  it("rejects another workspace's private folder but allows its own", async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OTHER), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: that folder is another workspace's private folder.");
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OWN), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('allows the fleet shared folder', async () => {
    await mkdir(join(ctx.fleetRoot, 'shared'));
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, 'shared'), containerPath: '/mnt/s', readOnly: true }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('rejects a non-ULID, non-shared child of the fleet root', async () => {
    await mkdir(join(ctx.fleetRoot, 'legacy-name'));
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, 'legacy-name'), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow(
      "Mount 1: that folder is inside the fleet folder; only the shared folder and this workspace's own folder can be mounted."
    );
  });

  it('rejects reserved container paths with the shared copy', async () => {
    await expect(
      validateExtraMounts([{ hostPath: data, containerPath: '/shared/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: /shared is the fleet's shared folder. Use a path outside it, like /mnt/data.");
  });

  it('rejects duplicate container paths', async () => {
    await expect(
      validateExtraMounts(
        [
          { hostPath: data, containerPath: '/mnt/a', readOnly: false },
          { hostPath: data, containerPath: '/mnt/a/', readOnly: false }
        ],
        ctx
      )
    ).rejects.toThrow('Mount 2: /mnt/a is already used by another mount.');
  });

  it('rejects an ancestor of userData', async () => {
    await expect(validateExtraMounts([{ hostPath: root, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      "app's private data"
    );
  });

  it('rejects an ancestor of the fleet root even when userData lives elsewhere', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'userdata-'));
    const isolatedCtx: MountCtx = { ownId: OWN, userData: otherRoot, fleetRoot: ctx.fleetRoot, docker: { socketDirs: [], dockerConfigDirs: [] } };
    await expect(
      validateExtraMounts([{ hostPath: root, containerPath: '/mnt/x', readOnly: false }], isolatedCtx)
    ).rejects.toThrow("Mount 1: that folder contains other workspaces' private folders.");
  });
});

describe('host path guards', () => {
  it("rejects the Docker socket's folder and its ancestors", async () => {
    const msg = "Mount 1: that folder holds Docker's control socket and can't be mounted.";
    for (const hostPath of [sockDir, join(root, 'dockerd')]) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], ctx)
      ).rejects.toThrow(msg);
    }
  });

  it('allows folders inside the socket folder (like /run/media/<user>/<drive>)', async () => {
    const drive = join(sockDir, 'media', 'troy', 'usb');
    await mkdir(drive, { recursive: true });
    await expect(
      validateExtraMounts([{ hostPath: drive, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('rejects ~/.docker, anything inside it, and its ancestors', async () => {
    await mkdir(join(cfgDir, 'sub'));
    for (const hostPath of [cfgDir, join(cfgDir, 'sub'), join(root, 'home')]) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], ctx)
      ).rejects.toThrow("Mount 1: that folder holds Docker's control socket and can't be mounted.");
    }
  });

  it('protects the real folder of a symlinked socket (WSL Docker Desktop)', async () => {
    const realSockDir = join(root, 'wsl', 'docker-desktop', 'shared-sockets');
    await mkdir(realSockDir, { recursive: true });
    await writeFile(join(realSockDir, 'docker.sock'), '');
    const literal = join(root, 'varrun');
    await mkdir(literal);
    await symlink(join(realSockDir, 'docker.sock'), join(literal, 'docker.sock'));
    const docker = await dockerSocketDirs({ DOCKER_HOST: `unix://${join(literal, 'docker.sock')}` }, join(root, 'nohome'), 'linux');
    expect(docker.socketDirs).toEqual([await realpath(literal), await realpath(realSockDir)]);
    for (const hostPath of [literal, join(root, 'wsl')]) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], { ...ctx, docker })
      ).rejects.toThrow("Docker's control socket");
    }
  });

  it('refuses /run with the default socket on unix', async () => {
    const docker = await dockerSocketDirs({}, join(root, 'nohome'), 'linux');
    if (!docker.socketDirs.includes(await realpath('/run').catch(() => ''))) return;
    await expect(
      validateExtraMounts([{ hostPath: '/run', containerPath: '/mnt/x', readOnly: false }], { ...ctx, docker })
    ).rejects.toThrow("Docker's control socket");
  });

  it('rejects a symlink into the Docker socket folder', async () => {
    const link = join(root, 'socklink');
    await symlink(sockDir, link);
    await expect(
      validateExtraMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Docker's control socket");
  });

  it('allows a sibling of the Docker socket folder', async () => {
    const sib = join(root, 'dockerd', 'runner');
    await mkdir(sib);
    await expect(
      validateExtraMounts([{ hostPath: sib, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('rejects UNC and network paths without touching the filesystem', async () => {
    const msg =
      'Mount 1: network and WSL paths (\\\\server\\… or \\\\wsl.localhost\\…) can\'t be mounted. Use a local drive path.';
    for (const hostPath of ['\\\\wsl.localhost\\Ubuntu\\home', '\\\\server\\share', '//server/share']) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], ctx)
      ).rejects.toThrow(msg);
    }
  });

  it('a re-pointed symlink into the Docker socket folder fails at create time', async () => {
    const benign = join(root, 'benign4');
    await mkdir(benign);
    const link = join(root, 'link4');
    await symlink(benign, link);
    await unlink(link);
    await symlink(sockDir, link);
    await expect(toDockerMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      `extra mount ${link} now points somewhere that can't be mounted`
    );
  });
});

describe('dockerSocketDirs', () => {
  it('uses the DOCKER_HOST unix socket folder and ~/.docker, realpathed', async () => {
    const dirs = await dockerSocketDirs({ DOCKER_HOST: `unix://${join(sockDir, 'docker.sock')}` }, join(root, 'home'), 'linux');
    expect(dirs).toEqual({ socketDirs: [await realpath(sockDir)], dockerConfigDirs: [await realpath(cfgDir)] });
  });

  it('skips folders that do not exist', async () => {
    expect(
      await dockerSocketDirs({ DOCKER_HOST: `unix://${join(root, 'missing', 'd.sock')}` }, join(root, 'nohome'), 'linux')
    ).toEqual({ socketDirs: [], dockerConfigDirs: [] });
  });

  it('has no socket folder for a tcp DOCKER_HOST', async () => {
    expect(await dockerSocketDirs({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }, join(root, 'home'), 'linux')).toEqual({
      socketDirs: [],
      dockerConfigDirs: [await realpath(cfgDir)]
    });
  });

  it('defaults to /var/run/docker.sock on unix', async () => {
    const dirs = await dockerSocketDirs({}, join(root, 'nohome'), 'linux');
    const literal = await realpath('/var/run').catch(() => null);
    if (literal) expect(dirs.socketDirs[0]).toBe(literal);
    else expect(dirs.socketDirs).toEqual([]);
  });

  it('only checks ~/.docker on Windows (the socket is a named pipe)', async () => {
    expect(await dockerSocketDirs({}, join(root, 'home'), 'win32')).toEqual({
      socketDirs: [],
      dockerConfigDirs: [await realpath(cfgDir)]
    });
  });
});

describe('toDockerMounts', () => {
  it('builds bind mounts using the resolved realpath as Source', async () => {
    const real = await realpath(data);
    expect(await toDockerMounts([{ hostPath: data, containerPath: '/mnt/data', readOnly: true }], ctx)).toEqual([
      { Type: 'bind', Source: real, Target: '/mnt/data', ReadOnly: true }
    ]);
  });

  it('fails clearly when a source disappeared', async () => {
    const gone = join(root, 'gone');
    await expect(toDockerMounts([{ hostPath: gone, containerPath: '/mnt/g', readOnly: false }], ctx)).rejects.toThrow(
      `extra mount ${gone} no longer exists`
    );
  });

  it('returns [] for none', async () => {
    expect(await toDockerMounts(undefined, ctx)).toEqual([]);
  });

  it('resolves Source through a symlink to its realpath', async () => {
    const benign = join(root, 'benign');
    await mkdir(benign);
    const link = join(root, 'link');
    await symlink(benign, link);
    const real = await realpath(benign);
    expect(await toDockerMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)).toEqual([
      { Type: 'bind', Source: real, Target: '/mnt/x', ReadOnly: false }
    ]);
  });

  it('revalidates at create time: a symlink re-pointed into userData is rejected', async () => {
    const benign = join(root, 'benign2');
    await mkdir(benign);
    const link = join(root, 'link2');
    await symlink(benign, link);
    await expect(
      validateExtraMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);

    await unlink(link);
    await symlink(ctx.userData, link);
    await expect(toDockerMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      `extra mount ${link} now points somewhere that can't be mounted`
    );
  });

  it("revalidates at create time: a symlink re-pointed into another workspace's folder is rejected", async () => {
    const benign = join(root, 'benign3');
    await mkdir(benign);
    const link = join(root, 'link3');
    await symlink(benign, link);
    await expect(
      validateExtraMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);

    await unlink(link);
    await symlink(join(ctx.fleetRoot, OTHER), link);
    await expect(toDockerMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      `extra mount ${link} now points somewhere that can't be mounted`
    );
  });
});

describe('mountsForWrite', () => {
  it('keeps unchanged mounts without re-checking a temporarily missing folder', async () => {
    const gone = join(root, 'unplugged');
    const existing = [{ hostPath: gone, containerPath: '/mnt/u', readOnly: true }];
    expect(await mountsForWrite([{ ...existing[0]! }], existing, ctx)).toEqual(existing);
  });

  it('still applies container-path rules to unchanged mounts', async () => {
    const stale = [{ hostPath: data, containerPath: '/home/fleet', readOnly: false }];
    await expect(mountsForWrite([{ ...stale[0]! }], stale, ctx)).rejects.toThrow(
      "Mount 1: /home/fleet contains the app's own folders (/home/fleet/.claude). Use a path outside it, like /mnt/data."
    );
    const dupes = [
      { hostPath: data, containerPath: '/mnt/a', readOnly: false },
      { hostPath: data, containerPath: '/mnt/a', readOnly: false }
    ];
    await expect(mountsForWrite(dupes.map((m) => ({ ...m })), dupes, ctx)).rejects.toThrow(
      'Mount 2: /mnt/a is already used by another mount.'
    );
  });

  it('validates when the mounts changed', async () => {
    const gone = join(root, 'unplugged');
    await expect(
      mountsForWrite([{ hostPath: gone, containerPath: '/mnt/u', readOnly: false }], [{ hostPath: gone, containerPath: '/mnt/u', readOnly: true }], ctx)
    ).rejects.toThrow("doesn't exist or isn't a folder");
    expect(
      await mountsForWrite([{ hostPath: data, containerPath: '/mnt//d', readOnly: false }], undefined, ctx)
    ).toEqual([{ hostPath: data, containerPath: '/mnt/d', readOnly: false }]);
  });

  it('clears mounts when none come in', async () => {
    expect(await mountsForWrite(undefined, [{ hostPath: data, containerPath: '/mnt/d', readOnly: false }], ctx)).toBeUndefined();
    expect(await mountsForWrite(undefined, undefined, ctx)).toBeUndefined();
  });
});
