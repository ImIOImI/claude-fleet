import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { toDockerMounts, validateExtraMounts, type MountCtx } from './extraMountsHost';

const OWN = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01JBBBBBBBBBBBBBBBBBBBBBBB';
let root: string;
let ctx: MountCtx;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mounts-'));
  const userData = join(root, 'userData');
  const fleetRoot = join(root, 'fleet');
  data = join(root, 'data');
  await mkdir(join(userData, 'state'), { recursive: true });
  await mkdir(join(fleetRoot, OWN), { recursive: true });
  await mkdir(join(fleetRoot, OTHER), { recursive: true });
  await mkdir(data);
  ctx = { ownId: OWN, userData, fleetRoot };
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

  it("rejects another workspace's private folder but allows its own", async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OTHER), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: that folder is another workspace's private folder.");
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OWN), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('allows the fleet shared folder and the fleet root siblings that are not workspace ids', async () => {
    await mkdir(join(ctx.fleetRoot, 'shared'));
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, 'shared'), containerPath: '/mnt/s', readOnly: true }], ctx)
    ).resolves.toHaveLength(1);
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
});

describe('toDockerMounts', () => {
  it('builds bind mounts', async () => {
    expect(await toDockerMounts([{ hostPath: data, containerPath: '/mnt/data', readOnly: true }])).toEqual([
      { Type: 'bind', Source: data, Target: '/mnt/data', ReadOnly: true }
    ]);
  });
  it('fails clearly when a source disappeared', async () => {
    const gone = join(root, 'gone');
    await expect(toDockerMounts([{ hostPath: gone, containerPath: '/mnt/g', readOnly: false }])).rejects.toThrow(
      `extra mount ${gone} no longer exists`
    );
  });
  it('returns [] for none', async () => {
    expect(await toDockerMounts(undefined)).toEqual([]);
  });
});
