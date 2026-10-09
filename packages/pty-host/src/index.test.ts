import { PTY_PROTOCOL_VERSION } from '@bancada/protocol'
import { expect, it } from 'vitest'
import { hostProtocolVersion } from './index.js'

it('speaks the protocol version from @bancada/protocol', () => {
  expect(hostProtocolVersion).toBe(PTY_PROTOCOL_VERSION)
})
