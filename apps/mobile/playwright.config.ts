import { defineConfig, devices } from '@playwright/test'

// The spec starts the real server (bundle under Electron's node mode) with a real pty-host on a /tmp data dir, and a
// TLS proxy in front of it that plays the part of `tailscale serve`. WebKit with an iPhone profile (390x844).
const port = Number(process.env.BANCADA_E2E_PORT ?? 21000 + Math.floor(Math.random() * 2000))
process.env.BANCADA_E2E_PORT = String(port)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['iPhone 14'],
    // The full 390x844 screen of the mockup (the device profile's own viewport leaves room for Safari's toolbars).
    viewport: { width: 390, height: 844 },
    baseURL: `https://localhost:${port + 1}`,
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'iphone-webkit', use: { browserName: 'webkit' } }],
})
