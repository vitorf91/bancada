import { execFile } from 'node:child_process'
import { type OrcaRepo, parseOrcaRepoList } from '../orca.js'

/** Run `orca repo list`. Resolves null when the orca CLI is not installed. */
export function readOrcaRepos(): Promise<OrcaRepo[] | null> {
  return new Promise((resolve, reject) => {
    execFile('orca', ['repo', 'list'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve(null)
        else reject(new Error(`orca repo list failed: ${stderr.trim() || error.message}`))
        return
      }
      resolve(parseOrcaRepoList(stdout))
    })
  })
}
