import type { HostEvent } from '@bancada/protocol'
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { type BancadaApi, type BoardFile, IPC, PORT_WINDOW_CHANNEL } from '../shared/api.js'

// The preload is compiled without the DOM lib; this is the only part of `window` it uses.
declare const window: { postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void }

// The only bridge between the sandboxed renderer and the main process. Each method maps to one IPC channel;
// the renderer never receives `ipcRenderer` itself.

// A MessagePort cannot cross contextBridge: main transfers it to this world, which posts it to the page.
ipcRenderer.on(IPC.terminalPort, (event: IpcRendererEvent, viewId: string) => {
  window.postMessage({ type: PORT_WINDOW_CHANNEL, viewId }, '*', event.ports)
})

const api: BancadaApi = {
  discoverWorkspace: () => ipcRenderer.invoke(IPC.discoverWorkspace),
  loadBoard: (id: string) => ipcRenderer.invoke(IPC.loadBoard, id),
  saveBoard: (id: string, board: BoardFile) => ipcRenderer.invoke(IPC.saveBoard, id, board),

  spawn: (request) => ipcRenderer.invoke(IPC.terminalSpawn, request),
  list: () => ipcRenderer.invoke(IPC.terminalList),
  attach: (sessionId, viewId, options) => ipcRenderer.invoke(IPC.terminalAttach, sessionId, viewId, options),
  // Keystrokes are on the latency path: fire and forget.
  write: (sessionId, data) => ipcRenderer.send(IPC.terminalWrite, sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.terminalResize, sessionId, cols, rows),
  detach: (viewId) => ipcRenderer.invoke(IPC.terminalDetach, viewId),
  kill: (sessionId, signal) => ipcRenderer.invoke(IPC.terminalKill, sessionId, signal),
  onSessionEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, hostEvent: HostEvent): void => listener(hostEvent)
    ipcRenderer.on(IPC.terminalEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.terminalEvent, handler)
    }
  },

  testMode: process.argv.includes('--bancada-test-hooks'),
  benchConfig: () => ipcRenderer.invoke(IPC.benchConfig),
}

contextBridge.exposeInMainWorld('bancada', api)
