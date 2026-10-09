// Renders public/icon.svg to the PNG icons with Playwright's WebKit. The PNGs are committed; run this only when the
// SVG changes (it is not part of `build`, so CI needs no browser).
//   PLAYWRIGHT_BROWSERS_PATH=... pnpm --filter @bancada/mobile icons
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = fs.readFileSync(path.join(root, 'public/icon.svg'), 'utf8')
const outDir = path.join(root, 'public/icons')
fs.mkdirSync(outDir, { recursive: true })

// `inset` shrinks the artwork inside the canvas: maskable icons keep their content in the central 80%.
const targets = [
  { file: 'icons/icon-192.png', size: 192, inset: 0 },
  { file: 'icons/icon-512.png', size: 512, inset: 0 },
  { file: 'icons/icon-maskable-512.png', size: 512, inset: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0 },
]

const browser = await webkit.launch()
try {
  const page = await browser.newPage()
  for (const { file, size, inset } of targets) {
    await page.setViewportSize({ width: size, height: size })
    const pad = Math.round(size * inset)
    await page.setContent(
      `<body style="margin:0;background:#0a0b0d"><div style="padding:${pad}px;width:${size}px;height:${size}px;box-sizing:border-box">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
    )
    await page.screenshot({ path: path.join(root, 'public', file), omitBackground: false })
    console.log(`wrote public/${file}`)
  }
} finally {
  await browser.close()
}
