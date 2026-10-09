/// <reference types="vite/client" />

import type { BancadaApi } from '../../shared/api.js'

declare global {
  interface Window {
    /** Exposed by the preload (src/preload/index.ts). */
    bancada: BancadaApi
  }
}
