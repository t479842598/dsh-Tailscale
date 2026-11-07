# dsh-Tailscale

在 dsh-go 手机客户端里内嵌 Tailscale 网络节点，让 dsh 引擎直接使用真实的内网
`host:port` 地址访问供应商/API，不需要另外安装系统 VPN，也不需要把供应商地址改写成
`127.0.0.1` 的本地网关端口。

> 当前版本：**v1.0.0**  
> 适配：dsh-go App 1.0.12+ / DSH 0.2.2-rc.1 / Node 24 / Android arm64（proot）  
> 参考实现：[OpenMinis](https://github.com/OpenMinis/OpenMinis) 的内嵌 `tsnet` + 本地网络路由思路

---

## 1. 功能

- **两种 Tailscale 登录方式**
  - 数字 Key / Auth Key：粘贴 `tskey-auth-...` 或数字 Key，直接登录。
  - 浏览器登录并授权返回：生成 `login.tailscale.com` 登录链接，打开系统浏览器授权，返回 App 后刷新状态。
- **真实内网地址访问**：自定义模型渠道的 Base URL 直接填 `http://100.x.y.z:3000/v1` 或
  `http://TARGET:PORT/v1`，不使用本地网关端口。
- **按目的地分流**：只有发往 Tailscale/内网地址的 HTTP(S) 请求走 Tailscale，公网请求保持直连。
- **fail-closed**：Tailscale 断开时，发往内网地址的请求不会偷偷回落到手机本地网络。
- **dsh-go 原生面板**：登录、状态、节点列表、内网地址测试都在 App 原生界面里完成。
- **可选 Bash 代理变量**：配置 `shellProxy=true` 后，dsh 的 bash 工具可继承
  `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，方便 `curl`、`git` 等工具访问内网。
- **无第三方 Node 依赖**：使用 dsh 自带的 `undici` 与 Node 内置模块。

## 2. 工作原理

```text
dsh-go 设置 → 模型 → 添加渠道
  Base URL = http://100.64.0.12:3000/v1   ← 真实内网地址
        │
        ▼
dsh 引擎 Node 进程
  SplitDispatcher（undici）
        ├─ 目标是 Tailscale/内网地址 → ProxyAgent → 127.0.0.1:1056（内部）
        └─ 其他公网地址 → 原 dispatcher / 直连
        │
        ▼
tailscaled --tun=userspace-networking
  --socks5-server=127.0.0.1:1055
  --outbound-http-proxy-listen=127.0.0.1:1056
        │
        ▼
内网供应商：http://TARGET:PORT/v1
```

`127.0.0.1:1056` 只是 `tailscaled` 在本机内部的 HTTP front，不是用户访问端口，也不出现在
dsh 的供应商 Base URL 里。插件不会在 UI 里提供本地网关地址。

## 3. 环境要求

- dsh-go App **1.0.12+**（手机本机引擎）
- DSH **0.2.1-rc.2 ~ 0.2.x**
- Node **24+**（dsh-go 内置运行时满足）
- Android **arm64 / proot** 环境（插件也兼容 Linux x64/arm64 的 dsh 主机，但主要在 dsh-go 手机上使用）
- 不需要 Root，不需要 `/dev/net/tun`。插件使用 `tailscaled --tun=userspace-networking`。

## 4. 安装

### 4.1 从 GitHub 拉取后安装

```bash
git clone https://github.com/t479842598/dsh-Tailscale.git
cd dsh-Tailscale
P="$(pwd)"
dsh plugin --profile web add "$P"
```

安装完成后，如果 App 里没有立即出现「Tailscale 内网」面板，打开 App 的「引擎」页重启一次引擎。

### 4.2 从压缩包安装

1. 下载 `dsh-Tailscale-v1.0.0.zip`。
2. 解压到任意目录，例如 `/root/dsh-Tailscale`。
3. 执行：

```bash
dsh plugin --profile web add /root/dsh-Tailscale
```

4. 需要时在 App「引擎」页重启引擎。

### 4.3 首次启动会下载 Tailscale 二进制

插件目录下的 `bin/` 初始为空。第一次点「启动」或「用 Key 登录」时，插件会从
`https://pkgs.tailscale.com/stable/` 下载官方 `tailscale_1.104.5_arm64.tgz`，校验 SHA-256，
并解压 `tailscale` / `tailscaled` 到 `bin/`。下载失败时可以把官方二进制手动放到：

```text
$DSH_HOME/dsh-go/plugins/local-tailscale/bin/tailscale
$DSH_HOME/dsh-go/plugins/local-tailscale/bin/tailscaled
```

并确保可执行权限。

## 5. 使用

### 5.1 打开面板

dsh-go →「插件」页签或「全部功能」→ **Tailscale 内网**。

面板分为三个页签：

- **登录**：两种登录方式
- **状态**：设备名、Tailnet、Tailscale IP、节点列表
- **使用**：模型渠道配置说明和内网地址测试

### 5.2 方式一：数字 Key / Auth Key

1. 在 Tailscale 管理后台生成 Auth Key（建议使用 tagged、短期或可随时撤销的 Key）。
2. 在面板「登录」页签的「数字 Key / Auth Key」输入框粘贴 Key。
3. 点「用 Key 登录」。
4. 状态显示「已连接」后，展开「状态」页签确认 `100.x.y.z` 地址。

### 5.3 方式二：浏览器登录并授权返回

1. 在「登录」页签点「生成登录链接」。
2. 点「打开登录页」（或先点「复制登录链接」，在任意浏览器打开）。
3. 在浏览器完成 Tailscale / Google / Apple / GitHub / Microsoft 等登录授权。
4. 返回 dsh-go，点「刷新」；状态变成「已连接」即完成。

生成登录链接的过程在后台调用 `tailscale login`，插件从 `tailscale status --json` 的
`AuthURL` 取链接。登录链接是 bearer-like 的，请勿转发给他人。

### 5.4 配置内网模型供应商

在 dsh-go 设置里：

```text
设置 → 模型 → 添加渠道

兼容协议：OpenAI
Base URL：http://100.64.0.12:3000/v1
API Key：内网供应商的 Key
```

然后点「获取模型」，选择模型并保存。正常对话会使用 dsh 引擎的流式 HTTP 请求，经过
插件安装的 split dispatcher 自动路由到内网。

**不要**填写：

```text
http://127.0.0.1:3188/...
```

也不需要在供应商设置里填写任何“本地网关端口”。

### 5.5 测试内网地址

面板「使用」页签提供测试 URL 输入框，例如：

```text
http://100.x.y.z:3000/v1/models
```

点击「测试内网地址」会通过当前 Tailscale 路由发起请求，并显示 HTTP 状态及响应前 300 字。

## 6. 配置

配置文件路径：

```text
$DSH_HOME/dsh-go/plugins/local-tailscale/data/config.json
```

默认内容：

```json
{
  "version": 1,
  "hostname": "dsh-go-phone",
  "autoStart": true,
  "acceptRoutes": true,
  "tailscaleVersion": "1.104.5",
  "proxyFrontPort": 1056,
  "socksPort": 1055,
  "extraProxySuffixes": [],
  "shellProxy": false,
  "loginServer": ""
}
```

字段说明：

| 字段 | 默认 | 说明 |
|---|---|---|
| `hostname` | `dsh-go-phone` | Tailscale 管理后台显示的设备名 |
| `autoStart` | `true` | 引擎启动时如果已有登录状态，自动启动 daemon |
| `acceptRoutes` | `true` | 接受 tailnet 中宣告的 subnet routes |
| `tailscaleVersion` | `1.104.5` | 首次下载的版本；可在升级时修改 |
| `proxyFrontPort` | `1056` | **内部** tailscaled HTTP front，仅本机 loopback |
| `socksPort` | `1055` | **内部** tailscaled SOCKS5 front，仅本机 loopback |
| `extraProxySuffixes` | `[]` | 额外视为内网的主机名后缀，例如 `["corp.internal"]` |
| `shellProxy` | `false` | 是否为 dsh bash 子进程注入代理环境变量 |
| `loginServer` | `""` | 自建 Headscale 控制面地址；留空用 Tailscale 官方控制面 |

Auth Key 不会写入配置文件；登录后只有 `data/tailscaled.state` 里的 node key，权限为 `0600`。

## 7. 安全说明

- 插件只在 **dsh 引擎进程内**生效；引擎退出后路由停止。
- `tailscaled` 的 SOCKS5/HTTP front 只监听 `127.0.0.1`。
- tailnet 目标判定基于 `100.64.0.0/10`、`fd7a:115c:a1e0::/48`、peer IP、`PrimaryRoutes`
  和 MagicDNS 后缀；公网地址保持直连。
- Tailscale 断开时，发往内网目标的请求 fail-closed，不会回落到本地网络。
- 日志会对 `tskey-*` / `hskey-*` 做脱敏。
- 浏览器登录链接和 Auth Key 都不写入 `data/` 配置。

## 8. 开发与测试

```bash
# 语法检查
for f in lib/*.js test/*.mjs; do node --check "$f"; done

# 单元测试
node --test test/*.test.mjs

# dsh-go 插件检查器（本机安装的 dsh-go 环境）
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load --app 1.0.12
```

可选真实环境测试：

```bash
TAILSCALE_AUTH_KEY=tskey-auth-... node test/live.mjs
```

## 9. 已知限制

- 插件只路由 dsh 引擎内的 Node HTTP(S) 请求；dsh bash 中是否继承代理取决于 `shellProxy`
  配置和具体工具。
- 其他 Android App、系统浏览器或后台任务若要访问整个内网，请安装官方 Tailscale Android
  客户端；dsh-go 插件无法替代 Android `VpnService`。
- `tailscaled` 在 proot 中必须以 userspace networking 运行，不能使用内核 TUN。
- 首次下载 Tailscale 二进制需要网络访问 `pkgs.tailscale.com`；网络受限时可手动放二进制。
- 当前版本未在真实 Tailscale tailnet 上完成端到端供应商请求验证；`tailscaled` 启动和浏览器
  登录 URL 生成已验证。请在填入自己的 Auth Key 后做一次「测试内网地址」。

## 10. 目录结构

```text
dsh-Tailscale/
├── package.json
├── cordis.patch.yml
├── README.md
├── LICENSE
├── NOTICE
├── lib/
│   ├── index.js        # dshGo 面板与 actions
│   ├── config.js       # 配置与权限
│   ├── tailscale.js    # tailscaled / tailscale CLI 生命周期、两种登录
│   ├── tailnet.js      # tailnet 路由表与 host 匹配
│   └── dispatcher.js   # undici split dispatcher
├── test/
│   ├── config.test.mjs
│   ├── dispatcher.test.mjs
│   ├── tailnet.test.mjs
│   └── live.mjs
├── bin/                # 运行时下载，已 .gitignore
└── data/               # 配置/状态，已 .gitignore
```

## 11. 许可证与署名

本项目采用 **dsh-Tailscale Non-Commercial License 1.0**（源码公开，但不是 OSI 认证的开源许可证）：

- **不可商用**：不得将本项目或其主要部分用于商业目的。
- **署名要求**：使用、复制、修改、分发或二次开发时，必须保留版权与许可声明，并在产品或
  文档中显著标注：

  > dsh-Tailscale by t479842598 — https://github.com/t479842598/dsh-Tailscale

完整条款见 [LICENSE](LICENSE)，署名与第三方参考说明见 [NOTICE](NOTICE)。

如需商业授权，请通过 GitHub 联系 [t479842598](https://github.com/t479842598)。

## 12. 参考项目

本项目的网络架构参考了 OpenMinis 的内嵌 `tsnet` 和本地网络路由设计：

- <https://github.com/OpenMinis/OpenMinis>

本项目没有复制 OpenMinis 的源代码；实现是独立的 Node/dsh-go 插件。
