import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const api = {
  docker: {
    ping: (): Promise<boolean> => ipcRenderer.invoke('docker:ping'),
    list: () => ipcRenderer.invoke('docker:list'),
    create: (spec: unknown) => ipcRenderer.invoke('docker:create', spec),
    stop: (id: string) => ipcRenderer.invoke('docker:stop', id),
    remove: (id: string) => ipcRenderer.invoke('docker:remove', id)
  },
  vault: {
    list: (): Promise<string[]> => ipcRenderer.invoke('vault:list'),
    get: (name: string) => ipcRenderer.invoke('vault:get', name),
    set: (p: { name: string; apiKey: string }) => ipcRenderer.invoke('vault:set', p),
    delete: (name: string) => ipcRenderer.invoke('vault:delete', name)
  },
  pty: {
    attach: (containerId: string, cols: number, rows: number): Promise<string> =>
      ipcRenderer.invoke('pty:attach', containerId, cols, rows),
    input: (sessionId: string, data: string) =>
      ipcRenderer.invoke('pty:input', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    detach: (sessionId: string) => ipcRenderer.invoke('pty:detach', sessionId),
    onData: (sessionId: string, cb: (chunk: Uint8Array) => void) => {
      const channel = `pty:data:${sessionId}`;
      const handler = (_e: IpcRendererEvent, chunk: Buffer) => cb(new Uint8Array(chunk));
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onEnd: (sessionId: string, cb: () => void) => {
      const channel = `pty:end:${sessionId}`;
      const handler = () => cb();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  }
};

contextBridge.exposeInMainWorld('api', api);

export type FleetApi = typeof api;
