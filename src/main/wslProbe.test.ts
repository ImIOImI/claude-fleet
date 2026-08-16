import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { decodeWsl, parseDistroList, listWslDistros, probeWslDistro, type ProbeDeps } from './wslProbe.js';

/** Encode a string the way wsl.exe emits it (UTF-16LE). */
const u16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

const VERBOSE_LIST = [
  '  NAME            STATE           VERSION',
  '* Ubuntu          Running         2',
  '  Debian          Stopped         2',
  '  docker-desktop  Running         2',
  ''
].join('\r\n');

describe('decodeWsl', () => {
  it('decodes UTF-16LE and strips CR', () => {
    expect(decodeWsl(u16('Ubuntu\r\nDebian\r\n'))).toBe('Ubuntu\nDebian\n');
  });
  it('keeps spaces (column parsing depends on them) and strips NULs', () => {
    expect(decodeWsl(u16('* Ubuntu  2'))).toBe('* Ubuntu  2');
  });
});

describe('parseDistroList', () => {
  it('extracts names, default, and filters utility distros', () => {
    expect(parseDistroList(decodeWsl(u16(VERBOSE_LIST)))).toEqual({
      distros: ['Ubuntu', 'Debian'],
      defaultDistro: 'Ubuntu'
    });
  });
  it('returns empty on garbage', () => {
    expect(parseDistroList('wsl: not installed')).toEqual({ distros: [], defaultDistro: null });
  });
});

describe('listWslDistros', () => {
  it('returns empty when wsl.exe fails', async () => {
    const deps: ProbeDeps = {
      execBuf: async () => { throw new Error('ENOENT'); },
      exec: async () => { throw new Error('ENOENT'); }
    };
    expect(await listWslDistros(deps)).toEqual({ distros: [], defaultDistro: null });
  });
});

describe('probeWslDistro', () => {
  // Fake exec keyed on the in-distro shell command (last arg).
  const deps = (answers: Record<string, string>): ProbeDeps => ({
    execBuf: async () => ({ stdout: Buffer.alloc(0) }),
    exec: async (_file, args) => {
      const script = args[args.length - 1];
      for (const [needle, out] of Object.entries(answers)) {
        if (script.includes(needle)) return { stdout: out };
      }
      throw new Error(`no fake for: ${script}`);
    }
  });

  it('collects loginShell/home/shells/interop and resolves claude', async () => {
    const p = await probeWslDistro('Ubuntu', deps({
      'getent passwd': '/usr/bin/zsh\n',
      'echo "$HOME"': '/home/troy\n',
      '/etc/shells': '/bin/bash\n/usr/bin/zsh\n',
      WSLInterop: 'yes\n',
      'command -v claude': '/home/troy/.local/bin/claude\n'
    }));
    expect(p.loginShell).toBe('/usr/bin/zsh');
    expect(p.home).toBe('/home/troy');
    expect(p.shells).toEqual(['/bin/bash', '/usr/bin/zsh']);
    expect(p.interopEnabled).toBe(true);
    expect(p.claudePath).toBe('/home/troy/.local/bin/claude');
  });

  // #259: the old check was `test -f …/WSLInterop`, which false-negatived on
  // two real configurations — a distro that registers the handler under the
  // newer `WSLInterop-late` name, and one where the entry exists but is
  // switched off.
  //
  // These run the probe's ACTUAL shell one-liner through a real `sh`, with the
  // absolute `/proc/sys/fs/binfmt_misc` prefix rewritten to a temp dir holding
  // fake binfmt entries. A fake that just returns 'yes' would only be testing
  // itself — reverting the probe to the legacy single-name check has to make
  // these fail, and with a real interpreter it does.

  describe('interop detection (#259)', () => {
    const BINFMT = '/proc/sys/fs/binfmt_misc';

    /** Distro whose binfmt dir holds `entries` (name → first line of the file). */
    const interopDeps = (entries: Record<string, string>): ProbeDeps => {
      const dir = mkdtempSync(join(tmpdir(), 'binfmt-'));
      for (const [name, body] of Object.entries(entries)) {
        writeFileSync(join(dir, name), `${body}\ninterpreter /init\n`);
      }
      return {
        execBuf: async () => ({ stdout: Buffer.alloc(0) }),
        exec: async (_file, args) => {
          const script = args[args.length - 1];
          if (script.includes('getent passwd')) return { stdout: '/bin/bash\n' };
          if (script.includes('echo "$HOME"')) return { stdout: '/home/x\n' };
          if (script.includes('/etc/shells')) return { stdout: '/bin/bash\n' };
          if (script.includes('binfmt_misc')) {
            // Real execution of the real script, rooted at the fake dir.
            const rooted = script.split(BINFMT).join(dir);
            return { stdout: execFileSync('sh', ['-c', rooted], { encoding: 'utf8' }) };
          }
          return { stdout: '' }; // claude lookups → not found
        }
      };
    };

    it('detects interop registered under the legacy WSLInterop name', async () => {
      const p = await probeWslDistro('Ubuntu', interopDeps({ WSLInterop: 'enabled' }));
      expect(p.interopEnabled).toBe(true);
    });

    it('detects interop registered as WSLInterop-late (newer WSL)', async () => {
      const p = await probeWslDistro('Ubuntu', interopDeps({ 'WSLInterop-late': 'enabled' }));
      expect(p.interopEnabled).toBe(true);
    });

    it('reports false when a registration exists but is disabled', async () => {
      const p = await probeWslDistro('Ubuntu', interopDeps({ WSLInterop: 'disabled' }));
      expect(p.interopEnabled).toBe(false);
    });

    it('reports false when the late entry exists but is disabled', async () => {
      const p = await probeWslDistro('Ubuntu', interopDeps({ 'WSLInterop-late': 'disabled' }));
      expect(p.interopEnabled).toBe(false);
    });

    it('reports true when one name is disabled and the other is enabled', async () => {
      const p = await probeWslDistro(
        'Ubuntu',
        interopDeps({ WSLInterop: 'disabled', 'WSLInterop-late': 'enabled' })
      );
      expect(p.interopEnabled).toBe(true);
    });

    it('reports false when no registration exists at all', async () => {
      const p = await probeWslDistro('Ubuntu', interopDeps({}));
      expect(p.interopEnabled).toBe(false);
    });
  });

  it('claudePath null when not found; interop false on probe failure', async () => {
    const p = await probeWslDistro('Ubuntu', deps({
      'getent passwd': '/bin/bash\n',
      'echo "$HOME"': '/home/x\n',
      '/etc/shells': '/bin/bash\n',
      WSLInterop: '',            // empty stdout ⇒ not detected
      'command -v claude': ''    // not found
    }));
    expect(p.claudePath).toBeNull();
    expect(p.interopEnabled).toBe(false);
  });

  it('throws when $HOME cannot be determined', async () => {
    await expect(
      probeWslDistro('Ubuntu', deps({
        'getent passwd': '/bin/bash\n',
        'echo "$HOME"': '',
        '/etc/shells': '/bin/bash\n',
        WSLInterop: '',
        'command -v claude': ''
      }))
    ).rejects.toThrow(/HOME/);
  });
});
