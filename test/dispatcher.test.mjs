import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createSplitDispatcher } from '../lib/dispatcher.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

test('split dispatcher sends matching hosts through the proxy', async () => {
  let proxyHits = 0
  const target = http.createServer((req, res) => res.end('TARGET'))
  const proxy = http.createServer((req, res) => {
    proxyHits += 1
    res.end('PROXY')
  })
  const targetPort = await listen(target)
  const proxyPort = await listen(proxy)
  const dispatcher = await createSplitDispatcher({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    matchHost: () => true,
    isConnected: () => true,
  })
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/v1/models`)
    assert.equal(await response.text(), 'PROXY')
    assert.equal(proxyHits, 1)
  } finally {
    await dispatcher.dispose()
    await close(target)
    await close(proxy)
  }
})

test('split dispatcher keeps non-matching hosts on the previous dispatcher', async () => {
  let proxyHits = 0
  const target = http.createServer((req, res) => res.end('TARGET'))
  const proxy = http.createServer((req, res) => {
    proxyHits += 1
    res.end('PROXY')
  })
  const targetPort = await listen(target)
  const proxyPort = await listen(proxy)
  const dispatcher = await createSplitDispatcher({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    matchHost: () => false,
    isConnected: () => true,
  })
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/direct`)
    assert.equal(await response.text(), 'TARGET')
    assert.equal(proxyHits, 0)
  } finally {
    await dispatcher.dispose()
    await close(target)
    await close(proxy)
  }
})

test('split dispatcher fails closed for tailnet hosts while disconnected', async () => {
  const target = http.createServer((req, res) => res.end('TARGET'))
  const targetPort = await listen(target)
  const dispatcher = await createSplitDispatcher({
    proxyUrl: 'http://127.0.0.1:1',
    matchHost: () => true,
    isConnected: () => false,
  })
  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:${targetPort}/blocked`, { signal: AbortSignal.timeout(2500) }),
    )
  } finally {
    await dispatcher.dispose()
    await close(target)
  }
})
