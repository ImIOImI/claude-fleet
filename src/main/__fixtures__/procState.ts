import { readFileSync } from 'node:fs';

/** 'zombie' (exited, unreaped) is only detectable on Linux. */
export function procState(pid: number): 'gone' | 'zombie' | 'alive' {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z') ? 'zombie' : 'alive';
    } catch {
      return 'gone';
    }
  }
  try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; }
}

export async function waitForState(pid: number, want: ReturnType<typeof procState>, ms = 3_000): Promise<ReturnType<typeof procState>> {
  const end = Date.now() + ms;
  let s = procState(pid);
  while (s !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    s = procState(pid);
  }
  return s;
}
