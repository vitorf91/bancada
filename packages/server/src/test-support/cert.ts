import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** A throwaway self-signed certificate (openssl ships with macOS), for a fake push endpoint and the e2e TLS proxy. */
export function selfSignedCert(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join('/tmp', 'bancada-cert-'))
  try {
    const keyFile = path.join(dir, 'key.pem')
    const certFile = path.join(dir, 'cert.pem')
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile], { stdio: 'pipe' })
    execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost'],
      { stdio: 'pipe' },
    )
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
