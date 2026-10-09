import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '../shared/api.js'
import { loadBoard, saveBoard } from './boards.js'
import { resolveDataDir } from './data-dir.js'
import { discover } from './discover.js'

// The data dir must be set before `ready`: the single-instance lock, Chromium data and the pty-host socket
// all live per profile (docs/ARCHITECTURE.md, "Data dir and profiles").
const dataDir = resolveDataDir({ env: process.env, homeDir: homedir() })
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setPath('userData', dataDir)

let mainWindow: BrowserWindow | null = null

/** Only the app's own window may call the IPC handlers. */
function fromMainWindow(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender')
}

function registerIpc(): void {
  ipcMain.handle(IPC.discoverWorkspace, async (event) => {
    fromMainWindow(event)
    return discover({ env: process.env, homeDir: homedir() })
  })
  ipcMain.handle(IPC.loadBoard, async (event, id: unknown) => {
    fromMainWindow(event)
    if (typeof id !== 'string') throw new Error('Invalid board id')
    return loadBoard(dataDir, id)
  })
  ipcMain.handle(IPC.saveBoard, async (event, id: unknown, board: unknown) => {
    fromMainWindow(event)
    if (typeof id !== 'string') throw new Error('Invalid board id')
    await saveBoard(dataDir, id, board)
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Bancada',
    width: 1280,
    height: 800,
    webPreferences: {
      // Sandboxed renderer with no Node: the preload is the only bridge (see src/preload/index.ts).
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // The app never navigates away or opens windows; links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  registerIpc()
  void app.whenReady().then(createWindow)
}
