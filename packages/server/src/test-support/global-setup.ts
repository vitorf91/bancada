import { execFileSync } from 'node:child_process'

/** Test hosts live in `/tmp/bancada-s-*` data dirs. After the whole run none of them may still be running. */
function strayHosts(): string[] {
  try {
    const out = execFileSync('pgrep', ['-fl', 'bancada-s-.*pty-host'], { encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

export default function setup(): () => void {
  return () => {
    const stray = strayHosts()
    if (stray.length > 0) {
      for (const line of stray) {
        const pid = Number.parseInt(line, 10)
        if (Number.isInteger(pid)) process.kill(pid, 'SIGKILL')
      }
      throw new Error(`pty-host processes left running after the suite:\n${stray.join('\n')}`)
    }
  }
}
