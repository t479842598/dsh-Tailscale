// local-tailscale — tailscaled userspace lifecycle and status parsing.
//
// This node is intentionally userspace-only: /dev/net/tun is not usable in
// the dsh-go proot runtime (open returns EPERM), so `--tun=userspace-networking`
// is the supported path. The daemon exposes loopback SOCKS5/HTTP fronts for
// the in-process dispatcher; neither is a user-facing service.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RELEASE_API = 'https://pkgs.tailscale.com/stable/?mode=json'
const RELEASE_BASE = 'https://pkgs.tailscale.com/stable/'
const MIN_BINARY_BYTES = 1024 * 1024
const MIN_STATE_BYTES = 64

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function archName() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'x64':
      return 'amd64'
    case 'arm':
      return 'arm'
    case 'ia32':
      return '386'
    default:
      return process.arch
  }
}

function redact(value) {
  return String(value ?? '')
    .replace(/tskey-[A-Za-z0-9_-]+/g, 'tskey-<redacted>')
    .replace(/hskey-[A-Za-z0-9_-]+/g, 'hskey-<redacted>')
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function killPid(pid, signal) {
  try {
    process.kill(pid, signal)
    return
  } catch {
    // Fall through to the external kill binary for proot PID/signal quirks.
  }
  try {
    await execFileAsync('/bin/kill', [`-${signal}`, String(pid)], { timeout: 3000 })
  } catch {
    // Already gone or not signalable.
  }
}

function findFile(root, name, depth = 0) {
  if (depth > 3) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return path
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findFile(join(root, entry.name), name, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

export class TailscaleManager {
  constructor(config, options = {}) {
    this.config = config
    this.root = options.root
    this.dataDir = join(this.root, 'data')
    this.binDir = join(this.root, 'bin')
    this.statePath = join(this.dataDir, 'tailscaled.state')
    this.socketPath = join(this.dataDir, 'tailscaled.sock')
    this.pidPath = join(this.dataDir, 'tailscaled.pid')
    this.logPath = join(this.dataDir, 'tailscaled.log')
    this.daemonPath = join(this.binDir, 'tailscaled')
    this.cliPath = join(this.binDir, 'tailscale')
    this.cachedStatus = null
    this.cachedAt = 0
    this.installing = false
    this.installLabel = ''
    this.lastError = ''
    this.loginUrl = ''
    this.loginChild = null
  }

  hasBinary() {
    return fileSize(this.daemonPath) >= MIN_BINARY_BYTES && fileSize(this.cliPath) >= MIN_BINARY_BYTES
  }

  hasState() {
    return existsSync(this.statePath) && fileSize(this.statePath) > MIN_STATE_BYTES
  }

  async ensureBinary() {
    if (this.hasBinary()) return
    if (this.installing) {
      while (this.installing) await sleep(250)
      if (this.hasBinary()) return
      throw new Error(this.lastError || 'Tailscale binary installation failed')
    }
    this.installing = true
    this.installLabel = '正在准备 Tailscale 二进制'
    this.lastError = ''
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      mkdirSync(this.binDir, { recursive: true, mode: 0o755 })

      let version = this.config.tailscaleVersion || '1.104.5'
      let tarball = `tailscale_${version}_${archName()}.tgz`
      try {
        const response = await fetch(RELEASE_API, { signal: AbortSignal.timeout(20_000) })
        if (response.ok) {
          const meta = await response.json()
          const candidate = meta?.Tarballs?.[archName()]
          if (typeof candidate === 'string' && candidate.length > 0) {
            tarball = candidate
            version = String(meta.TarballsVersion || version)
          }
        }
      } catch {
        // Fall back to the pinned version when the index is unreachable.
      }

      const url = `${RELEASE_BASE}${tarball}`
      this.installLabel = `下载 ${basename(tarball)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())

      this.installLabel = '校验 Tailscale 安装包'
      let expected = ''
      try {
        const checksumResponse = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(20_000) })
        if (checksumResponse.ok) expected = (await checksumResponse.text()).trim().split(/\s+/)[0] || ''
      } catch {
        // A missing checksum is not fatal if the tarball download succeeded,
        // but all HTTP 200 checksums are verified when present.
      }
      if (expected !== '') {
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error('Tailscale tarball checksum mismatch')
        }
      }

      const tmpRoot = join(this.dataDir, 'install-tmp')
      rmSync(tmpRoot, { recursive: true, force: true })
      mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
      const tarPath = join(tmpRoot, basename(tarball))
      writeFileSync(tarPath, bytes, { mode: 0o600 })
      await execFileAsync('tar', ['-xzf', tarPath, '-C', tmpRoot], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })

      const extractedDaemon = findFile(tmpRoot, 'tailscaled')
      const extractedCli = findFile(tmpRoot, 'tailscale')
      if (!extractedDaemon || !extractedCli) throw new Error('tailscaled/tailscale not found in tarball')
      copyFileSync(extractedDaemon, this.daemonPath)
      copyFileSync(extractedCli, this.cliPath)
      chmodSync(this.daemonPath, 0o755)
      chmodSync(this.cliPath, 0o755)
      rmSync(tmpRoot, { recursive: true, force: true })
      this.installLabel = ''
      this.cachedStatus = null
      this.cachedAt = 0
    } catch (error) {
      this.lastError = redact(error?.message ?? error)
      this.installLabel = ''
      throw error
    } finally {
      this.installing = false
    }
  }

  async pingSocket() {
    if (!existsSync(this.socketPath)) return false
    return await new Promise((resolve) => {
      const socket = connect(this.socketPath)
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      setTimeout(() => done(false), 500)
    })
  }

  readLogTail(max = 5000) {
    try {
      const text = readFileSync(this.logPath, 'utf8')
      return text.slice(-max)
    } catch {
      return ''
    }
  }

  async startDaemon() {
    await this.ensureBinary()
    if (await this.pingSocket()) {
      this.cachedStatus = null
      this.cachedAt = 0
      return { started: false }
    }

    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    // A crashed daemon can leave a Unix socket file behind; tailscaled cannot
    // bind over it. It is safe to remove only after pingSocket() returned false.
    rmSync(this.socketPath, { force: true })
    const logFd = openSync(this.logPath, 'a', 0o600)
    const args = [
      '--tun=userspace-networking',
      `--state=${this.statePath}`,
      `--socket=${this.socketPath}`,
      `--socks5-server=127.0.0.1:${this.config.socksPort}`,
      `--outbound-http-proxy-listen=127.0.0.1:${this.config.proxyFrontPort}`,
      '--port=0',
      '--no-logs-no-support',
    ]
    let child
    try {
      child = spawn(this.daemonPath, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, TS_NO_LOGS_NO_SUPPORT: '1' },
      })
      child.unref()
      writeFileSync(this.pidPath, `${child.pid}\n`, { mode: 0o600 })
    } finally {
      closeSync(logFd)
    }

    for (let i = 0; i < 100; i++) {
      if (await this.pingSocket()) {
        this.cachedStatus = null
        this.cachedAt = 0
        return { started: true, pid: child.pid }
      }
      if (child.exitCode !== null) break
      await sleep(200)
    }
    throw new Error(`tailscaled failed to start: ${redact(this.readLogTail()) || 'no log output'}`)
  }

  async runCli(args, timeout = 15_000) {
    if (!this.hasBinary()) throw new Error('Tailscale CLI is not installed yet')
    try {
      const result = await execFileAsync(this.cliPath, [`--socket=${this.socketPath}`, ...args], {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      })
      return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
    } catch (error) {
      const stderr = redact(error?.stderr ?? '')
      const message = stderr.trim() || redact(error?.message ?? error)
      throw new Error(message)
    }
  }

  async status(force = false) {
    if (!force && this.cachedStatus && Date.now() - this.cachedAt < 3000) return this.cachedStatus

    const base = {
      phase: 'stopped',
      backendState: 'Stopped',
      raw: null,
      authUrl: this.loginUrl,
      self: { hostName: this.config.hostname, dnsName: '', ips: [] },
      tailnet: { name: '', magicSuffix: '' },
      peers: [],
      peerOnline: 0,
      peerTotal: 0,
      error: '',
    }

    if (!(await this.pingSocket())) {
      this.cachedStatus = { ...base, installing: this.installing, installLabel: this.installLabel }
      this.cachedAt = Date.now()
      return this.cachedStatus
    }

    try {
      const { stdout } = await this.runCli(['status', '--json'], 10_000)
      const raw = JSON.parse(stdout)
      const peerObject = raw?.Peer && typeof raw.Peer === 'object' && !Array.isArray(raw.Peer) ? raw.Peer : {}
      const peers = Object.values(peerObject).map((peer) => ({
        hostName: String(peer?.HostName ?? peer?.DNSName ?? ''),
        dnsName: String(peer?.DNSName ?? ''),
        ips: Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs.map(String) : [],
        online: peer?.Online === true,
        os: String(peer?.OS ?? ''),
        exitNode: peer?.ExitNode === true,
      }))
      const backend = String(raw?.BackendState ?? 'Stopped')
      if (backend === 'Running') this.loginUrl = ''
      const phase =
        backend === 'Running'
          ? 'connected'
          : backend === 'Starting'
            ? 'starting'
            : backend === 'NeedsLogin' || backend === 'NoState'
              ? 'needs-login'
              : 'stopped'
      const authUrl = String(raw?.AuthURL ?? this.loginUrl ?? '')
      if (authUrl) this.loginUrl = authUrl
      const snapshot = {
        ...base,
        phase,
        backendState: backend,
        raw,
        authUrl,
        self: {
          hostName: String(raw?.Self?.HostName ?? this.config.hostname),
          dnsName: String(raw?.Self?.DNSName ?? ''),
          ips: Array.isArray(raw?.Self?.TailscaleIPs) ? raw.Self.TailscaleIPs.map(String) : [],
        },
        tailnet: {
          name: String(raw?.CurrentTailnet?.Name ?? ''),
          magicSuffix: String(raw?.CurrentTailnet?.MagicDNSSuffix ?? '').replace(/\.$/, ''),
        },
        peers,
        peerOnline: peers.filter((peer) => peer.online).length,
        peerTotal: peers.length,
        installing: this.installing,
        installLabel: this.installLabel,
        error: '',
      }
      this.cachedStatus = snapshot
      this.cachedAt = Date.now()
      return snapshot
    } catch (error) {
      const message = redact(error?.message ?? error)
      this.lastError = message
      const snapshot = {
        ...base,
        phase: 'error',
        error: message,
        installing: this.installing,
        installLabel: this.installLabel,
      }
      this.cachedStatus = snapshot
      this.cachedAt = Date.now()
      return snapshot
    }
  }

  async beginBrowserLogin() {
    await this.startDaemon()
    const current = await this.status(true)
    if (current.phase === 'connected') {
      return { alreadyConnected: true, authUrl: '', status: current }
    }
    if (current.authUrl) {
      this.loginUrl = current.authUrl
      return { alreadyConnected: false, authUrl: current.authUrl, status: current }
    }

    await this.killLoginChild()
    const args = [
      'login',
      `--hostname=${this.config.hostname}`,
      '--accept-dns=false',
      '--timeout=45s',
    ]
    if (this.config.acceptRoutes) args.push('--accept-routes')
    if (this.config.loginServer) args.push(`--login-server=${this.config.loginServer}`)

    let output = ''
    const child = spawn(this.cliPath, [`--socket=${this.socketPath}`, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TS_NO_LOGS_NO_SUPPORT: '1' },
    })
    this.loginChild = child
    const collect = (chunk) => {
      output += String(chunk)
      if (output.length > 16_000) output = output.slice(-16_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('exit', () => {
      if (this.loginChild === child) this.loginChild = null
    })
    child.unref()

    const deadline = Date.now() + 15_000
    let last = null
    while (Date.now() < deadline) {
      await sleep(300)
      last = await this.status(true)
      if (last.authUrl) {
        this.loginUrl = last.authUrl
        return { alreadyConnected: false, authUrl: last.authUrl, status: last }
      }
      const urlMatch = output.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/)
      if (urlMatch) {
        this.loginUrl = urlMatch[0]
        return { alreadyConnected: false, authUrl: urlMatch[0], status: last }
      }
      if (last.phase === 'connected') {
        return { alreadyConnected: true, authUrl: '', status: last }
      }
    }
    throw new Error(`未能获取登录链接：${redact(output) || last?.error || 'tailscale login 无输出'}`)
  }

  async killLoginChild() {
    const child = this.loginChild
    this.loginChild = null
    if (child && child.exitCode === null) {
      await killPid(child.pid, 'SIGTERM')
    }
  }

  async login(authKey) {
    const key = String(authKey ?? '').trim()
    if (key.length < 8 || key.length > 500 || /\s/.test(key)) {
      throw new Error('Auth Key 格式不正确')
    }
    await this.killLoginChild()
    await this.startDaemon()
    const args = [
      'up',
      `--auth-key=${key}`,
      `--hostname=${this.config.hostname}`,
      '--accept-dns=false',
    ]
    if (this.config.acceptRoutes) args.push('--accept-routes')
    if (this.config.loginServer) args.push(`--login-server=${this.config.loginServer}`)
    try {
      await this.runCli(args, 90_000)
    } finally {
      // The key is not retained by this process after `tailscale up`; the
      // node key lives in tailscaled.state.
    }

    const deadline = Date.now() + 45_000
    let last = null
    while (Date.now() < deadline) {
      last = await this.status(true)
      if (last.phase === 'connected') {
        this.loginUrl = ''
        return last
      }
      if (last.phase === 'error' || last.phase === 'needs-login') {
        await sleep(1200)
      } else {
        await sleep(1000)
      }
    }
    throw new Error(last?.error || 'Tailscale 登录超时，请刷新状态查看详情')
  }

  async logout() {
    await this.killLoginChild()
    try {
      if (await this.pingSocket()) await this.runCli(['logout'], 10_000)
    } catch {
      // Logout is best-effort; killing the daemon still clears the process.
    }
    await this.stopDaemon()
    rmSync(this.statePath, { force: true })
    this.loginUrl = ''
    this.cachedStatus = null
    this.cachedAt = 0
  }

  async stopDaemon() {
    await this.killLoginChild()
    try {
      if (await this.pingSocket()) await this.runCli(['down'], 5000)
    } catch {
      // Best effort.
    }
    let pid = 0
    try {
      pid = Number(readFileSync(this.pidPath, 'utf8').trim())
    } catch {
      pid = 0
    }
    if (Number.isInteger(pid) && pid > 1) {
      await killPid(pid, 'SIGTERM')
      for (let i = 0; i < 30; i++) {
        if (!(await this.pingSocket())) break
        await sleep(150)
      }
      await killPid(pid, 'SIGKILL')
    }
    rmSync(this.pidPath, { force: true })
    rmSync(this.socketPath, { force: true })
    this.cachedStatus = null
    this.cachedAt = 0
  }

  async dispose() {
    await this.stopDaemon()
  }
}
