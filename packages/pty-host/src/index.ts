// Pure-JS surface of the pty-host package: the client, the frame codec and the runtime launcher.
// The host itself (src/host) imports node-pty and is only ever loaded from the bundle.
export { type ConnectOptions, PtyClient, PtyHostError } from './client.js'
export {
  decodeControl,
  decodeData,
  encodeControl,
  encodeData,
  encodeFrame,
  type Frame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
} from './frame.js'
export {
  connectToHost,
  type EnsureHostOptions,
  ensureHost,
  HOST_ENTRY_FILE,
  type LaunchedHost,
  type LaunchHostOptions,
  launchHost,
  type PreparedRuntime,
  type PrepareRuntimeOptions,
  prepareRuntime,
} from './runtime.js'
