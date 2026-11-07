# Changelog

## v1.0.0 — 2026-11-07

首次正式发布。

- 新增 dsh-go 原生插件 `local-tailscale`。
- 使用 `tailscaled --tun=userspace-networking`，无需 Root、无需 `/dev/net/tun`。
- 新增数字 Key / Auth Key 登录。
- 新增浏览器登录并授权返回：生成 `login.tailscale.com` 链接、打开登录页、授权后刷新状态。
- 新增按目标地址分流的 `undici` split dispatcher：内网/Tailscale 地址走 tailnet，公网保持直连。
- Tailscale 断开时对 tailnet 目标 fail-closed，避免回落直连。
- 新增 dsh-go 原生面板：登录、状态、节点列表、测试内网 URL。
- 支持 `loginServer`（Headscale）。
- 支持可选 `shellProxy` 给 dsh bash 子进程注入 HTTP/SOCKS 代理变量。
