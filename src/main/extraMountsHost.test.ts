import { mkdtemp, mkdir, symlink, unlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  dockerSocketDirs,
  mountsForWrite,
  toDockerMounts,
  validateExtraMounts,
  wslRealDir,
  type MountCtx,
  type WslMount
} from './extraMountsHost';

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

  it('rejects network paths, and every UNC path off Windows, without touching the filesystem', async () => {
    const msg =
      "Mount 1: network paths (\\\\server\\share) can't be mounted. Use a local drive or a WSL path (\\\\wsl$\\<distro>\\…).";
    for (const hostPath of ['\\\\wsl.localhost\\Ubuntu\\home', '\\\\server\\share', '//server/share']) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], { ...ctx, platform: 'linux' })
      ).rejects.toThrow(msg);
    }
    for (const hostPath of ['\\\\server\\share\\x', '//server/share']) {
      await expect(
        validateExtraMounts([{ hostPath, containerPath: '/mnt/x', readOnly: false }], { ...ctx, platform: 'win32' })
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

describe('WSL sources (Windows)', () => {
  const winCtx = (resolve: (distro: string, p: string) => Promise<string | null>, mounts: WslMount[] = []): MountCtx => ({
    ...ctx,
    platform: 'win32',
    wslRealDir: async (d, p) => {
      const real = await resolve(d, p);
      return real === null ? null : { real, mounts };
    }
  });
  const one = (hostPath: string) => [{ hostPath, containerPath: '/mnt/x', readOnly: false }];

  it('accepts a WSL folder and hands Docker the \\\\wsl$ form of its in-distro realpath', async () => {
    const calls: Array<[string, string]> = [];
    const c = winCtx(async (d, p) => {
      calls.push([d, p]);
      return '/home/troy/proj';
    });
    const host = '\\\\wsl.localhost\\Ubuntu\\home\\troy\\proj';
    expect(await validateExtraMounts(one(host), c)).toEqual(one(host));
    expect(await toDockerMounts(one(host), c)).toEqual([
      { Type: 'bind', Source: '\\\\wsl$\\Ubuntu\\home\\troy\\proj', Target: '/mnt/x', ReadOnly: false }
    ]);
    expect(calls).toEqual([
      ['Ubuntu', '/home/troy/proj'],
      ['Ubuntu', '/home/troy/proj']
    ]);
  });

  it('refuses a WSL symlink into a Windows drive', async () => {
    await expect(
      validateExtraMounts(one('\\\\wsl$\\Ubuntu\\home\\troy\\link'), winCtx(async () => '/mnt/c/Users/x/AppData'))
    ).rejects.toThrow(
      "Mount 1: that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead."
    );
  });

  it.each([
    ['/', 'that folder contains system or Docker folders and can\'t be mounted.'],
    ['/home', 'that folder contains system or Docker folders and can\'t be mounted.'],
    ['/var', 'that folder contains system or Docker folders and can\'t be mounted.'],
    ['/mnt', "that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead."],
    ['/mnt/wsl/docker-desktop', "that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead."],
    ['/run/user/1000', "that's a system folder and can't be mounted."],
    ['/proc', "that's a system folder and can't be mounted."],
    ['/var/run/x', "that's a system folder and can't be mounted."],
    ['/home/troy', "that's a whole home folder (it holds .claude and .docker). Mount a folder inside it."],
    ['/root', "that's a whole home folder (it holds .claude and .docker). Mount a folder inside it."],
    ['/home/troy/.docker/x', "that folder holds Docker's settings and can't be mounted."],
    ['/srv/.docker', "that folder holds Docker's settings and can't be mounted."]
  ])('refuses in-distro %s', async (real, msg) => {
    await expect(validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real))).rejects.toThrow(
      `Mount 1: ${msg}`
    );
  });

  it('allows ordinary folders, including inside /root and /home/<user>', async () => {
    for (const real of ['/root/proj', '/home/troy/proj/sub', '/srv/data', '/var/lib/x']) {
      await expect(validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real))).resolves.toHaveLength(1);
    }
  });

  it('reports a missing WSL folder', async () => {
    const host = '\\\\wsl$\\Ubuntu\\gone';
    await expect(validateExtraMounts(one(host), winCtx(async () => null))).rejects.toThrow(
      `Mount 1: ${host} doesn't exist or isn't a folder.`
    );
    await expect(toDockerMounts(one(host), winCtx(async () => null))).rejects.toThrow(`extra mount ${host} no longer exists`);
  });

  it('revalidates at create time: a WSL folder re-pointed into /mnt is rejected', async () => {
    const host = '\\\\wsl$\\Ubuntu\\home\\troy\\link';
    let target = '/home/troy/proj';
    const c = winCtx(async () => target);
    await expect(validateExtraMounts(one(host), c)).resolves.toHaveLength(1);
    target = '/mnt/c/Users/x/AppData';
    await expect(toDockerMounts(one(host), c)).rejects.toThrow(`extra mount ${host} now points somewhere that can't be mounted`);
  });

  it('refuses an unsafe distro name without calling the resolver', async () => {
    let called = false;
    await expect(
      validateExtraMounts(
        one('\\\\wsl$\\Ub untu\\home\\troy\\proj'),
        winCtx(async () => {
          called = true;
          return '/home/troy/proj';
        })
      )
    ).rejects.toThrow('Mount 1: "Ub untu" isn\'t a WSL distro name that can be mounted.');
    expect(called).toBe(false);
  });

  it('refuses distro names that do not start alphanumeric', async () => {
    for (const d of ['-x', '.', '..', '_x']) {
      await expect(
        validateExtraMounts(one(`\\\\wsl$\\${d}\\srv\\data`), winCtx(async () => '/srv/data'))
      ).rejects.toThrow(`Mount 1: "${d}" isn't a WSL distro name that can be mounted.`);
    }
  });

  it("refuses Docker Desktop's own distros", async () => {
    for (const d of ['docker-desktop', 'docker-desktop-data', 'Docker-Desktop']) {
      await expect(
        validateExtraMounts(one(`\\\\wsl$\\${d}\\srv\\data`), winCtx(async () => '/srv/data'))
      ).rejects.toThrow("Mount 1: that's Docker Desktop's own WSL distro and can't be mounted.");
    }
  });

  it.each(['/home/troy/proj/x\\y', '/home/troy/proj/x.', '/home/troy/proj/x ', '/home/troy/proj/x\u0001y', '/home/troy/a:b', '/home/troy/a\nb', '/home/troy/a|b'])(
    'refuses an in-distro path Windows would re-parse: %j',
    async (real) => {
      await expect(validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real))).rejects.toThrow(
        "Mount 1: that folder's path has characters Windows can't pass to Docker safely. Rename it or pick another folder."
      );
    }
  );

  it('allows ordinary punctuation in folder names', async () => {
    await expect(
      validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => '/srv/my proj/a.b_c-d@e+f'))
    ).resolves.toHaveLength(1);
  });

  it('refuses folders at, under, or containing a Windows-filesystem mount anywhere', async () => {
    const mounts: WslMount[] = [
      { dir: '/', fstype: 'ext4' },
      { dir: '/c', fstype: '9p' },
      { dir: '/data/win', fstype: 'drvfs' },
      { dir: '/opt/v', fstype: 'v9fs' },
      { dir: '/opt/vf', fstype: 'virtiofs' },
      { dir: '/srv/tmp', fstype: 'tmpfs' }
    ];
    const msg = "Mount 1: that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead.";
    for (const real of ['/c', '/c/Users/x', '/data', '/data/win/sub', '/opt/v', '/opt/vf/a', '/opt']) {
      await expect(validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real, mounts))).rejects.toThrow(msg);
    }
    for (const real of ['/srv/tmp', '/srv/data', '/data2', '/optx']) {
      await expect(
        validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real, mounts))
      ).resolves.toHaveLength(1);
    }
  });

  it('refuses folders at, under, or containing a network-filesystem mount', async () => {
    for (const fstype of ['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4']) {
      const mounts: WslMount[] = [{ dir: '/srv/share', fstype }];
      for (const real of ['/srv/share', '/srv/share/x', '/srv']) {
        await expect(validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => real, mounts))).rejects.toThrow(
          "Mount 1: that folder is on a network share inside WSL and can't be mounted."
        );
      }
      await expect(
        validateExtraMounts(one('\\\\wsl$\\Ubuntu\\x'), winCtx(async () => '/srv/sharex', mounts))
      ).resolves.toHaveLength(1);
    }
  });

  describe('fleet root and userData inside the same distro', () => {
    const wslCtx = (fleetRoot: string, userData: string): MountCtx => ({
      ...winCtx(async (_d, p) => p),
      fleetRoot,
      userData
    });
    const c = () => wslCtx('\\\\wsl$\\Ubuntu\\srv\\fleet', '\\\\wsl.localhost\\ubuntu\\srv\\appdata\\claude-fleet');
    const at = (p: string) => one(`\\\\wsl$\\Ubuntu${p.replace(/\//g, '\\')}`);

    it("refuses another workspace's folder, non-shared children, and ancestors; allows shared and own", async () => {
      await expect(validateExtraMounts(at(`/srv/fleet/${OTHER}`), c())).rejects.toThrow(
        "Mount 1: that folder is another workspace's private folder."
      );
      await expect(validateExtraMounts(at('/srv/fleet/legacy'), c())).rejects.toThrow(
        "Mount 1: that folder is inside the fleet folder; only the shared folder and this workspace's own folder can be mounted."
      );
      await expect(validateExtraMounts(at('/srv'), wslCtx('\\\\wsl$\\Ubuntu\\srv\\fleet', ctx.userData))).rejects.toThrow(
        "Mount 1: that folder contains other workspaces' private folders."
      );
      for (const p of ['/srv/fleet/shared/x', `/srv/fleet/${OWN}`]) {
        await expect(validateExtraMounts(at(p), c())).resolves.toHaveLength(1);
      }
    });

    it('refuses userData, inside it, and its ancestors', async () => {
      for (const p of ['/srv/appdata/claude-fleet', '/srv/appdata/claude-fleet/state', '/srv/appdata']) {
        await expect(validateExtraMounts(at(p), c())).rejects.toThrow(
          "Mount 1: that folder holds the app's private data and can't be mounted."
        );
      }
    });

    it('resolves the fleet root through the distro resolver', async () => {
      const c2: MountCtx = {
        ...ctx,
        platform: 'win32',
        fleetRoot: '\\\\wsl$\\Ubuntu\\link-to-fleet',
        wslRealDir: async (_d, p) => ({ real: p === '/link-to-fleet' ? '/srv/fleet' : p, mounts: [] })
      };
      await expect(validateExtraMounts(at(`/srv/fleet/${OTHER}`), c2)).rejects.toThrow("another workspace's private folder");
    });

    it('ignores a fleet root in a different distro', async () => {
      await expect(
        validateExtraMounts(at(`/srv/fleet/${OTHER}`), wslCtx('\\\\wsl$\\Debian\\srv\\fleet', ctx.userData))
      ).resolves.toHaveLength(1);
    });
  });
});

describe('wslRealDir', () => {
  const MOUNTS = 'C:\\134 /mnt/c 9p rw 0 0\ndrvfs /mnt/my\\040drive drvfs rw 0 0\n';

  it('runs one fixed sh script with the path as a positional argument and parses its output', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args]);
      return `/home/troy/proj\n--MOUNTS--\n${MOUNTS}`;
    };
    expect(await wslRealDir('Ubuntu', '/home/troy/$(rm -rf ~)', exec)).toEqual({
      real: '/home/troy/proj',
      mounts: [
        { dir: '/mnt/c', fstype: '9p' },
        { dir: '/mnt/my drive', fstype: 'drvfs' }
      ]
    });
    expect(calls).toHaveLength(1);
    const [file, args] = calls[0]!;
    expect(file).toBe('wsl.exe');
    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c']);
    expect(args.slice(6)).toEqual(['sh', '/home/troy/$(rm -rf ~)']);
    expect(args[5]).not.toContain('rm -rf');
    expect(args[5]).toContain('realpath -e');
    expect(args[5]).toContain('readlink -f');
    expect(args[5]).toContain('/proc/self/mounts');
  });

  it('strips exactly one trailing newline from the path, keeping spaces and embedded newlines', async () => {
    expect((await wslRealDir('U', '/x', async () => `/home/a \n--MOUNTS--\n`))?.real).toBe('/home/a ');
    expect((await wslRealDir('U', '/x', async () => `/home/a\n--MOUNTS--\nb\n--MOUNTS--\n${MOUNTS}`))?.real).toBe(
      '/home/a\n--MOUNTS--\nb'
    );
  });

  it('returns null on failure or malformed output', async () => {
    expect(await wslRealDir('U', '/x', async () => Promise.reject(new Error('exit 1')))).toBeNull();
    expect(await wslRealDir('U', '/x', async () => '/home/a\n')).toBeNull();
    expect(await wslRealDir('U', '/x', async () => 'relative\n--MOUNTS--\n')).toBeNull();
  });
});
