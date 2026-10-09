import { contextBridge, ipcRenderer } from 'electron'
import { type BancadaApi, type BoardFile, IPC } from '../shared/api.js'

// The only bridge between the sandboxed renderer and the main process. Each method maps to one IPC channel;
// the renderer never receives `ipcRenderer` itself.
const api: BancadaApi = {
  discoverWorkspace: () => ipcRenderer.invoke(IPC.discoverWorkspace),
  loadBoard: (id: string) => ipcRenderer.invoke(IPC.loadBoard, id),
  saveBoard: (id: string, board: BoardFile) => ipcRenderer.invoke(IPC.saveBoard, id, board),
}

contextBridge.exposeInMainWorld('bancada', api)
