// Optional live smoke test. Requires a real Tailscale Auth Key:
//   TAILSCALE_AUTH_KEY=tskey-auth-... node test/live.mjs
import { loadConfig } from '../lib/config.js'
import { TailscaleManager } from '../lib/tailscale.js'

const key = String(process.env.TAILSCALE_AUTH_KEY ?? '').trim()
if (key === '') {
  console.log('TAILSCALE_AUTH_KEY is not set; skipping live test')
  process.exit(0)
}

const manager = new TailscaleManager(loadConfig(), { root: new URL('..', import.meta.url).pathname })
try {
  await manager.ensureBinary()
  await manager.startDaemon()
  const status = await manager.login(key)
  console.log(JSON.stringify({
    phase: status.phase,
    host: status.self.hostName,
    ips: status.self.ips,
    peers: status.peers.length,
  }, null, 2))
} finally {
  await manager.dispose()
}
