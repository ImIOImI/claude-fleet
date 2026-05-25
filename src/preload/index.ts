import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Mirrored from src/main/sessions.ts. Kept here as a type-only declaration so
// the preload doesn't reach into main-process code (and so the renderer can
// import it via FleetApi without a separate path mapping).
export interface SessionEntry {
  id: string;
  name: string;
  createdAt: number;
}
export interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  nextNum: number;
  activeId?: string;
}

const api = {
  app: {
    mockMode: (): Promise<boolean> => ipcRenderer.invoke('app:mockMode')
  },
  workspace: {
    backendReady: (): Promise<boolean> => ipcRenderer.invoke('workspace:ping'),
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (input: unknown) => ipcRenderer.invoke('workspace:create', input),
    start: (name: string) => ipcRenderer.invoke('workspace:start', name),
    getManifest: (name: string) => ipcRenderer.invoke('workspace:getManifest', name),
    stop: (id: string) => ipcRenderer.invoke('workspace:stop', id),
    pause: (id: string) => ipcRenderer.invoke('workspace:pause', id),
    remove: (id: string, opts?: { deleteState?: boolean }) =>
      ipcRenderer.invoke('workspace:remove', id, opts),
    ensureImage: async (onProgress: (p: { message: string }) => void): Promise<void> => {
      const channelId = globalThis.crypto.randomUUID();
      const channel = `workspace:ensureImage:progress:${channelId}`;
      const handler = (_e: IpcRendererEvent, p: { message: string }) => onProgress(p);
      ipcRenderer.on(channel, handler);
      try {
        await ipcRenderer.invoke('workspace:ensureImage', channelId);
      } finally {
        ipcRenderer.removeListener(channel, handler);
      }
    }
  },
  images: {
    list: () => ipcRenderer.invoke('images:list'),
    remove: (ref: string) => ipcRenderer.invoke('images:remove', ref)
  },
  sessions: {
    read: (workspaceName: string): Promise<SessionInventory> =>
      ipcRenderer.invoke('sessions:read', workspaceName),
    write: (workspaceName: string, inventory: SessionInventory): Promise<void> =>
      ipcRenderer.invoke('sessions:write', workspaceName, inventory)
  },
  fs: {
    isDirectory: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:isDirectory', path),
    mkdirp: (path: string): Promise<void> => ipcRenderer.invoke('fs:mkdirp', path)
  },
  dialog: {
    pickDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', defaultPath)
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read')
  },
  menu: {
    showTerminalContextMenu: (
      opts: { hasSelection: boolean }
    ): Promise<'copy' | 'paste' | 'selectAll' | null> =>
      ipcRenderer.invoke('menu:showTerminalContextMenu', opts)
  },
  vault: {
    available: (): Promise<boolean> => ipcRenderer.invoke('vault:available'),
    list: (): Promise<string[]> => ipcRenderer.invoke('vault:list'),
    get: (name: string) => ipcRenderer.invoke('vault:get', name),
    set: (p: { name: string; apiKey: string }) => ipcRenderer.invoke('vault:set', p),
    delete: (name: string) => ipcRenderer.invoke('vault:delete', name)
  },
  pty: {
    attach: (
      containerId: string,
      brokerSessionId: string,
      cols: number,
      rows: number
    ): Promise<string> =>
      ipcRenderer.invoke('pty:attach', containerId, brokerSessionId, cols, rows),
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
