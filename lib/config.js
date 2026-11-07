// local-tailscale — configuration and small filesystem helpers.
//
// The Auth Key is deliberately NOT part of this file or the saved config:
// it is only used in memory while `tailscale up` is running, then dropped.
// `data/tailscaled.state` contains the node key and is chmod 0600.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DATA_DIR = join(ROOT, 'data')
export const BIN_DIR = join(ROOT, 'bin')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  hostname: 'dsh-go-phone',
  autoStart: true,
  acceptRoutes: true,
  tailscaleVersion: '1.104.5',
  proxyFrontPort: 1056,
  socksPort: 1055,
  extraProxySuffixes: [],
  shellProxy: false,
  loginServer: '',
})

function clampPort(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

function normalizeString(value, fallback, max = 200) {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  return s.length > 0 && s.length <= max ? s : fallback
}

export function normalizeConfig(input = {}) {
  const base = { ...DEFAULT_CONFIG }
  if (!input || typeof input !== 'object') return base

  const out = {
    ...base,
    hostname: normalizeString(input.hostname, base.hostname, 63),
    autoStart: input.autoStart !== false,
    acceptRoutes: input.acceptRoutes !== false,
    tailscaleVersion: normalizeString(input.tailscaleVersion, base.tailscaleVersion, 32),
    proxyFrontPort: clampPort(input.proxyFrontPort, base.proxyFrontPort),
    socksPort: clampPort(input.socksPort, base.socksPort),
    shellProxy: input.shellProxy === true,
    loginServer: normalizeString(input.loginServer, '', 500),
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(out.hostname)) out.hostname = base.hostname
  if (!/^\d+\.\d+\.\d+$/.test(out.tailscaleVersion)) out.tailscaleVersion = base.tailscaleVersion
  if (out.proxyFrontPort === out.socksPort) out.socksPort = base.socksPort
  if (out.loginServer !== '' && !/^https?:\/\//i.test(out.loginServer)) out.loginServer = ''

  const suffixes = Array.isArray(input.extraProxySuffixes) ? input.extraProxySuffixes : []
  const cleaned = []
  for (const value of suffixes) {
    if (typeof value !== 'string') continue
    const s = value.trim().replace(/^\.+/, '').toLowerCase()
    if (s.length === 0 || s.length > 120) continue
    if (!cleaned.includes(s)) cleaned.push(s)
    if (cleaned.length >= 32) break
  }
  out.extraProxySuffixes = cleaned
  return out
}

export function ensureDirectories() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  try {
    chmodSync(DATA_DIR, 0o700)
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
  mkdirSync(BIN_DIR, { recursive: true, mode: 0o755 })
}

export function loadConfig() {
  ensureDirectories()
  if (!existsSync(CONFIG_FILE)) {
    const config = normalizeConfig()
    saveConfig(config)
    return config
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    const config = normalizeConfig(parsed)
    // Rewrite if normalization dropped or repaired anything.
    if (JSON.stringify(parsed) !== JSON.stringify(config)) saveConfig(config)
    return config
  } catch {
    const config = normalizeConfig()
    saveConfig(config)
    return config
  }
}

export function saveConfig(patch) {
  ensureDirectories()
  const current = existsSync(CONFIG_FILE)
    ? (() => {
        try {
          return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
        } catch {
          return {}
        }
      })()
    : {}
  const next = normalizeConfig({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Best effort.
  }
  renameSync(tmp, CONFIG_FILE)
  try {
    chmodSync(CONFIG_FILE, 0o600)
  } catch {
    // Best effort.
  }
  return next
}

export function updateConfig(patch) {
  return saveConfig(patch)
}

export function configPathForTest() {
  return CONFIG_FILE
}

export function rootForTest() {
  return ROOT
}

export function dirnameForTest() {
  return dirname(CONFIG_FILE)
}
