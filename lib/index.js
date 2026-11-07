// local-tailscale — dsh-go native panel and process-wide Tailscale routing.
//
// The provider Base URL is the real intranet address (for example
// http://100.64.0.12:3000/v1). The plugin installs an undici split dispatcher
// so those requests go through tailscaled's userspace HTTP front; there is no
// user-facing local gateway or `127.0.0.1:<port>` URL to configure.

import { ROOT, loadConfig } from './config.js'
import { createSplitDispatcher } from './dispatcher.js'
import { TailscaleManager } from './tailscale.js'
import { buildRouteTable, isTailnetHost } from './tailnet.js'

export const name = 'local-tailscale'

const state = {
  config: null,
  manager: null,
  dispatcher: null,
  routeTable: buildRouteTable({}, true),
  lastStatus: null,
  lastError: '',
  testResult: '',
  loginUrl: '',
  initializing: false,
}

const savedShellEnv = new Map()

function applyShellProxy() {
  if (!state.config || state.config.shellProxy !== true) return
  const values = {
    HTTP_PROXY: `http://127.0.0.1:${state.config.proxyFrontPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${state.config.proxyFrontPort}`,
    ALL_PROXY: `socks5h://127.0.0.1:${state.config.socksPort}`,
    NO_PROXY: '127.0.0.1,localhost,::1',
  }
  for (const [name, value] of Object.entries(values)) {
    if (!savedShellEnv.has(name)) savedShellEnv.set(name, process.env[name])
    process.env[name] = value
  }
}

function clearShellProxy() {
  for (const [name, previous] of savedShellEnv.entries()) {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
  savedShellEnv.clear()
}

function redact(value) {
  return String(value ?? '')
    .replace(/tskey-[A-Za-z0-9_-]+/g, 'tskey-<redacted>')
    .replace(/hskey-[A-Za-z0-9_-]+/g, 'hskey-<redacted>')
}

function phaseMeta(status) {
  if (status?.installing === true) {
    return { label: status.installLabel || '准备中', tone: 'info' }
  }
  const phase = status?.phase ?? 'stopped'
  switch (phase) {
    case 'connected':
      return { label: '已连接', tone: 'good' }
    case 'needs-login':
      return { label: '等待登录', tone: 'warn' }
    case 'starting':
      return { label: '连接中', tone: 'info' }
    case 'error':
      return { label: '连接错误', tone: 'bad' }
    case 'stopped':
      return { label: '未启动', tone: 'muted' }
    default:
      return { label: status?.installLabel || '准备中', tone: 'info' }
  }
}

function statusText(status, locale) {
  const en = String(locale ?? '').startsWith('en')
  const phase = status?.phase ?? 'stopped'
  if (phase === 'connected') {
    const online = Number(status?.peerOnline ?? 0)
    return en ? `Tailscale · ${online} online` : `Tailscale · ${online} 节点`
  }
  if (phase === 'needs-login') return en ? 'Tailscale · sign in' : 'Tailscale 待登录'
  if (phase === 'starting') return en ? 'Tailscale · starting' : 'Tailscale 连接中'
  if (status?.installing === true) return en ? 'Tailscale · preparing' : 'Tailscale 准备中'
  return en ? 'Tailscale · off' : 'Tailscale 未连接'
}

function buildSnapshot() {
  const status = state.lastStatus ?? {
    phase: 'stopped',
    backendState: 'Stopped',
    self: { hostName: state.config?.hostname ?? 'dsh-go-phone', ips: [], dnsName: '' },
    tailnet: { name: '', magicSuffix: '' },
    peers: [],
    peerOnline: 0,
    peerTotal: 0,
  }
  const meta = phaseMeta(status)
  const peers = Array.isArray(status.peers) ? status.peers : []
  return {
    phase: status.phase ?? 'stopped',
    phaseLabel: meta.label,
    tone: meta.tone,
    hostName: status.self?.hostName ?? state.config?.hostname ?? '',
    tailnet: status.tailnet?.name ?? '',
    magicSuffix: status.tailnet?.magicSuffix ?? '',
    ip: (status.self?.ips ?? []).join(', '),
    peerOnline: status.peerOnline ?? 0,
    peerTotal: status.peerTotal ?? 0,
    loginUrl: status.authUrl || state.manager?.loginUrl || '',
    installing: status.installing === true,
    installLabel: status.installLabel ?? '',
    error: state.lastError || status.error || '',
    testResult: state.testResult || '',
    routeMode: '自动：内网/Tailscale 地址走 Tailscale，公网直连',
    form: { authKey: '', testUrl: '' },
    peerRows: peers.slice(0, 24).map((peer) => [
      peer.hostName || peer.dnsName || '—',
      (peer.ips ?? []).join(', ') || '—',
      peer.online ? '在线' : '离线',
    ]),
  }
}

function makeView() {
  return {
    type: 'stack',
    v: 2,
    accent: 'app',
    children: [
      { type: 'text', text: 'Tailscale 内网', style: { size: 'title', weight: 'bold' } },
      {
        type: 'row',
        children: [
          {
            type: 'metric',
            label: '连接状态',
            value: { $: 'data.phaseLabel' },
            tone: { $: 'data.tone' },
          },
          {
            type: 'metric',
            label: '在线节点',
            value: { $: 'data.peerOnline' },
            caption: { $: 'data.peerTotal' },
          },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: '刷新', action: 'refresh', icon: 'refresh' },
          { label: '启动', action: 'start', icon: 'play' },
          { label: '停止', action: 'stop', icon: 'stop' },
          { label: '退出登录', action: 'logout', icon: 'power' },
        ],
      },
      {
        type: 'tabs',
        items: [
          {
            label: '登录',
            children: [
              { type: 'text', text: '方式一：数字 Key / Auth Key', style: { size: 'subtitle', weight: 'semibold' } },
              { type: 'text', text: '从 Tailscale 管理后台生成 Key，粘贴后点登录。', tone: 'muted' },
              {
                type: 'form',
                submit: { id: 'login', args: { $: 'data.form' } },
                submitLabel: '用 Key 登录',
                children: [
                  {
                    type: 'textField',
                    label: '数字 Key / Auth Key',
                    bind: 'data.form.authKey',
                    placeholder: 'tskey-auth-… 或数字 Key',
                    required: true,
                    maxLength: 500,
                  },
                ],
              },
              { type: 'divider', size: 'L' },
              { type: 'text', text: '方式二：浏览器登录并授权返回', style: { size: 'subtitle', weight: 'semibold' } },
              { type: 'text', text: '生成 Tailscale 登录链接后，在浏览器完成授权即可自动返回。', tone: 'muted' },
              {
                type: 'actions',
                items: [
                  { label: '生成登录链接', action: 'browser-login', icon: 'globe' },
                ],
              },
              {
                type: 'actions',
                items: [
                  { label: '打开登录页', action: 'open-login', icon: 'link' },
                  { label: '复制登录链接', action: 'copy-login', icon: 'copy' },
                ],
              },
              { type: 'text', text: { $: 'data.loginUrl' }, style: { size: 'caption', weight: 'regular' } },
            ],
          },
          {
            label: '状态',
            children: [
              {
                type: 'keyValue',
                items: [
                  ['设备', { $: 'data.hostName' }],
                  ['Tailnet', { $: 'data.tailnet' }],
                  ['Tailscale IP', { $: 'data.ip' }],
                  ['路由', { $: 'data.routeMode' }],
                ],
              },
              { type: 'text', text: '可用节点（把 IP 填到供应商 Base URL）', style: { size: 'caption', weight: 'medium' } },
              { type: 'table', columns: ['节点', 'IP', '状态'], rows: { $: 'data.peerRows' } },
              { type: 'text', text: { $: 'data.error' }, tone: 'muted' },
            ],
          },
          {
            label: '使用',
            children: [
              {
                type: 'callout',
                text: '在 设置 → 模型 → 添加渠道 中，Base URL 直接填真实内网地址和端口，例如 http://100.x.y.z:3000/v1。不要填 127.0.0.1 或本地网关端口。',
                tone: 'info',
              },
              {
                type: 'form',
                submit: { id: 'test-url', args: { $: 'data.form' } },
                submitLabel: '测试内网地址',
                children: [
                  {
                    type: 'textField',
                    label: '测试 URL',
                    bind: 'data.form.testUrl',
                    placeholder: 'http://100.x.y.z:3000/v1/models',
                    maxLength: 500,
                  },
                ],
              },
              { type: 'text', text: { $: 'data.testResult' }, tone: 'muted' },
            ],
          },
        ],
      },
    ],
  }
}

function readField(event, field) {
  const value = event?.value
  if (value && typeof value === 'object') {
    if (typeof value[field] === 'string') return value[field].trim()
    if (value.form && typeof value.form[field] === 'string') return value.form[field].trim()
  }
  return ''
}

async function ensureDispatcher() {
  if (state.dispatcher !== null) return
  if (!state.config || !state.manager) return
  state.dispatcher = await createSplitDispatcher({
    proxyUrl: `http://127.0.0.1:${state.config.proxyFrontPort}`,
    matchHost: (host) => isTailnetHost(host, state.routeTable, state.config.extraProxySuffixes),
    isConnected: () => state.lastStatus?.phase === 'connected',
  })
}

async function disposeDispatcher() {
  const dispatcher = state.dispatcher
  state.dispatcher = null
  if (dispatcher) await dispatcher.dispose()
}

async function refreshStatus() {
  if (!state.manager) return
  try {
    const status = await state.manager.status(true)
    state.lastStatus = status
    state.routeTable = buildRouteTable(status.raw ?? {}, state.config?.acceptRoutes !== false)
    // Keep the dispatcher installed even while disconnected so tailnet
    // destinations fail closed rather than leaking to the phone's LAN.
    await ensureDispatcher()
    if (status.phase === 'connected') {
      state.lastError = ''
      applyShellProxy()
    } else {
      clearShellProxy()
    }
    if (status.phase === 'error' && status.error) state.lastError = status.error
  } catch (error) {
    state.lastError = redact(error?.message ?? error)
  }
}

async function startTailscale() {
  try {
    await state.manager.startDaemon()
    await refreshStatus()
  } catch (error) {
    state.lastError = redact(error?.message ?? error)
    await refreshStatus().catch(() => {})
  }
}

async function init() {
  if (state.initializing) return
  state.initializing = true
  try {
    await refreshStatus()
    if (state.config?.autoStart === true && state.manager?.hasBinary() && state.manager?.hasState()) {
      await startTailscale()
    }
  } finally {
    state.initializing = false
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (dshCtx) => {
    const config = loadConfig()
    state.config = config
    state.manager = new TailscaleManager(config, { root: ROOT })

    dshCtx.dshGo.strip('ts-status', (scope, emit, caps) => {
      const push = () => {
        const status = state.lastStatus
        const meta = phaseMeta(status)
        emit({ text: statusText(status, caps?.locale), icon: 'globe', tone: meta.tone })
      }
      push()
      const timer = setInterval(() => {
        void refreshStatus().then(push)
      }, 20_000)
      return () => clearInterval(timer)
    })

    dshCtx.dshGo.panel('tailscale', {
      view: () => makeView(),
      data: (scope, emit) => {
        let closed = false
        const push = () => {
          if (!closed) emit(buildSnapshot())
        }
        push()
        void refreshStatus().then(push)
        return () => {
          closed = true
        }
      },
      actions: {
        refresh: async () => {
          await refreshStatus()
          return { refresh: true }
        },
        start: async () => {
          void startTailscale()
          return { toast: '正在准备 Tailscale，请稍后刷新', refresh: true }
        },
        stop: async () => {
          try {
            await state.manager.stopDaemon()
            await refreshStatus()
            return { toast: 'Tailscale 已停止', refresh: true }
          } catch (error) {
            state.lastError = redact(error?.message ?? error)
            return { toast: '停止失败，请刷新查看', refresh: true }
          }
        },
        logout: async () => {
          try {
            await state.manager.logout()
            await refreshStatus()
            return { toast: '已退出 Tailscale', refresh: true }
          } catch (error) {
            state.lastError = redact(error?.message ?? error)
            return { toast: '退出失败，请刷新查看', refresh: true }
          }
        },
        'browser-login': async () => {
          return {
            pending: { label: '正在生成浏览器登录链接', timeoutMs: 20_000 },
            result: async () => {
              try {
                const result = await state.manager.beginBrowserLogin()
                state.lastStatus = result.status
                state.loginUrl = result.authUrl || ''
                if (result.alreadyConnected) {
                  await refreshStatus()
                  return { patch: buildSnapshot(), toast: '已经登录' }
                }
                return { patch: buildSnapshot(), toast: '登录链接已生成' }
              } catch (error) {
                state.lastError = redact(error?.message ?? error)
                return { patch: buildSnapshot(), toast: '生成登录链接失败' }
              }
            },
          }
        },
        'open-login': () => {
          const url = state.manager?.loginUrl || state.lastStatus?.authUrl || ''
          if (url === '') return { toast: '请先点“生成登录链接”' }
          if (!/^https:\/\//i.test(url)) return { toast: '登录链接不是 https 地址' }
          return { link: url }
        },
        'copy-login': () => {
          const url = state.manager?.loginUrl || state.lastStatus?.authUrl || ''
          if (url === '') return { toast: '请先点“生成登录链接”' }
          return { copy: url, toast: '登录链接已复制' }
        },
        login: (scope, event) => {
          const authKey = readField(event, 'authKey')
          if (authKey === '') return { toast: '请先填 Auth Key' }
          if (!state.manager.hasBinary()) {
            void startTailscale()
            return { toast: '正在准备 Tailscale，请稍后重新点登录', refresh: true }
          }
          return {
            pending: { label: 'Tailscale 登录中', timeoutMs: 60_000 },
            result: async () => {
              try {
                await state.manager.login(authKey)
                await refreshStatus()
                return { patch: buildSnapshot(), toast: 'Tailscale 已连接' }
              } catch (error) {
                state.lastError = redact(error?.message ?? error)
                return { patch: buildSnapshot(), toast: '登录失败，请查看状态' }
              }
            },
          }
        },
        'test-url': async (scope, event) => {
          const url = readField(event, 'testUrl')
          if (url === '') return { toast: '请先填测试 URL' }
          if (!/^https?:\/\//i.test(url)) return { toast: '只支持 http/https URL' }
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
            const text = await response.text()
            state.testResult = `${response.status} ${response.statusText} · ${text.slice(0, 300)}`
            return { patch: { testResult: state.testResult }, toast: `HTTP ${response.status}` }
          } catch (error) {
            state.testResult = `请求失败：${redact(error?.message ?? error)}`
            return { patch: { testResult: state.testResult }, toast: '请求失败' }
          }
        },
      },
    })

    if (typeof dshCtx.effect === 'function') {
      dshCtx.effect(() => () => {
        clearShellProxy()
        void disposeDispatcher()
        void state.manager?.dispose?.()
      }, 'local-tailscale: dispatcher and daemon')
    }

    void init()
  })
}

export function __test() {
  return {
    buildSnapshot,
    phaseMeta,
    readField,
  }
}

