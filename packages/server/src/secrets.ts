import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Where the one secret of the server (the VAPID private key) lives. */
export interface SecretStore {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

/** A 0600 file. Tests and `BANCADA_VAPID_FILE` use it so nothing touches the real Keychain. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  async read(): Promise<string | null> {
    try {
      return fs.readFileSync(this.file, 'utf8').trim() || null
    } catch {
      return null
    }
  }

  async write(value: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.file, `${value}\n`, { mode: 0o600 })
    fs.chmodSync(this.file, 0o600)
  }
}

function run(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

const NOT_FOUND = 44

/**
 * macOS Keychain, through the `security` CLI: service `Bancada`, account `vapid-<profile>`.
 * The secret is written through `security -i` (commands on stdin) so it never appears in `ps` arguments.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly account: string,
    private readonly service = 'Bancada',
  ) {}

  async read(): Promise<string | null> {
    const result = await run(['find-generic-password', '-s', this.service, '-a', this.account, '-w'])
    if (result.code === NOT_FOUND) return null
    if (result.code !== 0) throw new Error(`security find-generic-password failed (exit ${String(result.code)})`)
    return result.stdout.trim() || null
  }

  async write(value: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Refusing to write a secret with unexpected characters')
    const result = await run(['-i'], `add-generic-password -U -s ${this.service} -a ${this.account} -w ${value}\n`)
    if (result.code !== 0 || /error|fail/i.test(result.stderr)) {
      throw new Error(`security add-generic-password failed (exit ${String(result.code)})`)
    }
  }

  /** Test cleanup. */
  async remove(): Promise<void> {
    await run(['delete-generic-password', '-s', this.service, '-a', this.account])
  }
}
