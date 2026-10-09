import { PTY_PROTOCOL_VERSION } from '@bancada/protocol'
import { expect, it } from 'vitest'
import { replayProtocolVersion } from './index.js'

it('replays against the protocol version from @bancada/protocol', () => {
  expect(replayProtocolVersion).toBe(PTY_PROTOCOL_VERSION)
})
