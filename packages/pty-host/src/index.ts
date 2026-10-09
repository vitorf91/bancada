import { PTY_PROTOCOL_VERSION } from '@bancada/protocol'

/** Protocol version this host speaks. The real host (PTYs, mirror, socket) lands in F0. */
export const hostProtocolVersion: number = PTY_PROTOCOL_VERSION
