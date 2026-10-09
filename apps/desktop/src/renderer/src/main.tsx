import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import 'dockview-react/dist/styles/dockview.css'
import '@bancada/ui/terminal.css'
import './styles/tokens.css'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { BenchApp } from './bench/BenchApp.js'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')
const root = createRoot(container)

// A bench run (BANCADA_BENCH_CONFIG) shows the terminal grid of proof (a) instead of the app. No StrictMode there:
// the bench spawns real sessions and must not mount twice.
window.bancada
  .benchConfig()
  .then((bench) => {
    if (bench) {
      root.render(<BenchApp config={bench} />)
      return
    }
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    console.error('Starting the renderer failed', error)
  })
