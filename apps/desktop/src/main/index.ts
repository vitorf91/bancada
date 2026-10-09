import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { resolveDataDir } from './data-dir.js'

// The data dir must be set before `ready`: the single-instance lock, Chromium data and the pty-host socket
// all live per profile (docs/ARCHITECTURE.md, "Data dir and profiles").
const dataDir = resolveDataDir({ env: process.env, homeDir: homedir() })
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setPath('userData', dataDir)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Bancada',
    width: 1280,
    height: 800,
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

  void app.whenReady().then(createWindow)
}
