import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bellPayload,
  loadOrCreateVapid,
  PushService,
  parseSubscription,
  SubscriptionStore,
  sessionLabel,
  textPayload,
} from './push.js'
import { FileSecretStore, KeychainSecretStore } from './secrets.js'
import { type FakePushEndpoint, startFakePushEndpoint } from './test-support/push-endpoint.js'

describe('push payload', () => {
  it('uses the session title, else the cwd basename; the url opens the session', () => {
    expect(bellPayload({ id: 'abc', title: 'Fix login', cwd: '/tmp/acme-web' })).toEqual({
      title: 'Fix login',
      body: 'Sino do terminal',
      url: '/#/s/abc',
      tag: 'bell-abc',
    })
    expect(bellPayload({ id: 'abc', cwd: '/tmp/acme-web' }).title).toBe('acme-web')
    expect(bellPayload({ id: 'abc', title: '   ', cwd: '/tmp/acme-web/' }).title).toBe('acme-web')
    expect(sessionLabel({ cwd: '/' })).toBe('Bancada')
  })

  it('notify text: generic title without a session, session title with one, body capped', () => {
    expect(textPayload('build finished')).toEqual({ title: 'Bancada', body: 'build finished', url: '/' })
    expect(textPayload('x', { id: 's/1', cwd: '/tmp/api' })).toEqual({ title: 'api', body: 'x', url: '/#/s/s%2F1' })
    expect(textPayload('y'.repeat(1000)).body).toHaveLength(300)
  })

  it('validates subscriptions: https endpoint and base64url keys only', () => {
    const ok = { endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk-_x', auth: 'a_b-c' } }
    expect(parseSubscription(ok)).toEqual(ok)
    expect(parseSubscription({ ...ok, endpoint: 'http://push.example/abc' })).toBeNull()
    expect(parseSubscription({ ...ok, endpoint: 'not a url' })).toBeNull()
    expect(parseSubscription({ ...ok, keys: { p256dh: 'a b', auth: 'x' } })).toBeNull()
    expect(parseSubscription(null)).toBeNull()
  })
})

describe('VAPID keys', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join('/tmp', 'bancada-u-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('are generated once and reloaded from the file store (0600)', async () => {
    const file = path.join(dir, 'vapid.key')
    const store = new FileSecretStore(file)
    const first = await loadOrCreateVapid(store)
    const second = await loadOrCreateVapid(new FileSecretStore(file))
    expect(second).toEqual(first)
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(first.privateKey, 'base64url')).toHaveLength(32)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

// The real Keychain, with a throwaway account that is removed afterwards. Skipped where there is no login keychain.
describe.skipIf(process.platform !== 'darwin' || Boolean(process.env.CI))('Keychain secret store', () => {
  const account = `vapid-test-${process.pid}-${Date.now()}`
  const store = new KeychainSecretStore(account)
  afterAll(() => store.remove())

  it('stores the VAPID private key under service Bancada and reads it back', async () => {
    expect(await store.read()).toBeNull()
    const keys = await loadOrCreateVapid(store)
    expect(await store.read()).toBe(keys.privateKey)
    expect(await loadOrCreateVapid(store)).toEqual(keys)
  })
})

describe('push send path against a fake push endpoint', () => {
  let dir: string
  let endpoint: FakePushEndpoint
  beforeAll(async () => {
    endpoint = await startFakePushEndpoint()
  })
  afterAll(() => endpoint.close())
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join('/tmp', 'bancada-u-'))
    endpoint.received.length = 0
    endpoint.respondWith = 201
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function service() {
    const vapid = await loadOrCreateVapid(new FileSecretStore(path.join(dir, 'vapid.key')))
    const store = new SubscriptionStore(path.join(dir, 'push.json'))
    store.set('device-1', endpoint.subscription)
    const push = new PushService({ store, vapid, subject: 'https://example.invalid/bancada', agent: endpoint.agent })
    return { push, store, vapid }
  }

  it('sends an encrypted payload with a valid VAPID JWT (ES256, aud, exp, sub, k)', async () => {
    const { push, vapid } = await service()
    const payload = bellPayload({ id: 'sess-1', title: 'Fix login', cwd: '/tmp/acme-web' })
    const result = await push.notify(payload)
    expect(result).toEqual({ sent: 1, failed: 0, removed: 0 })
    const [got] = await endpoint.waitFor(1)
    expect(got?.payload).toEqual(payload) // decrypted with the subscription's keys, independent of web-push
    expect(got?.vapidPublicKey).toBe(vapid.publicKey)
    expect(got?.jwt.claims.sub).toBe('https://example.invalid/bancada')
    expect(got?.jwt.header).toMatchObject({ alg: 'ES256', typ: 'JWT' })
    expect(got?.headers.urgency).toBe('high')
    expect(got?.headers.ttl).toBe('120')
  })

  it('drops a subscription the push service reports as gone (410)', async () => {
    const { push, store } = await service()
    endpoint.respondWith = 410
    const result = await push.notify(textPayload('hi'))
    expect(result).toMatchObject({ sent: 0, removed: 1 })
    expect(store.all()).toEqual([])
  })

  it('counts other failures without dropping the subscription', async () => {
    const { push, store } = await service()
    endpoint.respondWith = 500
    expect(await push.notify(textPayload('hi'))).toMatchObject({ failed: 1, removed: 0 })
    expect(store.all()).toHaveLength(1)
  })

  it('stores subscriptions in push.json (0600), one per device, and drops them with the device', async () => {
    const { store } = await service()
    const file = path.join(dir, 'push.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    store.set('device-1', { ...endpoint.subscription, endpoint: 'https://push.example/other' })
    expect(store.all()).toHaveLength(1)
    store.removeDevice('device-1')
    expect(new SubscriptionStore(file).all()).toEqual([])
  })
})
