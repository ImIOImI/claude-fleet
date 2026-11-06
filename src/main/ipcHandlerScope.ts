// The ipcMain handlers a service registers, so they can be removed and the
// service registered again on another store (the inbox's switch back, D53).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handle = (channel: string, listener: (...args: any[]) => unknown) => void;

export interface HandlerHost {
  handle: Handle;
  removeHandler(channel: string): void;
}

export interface HandlerScope<T> {
  result: T;
  channels: readonly string[];
  /** Removes every handler `fn` registered. */
  dispose(): void;
}

/** Runs `fn` (synchronous) and records the channels it registers on `ipc`. */
export function recordHandlers<T>(ipc: HandlerHost, fn: () => T): HandlerScope<T> {
  const channels: string[] = [];
  const own = Object.prototype.hasOwnProperty.call(ipc, 'handle');
  const prev = ipc.handle;
  ipc.handle = (channel, listener) => {
    channels.push(channel);
    prev.call(ipc, channel, listener);
  };
  let result: T;
  try {
    result = fn();
  } finally {
    if (own) ipc.handle = prev;
    else delete (ipc as { handle?: Handle }).handle;
  }
  return {
    result,
    channels,
    dispose: () => { for (const c of channels.splice(0)) ipc.removeHandler(c); },
  };
}
