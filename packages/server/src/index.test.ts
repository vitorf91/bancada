import { PTY_PROTOCOL_VERSION } from '@bancada/protocol'
import { expect, it } from 'vitest'
import { expectedPtyProtocol } from './index.js'

it('expects the protocol version from @bancada/protocol', () => {
  expect(expectedPtyProtocol).toBe(PTY_PROTOCOL_VERSION)
})
