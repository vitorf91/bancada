import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { selfSignedCert } from './cert.js'

export interface ReceivedPush {
  /** Decrypted JSON payload. */
  payload: { title: string; body: string; url: string; tag?: string }
  jwt: { header: Record<string, unknown>; claims: { aud: string; exp: number; sub: string } }
  vapidPublicKey: string
  receivedAt: number
  headers: Record<string, string | string[] | undefined>
}

export interface FakePushEndpoint {
  /** Subscription JSON the phone would send, pointing at this endpoint. */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  agent: https.Agent
  received: ReceivedPush[]
  /** Respond with this status instead of 201 (e.g. 410 for an expired subscription). */
  respondWith: number
  waitFor(count: number, timeoutMs?: number): Promise<ReceivedPush[]>
  close(): Promise<void>
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url')
}

/** RFC 8291 (aes128gcm) decryption on the user-agent side, written independently of the `web-push` library. */
export function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const idLen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idLen)
  const ciphertext = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const secret = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const prk = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // Strip the padding: the last record ends with 0x02 after optional zeros.
  let end = padded.length
  while (end > 0 && padded[end - 1] === 0) end--
  if (padded[end - 1] !== 2) throw new Error('missing record delimiter')
  return padded.subarray(0, end - 1)
}

function verifyVapid(authorization: string, expectedAudience: string): { jwt: ReceivedPush['jwt']; publicKey: string } {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization)
  if (!match) throw new Error(`unexpected Authorization header shape`)
  const [, token, key] = match as unknown as [string, string, string]
  const [h, c, s] = token.split('.') as [string, string, string]
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as ReceivedPush['jwt']['claims']
  if (header.alg !== 'ES256' || header.typ !== 'JWT') throw new Error('bad JWT header')
  if (claims.aud !== expectedAudience) throw new Error(`aud ${claims.aud} is not ${expectedAudience}`)
  const nowS = Date.now() / 1000
  if (!(claims.exp > nowS && claims.exp <= nowS + 24 * 3600)) throw new Error('exp must be within 24 h')
  if (!/^(mailto:|https:\/\/)/.test(claims.sub)) throw new Error('sub must be mailto: or https:')
  const point = Buffer.from(key, 'base64url')
  if (point.length !== 65 || point[0] !== 4) throw new Error('k is not an uncompressed P-256 point')
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
    format: 'jwk',
  })
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${c}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  )
  if (!ok) throw new Error('JWT signature does not verify against k')
  return { jwt: { header, claims }, publicKey: key }
}

/**
 * A push service on https://127.0.0.1:<port> that behaves like FCM/APNs/Mozilla for the parts the server controls: it
 * verifies the VAPID JWT (ES256 signature, audience, expiry, subject, `k`), then decrypts the aes128gcm payload with
 * the subscription's keys. A request that fails any check is answered 400 and never recorded.
 */
export async function startFakePushEndpoint(): Promise<FakePushEndpoint> {
  const uaEcdh = createECDH('prime256v1')
  uaEcdh.generateKeys()
  const uaPrivate = uaEcdh.getPrivateKey()
  const uaPublic = uaEcdh.getPublicKey()
  const authSecret = randomBytes(16)
  const { key, cert } = selfSignedCert()
  const received: ReceivedPush[] = []
  const waiters: { count: number; resolve: (r: ReceivedPush[]) => void }[] = []
  const state = { respondWith: 201 }
  let origin = ''

  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        if (req.method !== 'POST') throw new Error('method')
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('content-encoding')
        const { jwt, publicKey } = verifyVapid(String(req.headers.authorization), origin)
        const plain = decryptAes128gcm(Buffer.concat(chunks), uaPrivate, uaPublic, authSecret)
        received.push({
          payload: JSON.parse(plain.toString('utf8')) as ReceivedPush['payload'],
          jwt,
          vapidPublicKey: publicKey,
          receivedAt: Date.now(),
          headers: req.headers,
        })
        res.writeHead(state.respondWith).end()
        for (const w of waiters.filter((x) => received.length >= x.count)) w.resolve([...received])
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(String(error))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  origin = `https://127.0.0.1:${port}`
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false })
  return {
    subscription: {
      endpoint: `${origin}/push/${b64u(randomBytes(12))}`,
      keys: { p256dh: b64u(uaPublic), auth: b64u(authSecret) },
    },
    agent,
    received,
    get respondWith() {
      return state.respondWith
    },
    set respondWith(status: number) {
      state.respondWith = status
    },
    waitFor(count, timeoutMs = 10_000) {
      if (received.length >= count) return Promise.resolve([...received])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${count} push(es), got ${received.length}`)),
          timeoutMs,
        )
        waiters.push({
          count,
          resolve: (r) => {
            clearTimeout(timer)
            resolve(r)
          },
        })
      })
    },
    async close() {
      agent.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
