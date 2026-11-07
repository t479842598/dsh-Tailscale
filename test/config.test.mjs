import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'

test('normalizeConfig applies defaults without inventing a local gateway port', () => {
  const config = normalizeConfig()
  assert.equal(config.hostname, 'dsh-go-phone')
  assert.equal(config.proxyFrontPort, 1056)
  assert.equal(config.socksPort, 1055)
  assert.equal(config.routes, undefined)
  assert.equal(config.authKey, undefined)
})

test('normalizeConfig clamps and filters user values', () => {
  const config = normalizeConfig({
    proxyFrontPort: 99999,
    socksPort: -1,
    hostname: 'bad hostname!',
    extraProxySuffixes: ['.Corp.Internal', 'corp.internal', 42, ''],
    loginServer: 'http://headscale.example',
  })
  assert.equal(config.proxyFrontPort, 1056)
  assert.equal(config.socksPort, 1055)
  assert.equal(config.hostname, 'dsh-go-phone')
  assert.deepEqual(config.extraProxySuffixes, ['corp.internal'])
  assert.equal(config.loginServer, 'http://headscale.example')
})

test('normalizeConfig defaults a bad login server to empty', () => {
  assert.equal(normalizeConfig({ loginServer: 'headscale.example' }).loginServer, '')
})
