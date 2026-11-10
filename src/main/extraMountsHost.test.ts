import { mkdtemp, mkdir, symlink, unlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dockerSocketDirs, toDockerMounts, validateExtraMounts, type MountCtx } from './extraMountsHost';

const OWN = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01JBBBBBBBBBBBBBBBBBBBBBBB';
let root: string;
let ctx: MountCtx;
let data: string;
let sockDir: string;

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
  ctx = { ownId: OWN, userData, fleetRoot, dockerSocketDirs: [await realpath(sockDir)] };
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
    const isolatedCtx: MountCtx = { ownId: OWN, userData: otherRoot, fleetRoot: ctx.fleetRoot, dockerSocketDirs: [] };
    await expect(
      validateExtraMounts([{ hostPath: root, containerPath: '/mnt/x', readOnly: false }], isolatedCtx)
    ).rejects.toThrow("Mount 1: that folder contains other workspaces' private folders.");
  });
});

describe('host path guards', () => {
  it("rejects the Docker socket's folder, anything inside it, and its ancestors", async () => {
    const msg = "Mount 1: that folder holds Docker's control socket and can't be mounted.";
    await mkdir(join(sockDir, 'inner'));
    for (const hostPath of [sockDir, join(sockDir, 'inner'), join(root, 'dockerd')]) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], ctx)
      ).rejects.toThrow(msg);
    }
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
    const home = join(root, 'home');
    await mkdir(join(home, '.docker'), { recursive: true });
    const dirs = await dockerSocketDirs({ DOCKER_HOST: `unix://${join(sockDir, 'docker.sock')}` }, home, 'linux');
    expect(dirs).toEqual([await realpath(sockDir), await realpath(join(home, '.docker'))]);
  });

  it('skips folders that do not exist', async () => {
    const home = join(root, 'nohome');
    expect(await dockerSocketDirs({ DOCKER_HOST: `unix://${join(root, 'missing', 'd.sock')}` }, home, 'linux')).toEqual([]);
  });

  it('has no socket folder for a tcp DOCKER_HOST', async () => {
    const home = join(root, 'home2');
    await mkdir(join(home, '.docker'), { recursive: true });
    expect(await dockerSocketDirs({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }, home, 'linux')).toEqual([
      await realpath(join(home, '.docker'))
    ]);
  });

  it('defaults to /var/run on unix', async () => {
    const dirs = await dockerSocketDirs({}, join(root, 'nohome'), 'linux');
    const expected = await realpath('/var/run').then((r) => [r], () => []);
    expect(dirs).toEqual(expected);
  });

  it('only checks ~/.docker on Windows (the socket is a named pipe)', async () => {
    const home = join(root, 'home3');
    await mkdir(join(home, '.docker'), { recursive: true });
    expect(await dockerSocketDirs({}, home, 'win32')).toEqual([await realpath(join(home, '.docker'))]);
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
