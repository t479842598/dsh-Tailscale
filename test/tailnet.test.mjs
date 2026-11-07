import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRouteTable,
  describeRouteTable,
  isLoopbackHost,
  isTailnetHost,
} from '../lib/tailnet.js'

const status = {
  BackendState: 'Running',
  Self: {
    HostName: 'dsh-go-phone',
    DNSName: 'dsh-go-phone.tailnet.ts.net.',
    TailscaleIPs: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
  },
  Peer: {
    llm: {
      HostName: 'llm',
      DNSName: 'llm.tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.6'],
      Online: true,
      PrimaryRoutes: ['192.168.50.0/24'],
    },
  },
  CurrentTailnet: { Name: 'example', MagicDNSSuffix: 'tailnet.ts.net.' },
}

test('buildRouteTable includes static, self, peer and accepted subnet routes', () => {
  const table = buildRouteTable(status, true)
  assert.equal(table.blockList.check('100.64.9.9', 'ipv4'), true)
  assert.equal(table.blockList.check('fd7a:115c:a1e0::9', 'ipv6'), true)
  assert.equal(table.blockList.check('192.168.50.7', 'ipv4'), true)
  assert.equal(table.blockList.check('192.168.51.7', 'ipv4'), false)
  assert.equal(table.magicSuffix, 'tailnet.ts.net')
  assert.equal(table.peerNames.has('llm.tailnet.ts.net'), true)
  assert.deepEqual(describeRouteTable(table).prefixes.slice(0, 2), [
    '100.64.0.0/10',
    'fd7a:115c:a1e0::/48',
  ])
})

test('isTailnetHost matches tailnet addresses and MagicDNS names', () => {
  const table = buildRouteTable(status, true)
  assert.equal(isTailnetHost('100.64.0.6', table), true)
  assert.equal(isTailnetHost('fd7a:115c:a1e0::6', table), true)
  assert.equal(isTailnetHost('llm.tailnet.ts.net', table), true)
  assert.equal(isTailnetHost('llm', table), true)
  assert.equal(isTailnetHost('8.8.8.8', table), false)
  assert.equal(isTailnetHost('example.com', table), false)
})

test('isTailnetHost never routes loopback or public addresses to tailnet', () => {
  const table = buildRouteTable(status, true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isTailnetHost('127.0.0.1', table), false)
  assert.equal(isTailnetHost('localhost', table), false)
  assert.equal(isTailnetHost('1.1.1.1', table), false)
})

test('extra suffixes opt external-looking internal names into the tailnet', () => {
  const table = buildRouteTable(status, true)
  assert.equal(isTailnetHost('llm.corp.internal', table, ['corp.internal']), true)
  assert.equal(isTailnetHost('llm.corp.internal', table), false)
})
