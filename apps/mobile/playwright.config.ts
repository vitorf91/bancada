import { defineConfig, devices } from '@playwright/test'

// The spec starts the real server (bundle under Electron's node mode) with a real pty-host on a /tmp data dir, and a
// TLS proxy in front of it that plays the part of `tailscale serve`. Chromium with an Android profile: the target is
// Chrome on a Galaxy S25+, whose screen is 384x832 CSS px (1080x2340 at a device scale factor of 2.8125).
const port = Number(process.env.BANCADA_E2E_PORT ?? 21000 + Math.floor(Math.random() * 2000))
process.env.BANCADA_E2E_PORT = String(port)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Galaxy S24'],
    viewport: { width: 384, height: 832 },
    deviceScaleFactor: 2.8125,
    // The headless shell has no notifications at all (always "denied"); the full Chromium build in new headless mode
    // does, and the grant stands in for the user tapping "Permitir".
    permissions: ['notifications'],
    baseURL: `https://localhost:${port + 1}`,
    ignoreHTTPSErrors: true,
    // The proxy's certificate is self-signed. ignoreHTTPSErrors covers page loads, but Chromium still refuses to
    // register a service worker over it; this flag is what lets the worker (push, offline shell) run in the test.
    launchOptions: { args: ['--ignore-certificate-errors'] },
  },
  projects: [{ name: 'android-chrome', use: { browserName: 'chromium', channel: 'chromium' } }],
})
