# 2026-06-26 Fabric Browser Pairing Smoke

## Scope

验证 M2 Server Profile 解耦后的真实浏览器 onboarding：

- 启动隔离的临时 AIH server。
- 生成 `/v0/fabric/device-pair` invite。
- 用真实浏览器打开 `/ui/server-setup?pair=...`。
- 自动配对并保存 ready server profile。
- 点击 `进入工作台` 后不被 gate 拉回 setup 页面。

本轮不验证跨机器/手机网络，不验证 node/relay/native runtime session。

## Isolation Fix

第一次 smoke 暴露出一个数据隔离问题：临时 server 的 `aiHomeDir/hostHomeDir` 已指向临时目录，但 `/v0/node-rpc/device-sessions` 仍通过 `server.js` 的模块级 `getProjectsSnapshot` 扫描宿主项目快照，页面显示了宿主历史会话数量。

修复：

- `lib/server/server.js`：`startLocalServer` 支持 `deps.getProjectsSnapshot` 注入，默认仍使用生产实现。
- `scripts/fabric-browser-pairing-smoke-server.js`：smoke server 注入空项目快照，确保 onboarding 验证不读取宿主会话。
- `test/server-node-rpc-wiring.test.js`：新增 server wiring 测试，证明 device sessions 使用注入的 project snapshot loader。

## Commands

Focused server wiring test:

```bash
node --test test/server-node-rpc-wiring.test.js
```

Temporary smoke server:

```bash
node scripts/fabric-browser-pairing-smoke-server.js
```

Observed server output:

```text
SMOKE_ENDPOINT=http://127.0.0.1:57610
SMOKE_PAIR_URL=http://127.0.0.1:57610/v0/fabric/device-pair?code=<redacted>
SMOKE_WEB_PAIR_URL=http://127.0.0.1:57610/ui/server-setup?pair=<encoded-pair-url>
```

Browser automation:

```text
Open SMOKE_WEB_PAIR_URL with Playwright Chromium.
Wait for network idle.
Assert ready/profile/session state.
Click "进入工作台".
Assert final URL is /ui, not /ui/server-setup.
```

## Metrics

| metric | value | note |
|---|---:|---|
| Focused server wiring tests | pass | 4/4 pass |
| Auto-pair ready tag | pass | `1 READY` |
| Stored profile tag | pass | `1 PROFILES` |
| Session isolation | pass | profile detail shows `0 会话` |
| Host session leakage | pass | previous leaked `1112 会话` no longer appears |
| Enter workspace button | pass | enabled after pairing |
| Gate after enter | pass | click lands on `/ui`, not setup |
| Browser console errors/warnings | pass | none |

## Browser Result Shape

Before clicking `进入工作台`:

```json
{
  "zeroSessions": 1,
  "enterEnabled": true,
  "url": "http://127.0.0.1:57610/ui/server-setup?pair=<encoded-pair-url>"
}
```

After clicking:

```json
{
  "afterUrl": "http://127.0.0.1:57610/ui",
  "stillSetup": false,
  "hasDashboardText": true,
  "interestingConsole": []
}
```

Profile detail:

```text
0/0 节点在线 · 0 可调度账号 · 0 会话
```

## Interpretation

- Server Setup 的真实 browser auto-pair happy path 已跑通。
- First-run gate 没有把 ready profile 用户困在配置页。
- 临时 smoke 环境已证明不再读取宿主真实 session store。
- 这只证明 local browser onboarding；跨设备、弱网、relay、remote session runtime 仍未完成。

## Verdict

pass
