import { PTY_PROTOCOL_VERSION } from '@bancada/protocol'

/** pty-host protocol version this server expects as a client. */
export const expectedPtyProtocol: number = PTY_PROTOCOL_VERSION

export { BellDebouncer, BellDetector, BellWatcher } from './bell.js'
export { ensureHostConnector } from './connector.js'
export { socketIsAlive } from './control.js'
export { controlRequest } from './control-client.js'
export type { HostConnector } from './host-link.js'
export { COOKIE_NAME } from './http-util.js'
export { resolveControlSocketPath } from './paths.js'
export { bellPayload, textPayload, vapidFromPrivate } from './push.js'
export { FileSecretStore, KeychainSecretStore } from './secrets.js'
export { DEFAULT_PORT, type RunningServer, type ServerOptions, startServer } from './server.js'
