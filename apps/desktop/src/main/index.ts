import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HostEvent } from '@bancada/protocol'
import { app, BrowserWindow, ipcMain, MessageChannelMain, shell, type WebContents } from 'electron'
import { type BenchConfig, IPC } from '../shared/api.js'
import { loadBoard, saveBoard } from './boards.js'
import { resolveDataDir } from './data-dir.js'
import { discover } from './discover.js'
import { connectToPtyHost } from './host.js'
import { asString, parseAttachOptions, parseSignal, parseSize, parseSpawnRequest, parseWrite } from './ipc-validate.js'
import { hubErrorFrom, type SenderLike, TerminalHub } from './terminal-hub.js'

// The data dir must be set before `ready`: the single-instance lock, Chromium data and the pty-host socket
// all live per profile (docs/ARCHITECTURE.md, "Data dir and profiles").
const dataDir = resolveDataDir({ env: process.env, homeDir: homedir() })
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setPath('userData', dataDir)

const BENCH_WINDOW = { width: 1512, height: 982 }

let mainWindow: BrowserWindow | null = null

const senders = new WeakMap<WebContents, SenderLike>()
function senderOf(contents: WebContents): SenderLike {
  let sender = senders.get(contents)
  if (!sender) {
    sender = {
      id: contents.id,
      isDestroyed: () => contents.isDestroyed(),
      deliverPort: (viewId, port) => contents.postMessage(IPC.terminalPort, viewId, [port as Electron.MessagePortMain]),
      onDestroyed: (listener) => contents.once('destroyed', listener),
    }
    senders.set(contents, sender)
  }
  return sender
}

/** The renderer's terminals. All of them share the one connection to the pty-host. */
const terminals = new TerminalHub({
  connect: () => connectToPtyHost(dataDir),
  createChannel: () => {
    const { port1, port2 } = new MessageChannelMain()
    return { sender: port1, receiver: port2 }
  },
  broadcast: (event: HostEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.terminalEvent, event)
  },
})

function benchConfig(): BenchConfig | null {
  const raw = process.env.BANCADA_BENCH_CONFIG
  if (!raw) return null
  return JSON.parse(raw) as BenchConfig
}

/** Only the app's own window may call the IPC handlers. */
function fromMainWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): WebContents {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender')
  return event.sender
}

/** The renderer gets the message only; a code the page needs travels as `bancada:<code>:<message>`. */
function handle<T>(
  channel: string,
  run: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    fromMainWindow(event)
    try {
      return await run(event, ...args)
    } catch (error) {
      throw hubErrorFrom(error)
    }
  })
}

function registerIpc(): void {
  handle(IPC.discoverWorkspace, () => discover({ env: process.env, homeDir: homedir() }))
  handle(IPC.loadBoard, (_event, id) => {
    if (typeof id !== 'string') throw new Error('Invalid board id')
    return loadBoard(dataDir, id)
  })
  handle(IPC.saveBoard, async (_event, id, board) => {
    if (typeof id !== 'string') throw new Error('Invalid board id')
    await saveBoard(dataDir, id, board)
  })

  handle(IPC.terminalSpawn, (_event, request) => terminals.spawn(parseSpawnRequest(request)))
  handle(IPC.terminalList, () => terminals.list())
  handle(IPC.terminalAttach, (event, sessionId, viewId, options) =>
    terminals.attach(
      senderOf(event.sender),
      asString(sessionId, 'session id'),
      asString(viewId, 'view id'),
      parseAttachOptions(options).scrollback,
    ),
  )
  handle(IPC.terminalDetach, (_event, viewId) => terminals.detach(asString(viewId, 'view id')))
  handle(IPC.terminalKill, (_event, sessionId, signal) =>
    terminals.kill(asString(sessionId, 'session id'), parseSignal(signal)),
  )
  // Keystrokes and resizes are fire-and-forget (ipcRenderer.send): no reply to wait for on the latency path.
  ipcMain.on(IPC.terminalWrite, (event, sessionId: unknown, data: unknown) => {
    fromMainWindow(event)
    terminals.write(asString(sessionId, 'session id'), parseWrite(data))
  })
  ipcMain.on(IPC.terminalResize, (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    fromMainWindow(event)
    const size = parseSize(cols, rows)
    terminals.resize(asString(sessionId, 'session id'), size.cols, size.rows)
  })
  handle(IPC.benchConfig, () => benchConfig())
}

function createWindow(): void {
  const bench = benchConfig() !== null
  const win = new BrowserWindow({
    title: 'Bancada',
    ...(bench ? { ...BENCH_WINDOW, useContentSize: true, x: 0, y: 0 } : { width: 1280, height: 800 }),
    webPreferences: {
      // Sandboxed renderer with no Node: the preload is the only bridge (see src/preload/index.ts).
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The bench measures frames: a window that is not frontmost must not be throttled.
      backgroundThrottling: !bench,
      additionalArguments: process.env.BANCADA_TEST_HOOKS === '1' ? ['--bancada-test-hooks'] : [],
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

  // Quitting closes this client's connection only: the sessions belong to the pty-host and keep running.
  app.on('before-quit', () => terminals.dispose())

  registerIpc()
  void app.whenReady().then(() => {
    // Start (or find) the host while the window loads; a failure shows up when a panel asks for a session.
    terminals.ready().catch((error: unknown) => console.error('pty-host unavailable', error))
    createWindow()
  })
}
