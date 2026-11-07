// local-tailscale — tailnet route table and host matcher.
//
// Mirrors the useful part of OpenMinis's deps/rclone-mobile/tsnet buildRoutes():
// Tailscale's own address ranges always belong to the tailnet, peer IPs are
// exact routes, and accepted subnet routes are added when acceptRoutes is on.
// The resulting BlockList is used by the process-wide undici dispatcher.

import { BlockList, isIP } from 'node:net'

export const STATIC_PREFIXES = Object.freeze([
  '100.64.0.0/10',
  'fd7a:115c:a1e0::/48',
])

function normalizeHost(host) {
  return String(host ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

function familyOfPrefix(prefix) {
  return prefix.includes(':') ? 'ipv6' : 'ipv4'
}

function addPrefix(list, prefix) {
  if (typeof prefix !== 'string') return
  const value = prefix.trim()
  if (value === '') return
  const slash = value.lastIndexOf('/')
  const address = slash >= 0 ? value.slice(0, slash) : value
  const bits = slash >= 0 ? Number(value.slice(slash + 1)) : undefined
  const family = familyOfPrefix(address)
  if (!isIP(address)) return
  if (bits === undefined || !Number.isInteger(bits)) {
    list.addAddress(address, family)
  } else {
    list.addSubnet(address, bits, family)
  }
}

function addExactIp(list, value) {
  if (typeof value !== 'string') return
  const address = value.trim()
  if (isIP(address) === 4) list.addAddress(address, 'ipv4')
  else if (isIP(address) === 6) list.addAddress(address, 'ipv6')
}

function routeStrings(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  if (value && typeof value === 'object') {
    // Defensive support for a possible { All: [...] } JSON projection.
    if (Array.isArray(value.All)) return value.All.filter((v) => typeof v === 'string')
    if (Array.isArray(value.prefixes)) return value.prefixes.filter((v) => typeof v === 'string')
  }
  return []
}

/**
 * Build a route table from `tailscale status --json`.
 * @param {object|null} status
 * @param {boolean} acceptRoutes
 */
export function buildRouteTable(status, acceptRoutes = true) {
  const list = new BlockList()
  const prefixes = [...STATIC_PREFIXES]
  const peerNames = new Set()
  const exactIps = new Set()

  for (const prefix of STATIC_PREFIXES) addPrefix(list, prefix)

  const self = status?.Self ?? {}
  const rawPeer = status?.Peer
  const peers = Array.isArray(rawPeer) ? rawPeer : Object.values(rawPeer ?? {})

  for (const ip of routeStrings(self.TailscaleIPs)) {
    addExactIp(list, ip)
    exactIps.add(ip)
  }

  let hasExitNode = false
  for (const peer of peers) {
    if (!peer || typeof peer !== 'object') continue

    for (const ip of routeStrings(peer.TailscaleIPs)) {
      addExactIp(list, ip)
      exactIps.add(ip)
    }

    for (const name of [peer.DNSName, peer.HostName, peer.Name]) {
      if (typeof name !== 'string' || name.trim() === '') continue
      const n = normalizeHost(name)
      if (n !== '') peerNames.add(n)
    }

    if (acceptRoutes && peer.Online === true) {
      for (const prefix of routeStrings(peer.PrimaryRoutes)) {
        addPrefix(list, prefix)
        prefixes.push(prefix)
      }
    }

    if (peer.ExitNode === true) hasExitNode = true
  }

  if (hasExitNode) {
    addPrefix(list, '0.0.0.0/0')
    addPrefix(list, '::/0')
    prefixes.push('0.0.0.0/0', '::/0')
  }

  const magicSuffix = normalizeHost(
    status?.CurrentTailnet?.MagicDNSSuffix ??
      status?.CurrentTailnet?.MagicDnsSuffix ??
      status?.MagicDNSSuffix ??
      '',
  )

  return {
    blockList: list,
    prefixes: [...new Set(prefixes)],
    exactIps,
    peerNames,
    magicSuffix,
    hasExitNode,
  }
}

export function emptyRouteTable() {
  return buildRouteTable({}, true)
}

export function isLoopbackHost(host) {
  const h = normalizeHost(host)
  if (h === '' || h === 'localhost') return true
  if (isIP(h) === 4) return h.startsWith('127.') || h === '0.0.0.0'
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1'
  return false
}

/**
 * Whether a request destination belongs to the tailnet and should be routed
 * through the embedded Tailscale node.
 */
export function isTailnetHost(host, table = emptyRouteTable(), extraSuffixes = []) {
  const h = normalizeHost(host)
  if (h === '' || isLoopbackHost(h)) return false

  const family = isIP(h)
  if (family === 4 || family === 6) {
    return table.blockList.check(h, family === 4 ? 'ipv4' : 'ipv6')
  }

  if (table.peerNames.has(h)) return true
  if (table.exactIps.has(h)) return true

  const suffixes = []
  if (table.magicSuffix) suffixes.push(table.magicSuffix)
  suffixes.push('ts.net')
  for (const suffix of extraSuffixes) {
    if (typeof suffix === 'string' && suffix.trim() !== '') {
      suffixes.push(normalizeHost(suffix))
    }
  }
  for (const suffix of suffixes) {
    if (suffix === '') continue
    if (h === suffix || h.endsWith(`.${suffix}`)) return true
  }

  // MagicDNS short names (for example `llm` or `gpu-box`) contain no dot.
  // They are resolved by tailscaled's HTTP front, not by the host resolver.
  if (!h.includes('.')) return true

  return false
}

export function describeRouteTable(table) {
  return {
    prefixes: [...table.prefixes],
    magicSuffix: table.magicSuffix,
    peerNames: [...table.peerNames],
    hasExitNode: table.hasExitNode,
  }
}
