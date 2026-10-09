import { resolveDataDir, resolveSocketPath } from '@bancada/protocol/paths'
import { expect, it } from 'vitest'
import * as dataDir from './data-dir.js'

it('re-exports the shared path rules from @bancada/protocol/paths', () => {
  expect(dataDir.resolveDataDir).toBe(resolveDataDir)
  expect(dataDir.resolveSocketPath).toBe(resolveSocketPath)
})
