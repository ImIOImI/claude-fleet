/** Settles when `work` does or after `ms`, whichever is first; never rejects. */
export function withinMs(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
  return Promise.race([work.then(() => 'done' as const, () => 'done' as const), timeout]).finally(() => clearTimeout(timer));
}
