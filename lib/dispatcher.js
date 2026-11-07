// local-tailscale — process-wide split dispatcher.
//
// dsh's launcher installs @deepseek-ai/dsh-http-proxy before plugins load.
// We keep that dispatcher for public destinations and only route destinations
// that belong to the tailnet through the local tailscaled HTTP front. This is
// the dsh-go analogue of OpenMinis's NetworkHttp: provider Base URLs stay the
// real intranet host:port; no local access port is exposed to the user.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let undiciPromise

async function loadUndici() {
  if (undiciPromise) return undiciPromise
  undiciPromise = (async () => {
    const candidates = []
    if (process.argv[1]) {
      candidates.push(join(dirname(process.argv[1]), '..', 'package.json'))
    }
    candidates.push(
      '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json',
      '/opt/dsh/node_modules/@deepseek-ai/dsh-http-proxy/package.json',
    )
    for (const packageJson of candidates) {
      try {
        const req = createRequire(packageJson)
        const resolved = req.resolve('undici')
        return await import(pathToFileURL(resolved).href)
      } catch {
        // Try the next installation layout.
      }
    }
    return await import('undici')
  })()
  return undiciPromise
}

function originHost(origin) {
  try {
    return new URL(String(origin)).hostname
  } catch {
    return ''
  }
}

/**
 * Install a split dispatcher as the process-wide undici dispatcher.
 *
 * @param {object} options
 * @param {string} options.proxyUrl  loopback URL of tailscaled's HTTP front
 * @param {(host: string) => boolean} options.matchHost  tailnet destination test
 * @param {() => boolean} options.isConnected  whether Tailscale is running
 * @returns {Promise<{dispose: () => Promise<void>, proxyUrl: string}>}
 */
export async function createSplitDispatcher({ proxyUrl, matchHost, isConnected }) {
  const undici = await loadUndici()
  const previous = undici.getGlobalDispatcher()
  const proxyAgent = new undici.ProxyAgent({ uri: proxyUrl })
  const blockedAgent = new undici.ProxyAgent({ uri: 'http://127.0.0.1:1' })

  class SplitDispatcher extends undici.Dispatcher {
    dispatch(opts, handler) {
      const host = originHost(opts?.origin)
      let matches = false
      try {
        matches = host !== '' && matchHost(host) === true
      } catch {
        matches = false
      }
      if (!matches) return previous.dispatch(opts, handler)
      if (isConnected() === true) return proxyAgent.dispatch(opts, handler)
      // Fail closed: an internal address must never silently fall back to the
      // phone's local network while the Tailscale node is down.
      return blockedAgent.dispatch(opts, handler)
    }

    async close() {
      await proxyAgent.close().catch(() => {})
      await blockedAgent.close().catch(() => {})
    }

    async destroy(error) {
      await proxyAgent.destroy(error).catch(() => {})
      await blockedAgent.destroy(error).catch(() => {})
    }
  }

  const split = new SplitDispatcher()
  undici.setGlobalDispatcher(split)
  let disposed = false
  return {
    proxyUrl,
    async dispose() {
      if (disposed) return
      disposed = true
      if (undici.getGlobalDispatcher() === split) undici.setGlobalDispatcher(previous)
      await proxyAgent.close().catch(() => {})
      await blockedAgent.close().catch(() => {})
    },
  }
}

export async function loadUndiciForTest() {
  return await loadUndici()
}
