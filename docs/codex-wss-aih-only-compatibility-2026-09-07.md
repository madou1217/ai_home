# Codex WSS：AIH 侧兼容与客户端接入

日期：2026-09-07。范围仅 `ai_home`，不修改或部署 `llm_api`。

当日后续更新：因 App 再次出现 401，已完成统一连接配置、宿主接入、本机服务与 App 重启，以及指定原会话、裸 CLI、AIH CLI 的真实验收。详见 [401 根因与修复记录](codex-app-401-credential-binding-2026-09-07.md)。下文的入口表和后续顺序保留为 WSS 阶段的历史基线，不代表当前尚未接入。

## 原因和当前状态

上游支持 WSS，但其既有 WebSocket 路由为 `/v1/responses/ws`；Codex 按标准请求 `/v1/responses`。同认证下标准路径 404、别名 101 的原始证据证明是握手路由不兼容，不是安装损坏或 Nginx 不支持 Upgrade。

先前错误地修改、推送并部署了上游标准路由。用户要求撤销推送后，Git 已通过 `61efadd99ea8036b6a9090d37b200cb2263edc46` 回退；该 Git 动作没有恢复生产。后续不再操作上游仓库或部署。此前公网标准路径成功只能作为历史协议证据，不能用于证明本次 AIH 兼容。

本轮已完成 Node/Go 网关兼容实现和局部验证。运行中的本机服务、宿主 Codex 配置、桌面 Hook 没有因此自动更新；不能宣布 App/CLI 的现有会话已全局修复。

Codex 安装/更新仍首选：

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

无需为路由 404 重装，也不将通用 `base_url` 改成 `/responses/ws`。

## 网关兼容规则

1. 首先向所选账号的标准 `/responses` 发起 WebSocket Upgrade。
2. 仅握手 HTTP 404 时，尝试同协议、同主机、同账号的 `/responses/ws` 一次。
3. Node 两次尝试共享原握手超时预算；Go 复用调用方同一个 context，遵守其取消和截止时间。
4. 401、403、429、5xx、超时、连接错误及重定向不触发别名尝试；不增加账号切换。
5. Node 在上游连接成功后升级客户端；Go Host 保持既有先接收首帧、再选模型/账号的顺序，连接成功前不把缓存首帧发往上游。业务事件中的 404 不触发重连或重放。HTTP POST 路由保持原状。
6. 不缓存路径能力、不按域名写特例、不枚举更多路径。每次新连接最多尝试两个端点。

404 有时也可能用于隐藏鉴权失败，因此不能把所有 404 都诊断为路由缺失。这里的别名尝试仍使用相同认证，最终失败保持既有错误语义：Node 返回 502；Go 交给既有 Host 错误映射。

## WSS 阶段实际入口核对（接入前基线）

本轮只读核对宿主：`model_provider = "aih_server"`，但 provider `base_url` 和根级 `openai_base_url` 均指向公网。名字不等于实际经过网关。CLI Hook 启用，桌面 Hook 禁用；本机 9527 `/readyz` 为 ready，Codex 账号数 3。

| 入口 | 当前代码/运行状态 | 下一步接入要求 |
| --- | --- | --- |
| 原生 App | 桌面 Hook 禁用，宿主配置直连公网 | 先确定使用宿主配置接入或现有桌面运行时投影；不能假定 Hook 已生效 |
| App app-server 投影 | 现有 `buildCodexAppServerRuntimeConfig` 已支持本机 URL、网关 key 和 `X-Account-Ref` | 接入入口并让新 app-server 加载新配置后验收 |
| 裸 `codex` | 默认 CLI launcher 注入账号 key 和账号 URL，宿主 provider 仍公网 | URL、网关 key、账号 pin 必须作为同一连接配置切换，避免上游 key 被当作网关 key |
| `aih codex <账号>` | `codexRelayProfile.shouldRelayAccount` 恒 false，API-key 账号保持直连 | 复用 relay profile 扩展点接入账号绑定，保留 OAuth/login 及显式 provider 选择语义 |
| 恢复旧内建 `openai` 会话 | 依赖根级 `openai_base_url` 和原生认证，不能覆盖保留的 provider ID | 单独验证恢复后的 URL、认证和账号绑定；不能只改受管 provider 段 |

入口接入应抽取聚合 URL、认证和 accountRef 的连接配置，在 host-sync、CLI、App 投影之间复用。不能在各调用点仅替换 URL，也不能让旧 `.auth` helper 继续给本机 URL 返回上游账号 key。现有宿主 helper 优先透传 `OPENAI_API_KEY`，因此必须同时解决该优先级与网关 key 来源。

## 已完成验证

| 检查 | 结果与边界 |
| --- | --- |
| Node `node --test test/codex-responses-websocket.test.js test/websocket-support.test.js` | 17/17；其中 14 项真实 socket 测试，3 项旧常量断言 |
| Go `go test -race ./internal/adapters/codex/responseswebsocket ./internal/host/aihserver` | 两包通过，包含真实 TLS 上游仅别名可用、401/403/429/500/302 不重试及取消握手 |
| Go `go test -race ./internal/transport/http/codexresponsesws` | 通过；保留 Host 先读首帧、后选模型/账号的既有行为 |
| 帧和账号隔离 | Node 标准/别名均验证 pin、上游认证覆盖、协议头白名单、文本/二进制、关闭和活动计数；未知账号不换账号 |
| 多轮及工具帧 | 本地回显验证 `previous_response_id`/`function_call_output` 原样且仅发送一次；这项自身不证明模型语义 |
| CLI 与 App 随附运行时 | 隔离配置、标准路径强制 404、仅别名转公网的真实推理通过；见下方证据 |
| 现有 AIH 配置生成器 | 使用 `buildCodexAppServerRuntimeConfig` 生成隔离配置，官方 CLI、App binary 各一轮及 App app-server 两轮全部成功，均有 WSS 日志 |
| Node 全量 `npm test` | 6371 项，6362 通过、2 失败、7 跳过；失败为既有 CLI 路径和 node-rpc 账号断言，不描述为全绿 |

真实推理链为：官方 Codex binary → 临时 AIH 网关（加载本次 Node 模块）→ 临时别名限定入口（标准路径固定 404）→ 公网 `/responses/ws`。没有请求公网标准路径；没有修改宿主配置、默认账号或上游部署。

第一组证据：[report.json](/Users/model/.ai_home/backups/wss-alias-only-Xk6M75/report.json)。独立 CLI 与 App binary 各完成一轮随机标记回复，exit 0，日志确认 WebSocket；每条链均观测 404 → 101，TLS 1.3 校验通过，HTTP 请求为 0。该实验验证实际运行时通过兼容链推理，不等于已切换用户正在使用的 App UI 或 CLI Hook。

第二组证据：[report.json](/Users/model/.ai_home/backups/aih-alias-only-20260907-bQzEDO/report.json) 与同目录 `acceptance.cjs`。复用现有 App 运行时配置生成器，保持网关 client key 与上游 key 分离并设置账号 pin，完成 CLI、App binary 和 app-server 共四轮随机标记回复。三次标准路径请求全部在临时入口返回 404，三次别名请求转到公网既有 `/responses/ws`；远端 TLS 校验通过，HTTP 请求为 0。该测试没有请求公网标准路径。

第二组首次脚本运行因 `exec` 子进程 stdin 保持打开而等待输入，150 秒观察超时；当时握手和 HTTP 请求均为 0。补上 `child.stdin.end()` 后重新运行通过。失败证据保留于 `/Users/model/.ai_home/backups/aih-alias-only-20260907-E3PrGv`，不是一次成功网络验收。

全量测试日志：`/tmp/aih-wss-alias-full-test.log`。对两个失败文件单独复跑为 84 项、82 通过、2 失败，见 `/tmp/aih-wss-alias-existing-failures.log`。本轮没有改动这两个文件或修补无关功能。

只读导出 HEAD 到临时目录、复用已安装依赖后，同两个文件为 84 项、83 通过、1 失败（CLI 路径）；node-rpc 在干净 HEAD 通过，在共享 dirty 工作区失败。因此 CLI 路径属于宿主环境基线，node-rpc 差异属于当前工作区状态，不能把全量失败一概归于环境。基线日志：`/tmp/aih-wss-alias-baseline-failures.log`。

再只向该 HEAD 导出目录应用本次 Node WS 模块和测试，运行上述两个文件及 WSS 两个文件：101 项、100 通过、1 失败，仍仅原有 CLI 路径断言失败；node-rpc 和全部 WSS 检查通过。日志：`/tmp/aih-wss-alias-scoped-baseline.log`。未创建分支/worktree，未改动真实工作区的其他任务内容。

## 接入前制定的实施顺序与验收门槛

1. 完成统一连接配置与认证来源，再改 host-sync、CLI relay 和 App 入口的必要调用点；不动无关 dirty 文件内容。
2. 在隔离 HOME 验证默认账号、两个指定账号、OAuth/login、显式 provider、旧 `openai` 会话恢复；检查配置幂等性、Windows 参数边界和账号不串用。
3. 备份真实宿主配置后应用已验证配置，以真实 HOME 重启本机服务并重新启动受影响的 App app-server。
4. 对 App UI、新旧会话、裸 CLI 和 `aih codex <账号>` 验收首轮、多轮、工具、重连和原 HTTP 路径。原会话未完成此验收前不宣称全局闭环。
5. 记录完整验证，再按用户明确要求做范围受控的提交/推送。

## 设计模式与原则

| 文件/模块 | 模式 | 用途 | 验证证据 |
| --- | --- | --- | --- |
| `lib/server/codex-responses-websocket.js` | 传输适配器、依赖注入 | 在握手边界集中处理一次别名兼容，复用账号选择和帧转发 | Node socket tests、隔离官方运行时真实推理 |
| `internal/adapters/codex/responseswebsocket/dialer.go` | 现有 Dialer 适配器 | 相同认证和 context 下适配非标准 WS 入口 | Go TLS tests、race、Host tests |

SOLID：端点兼容留在传输适配器内，不侵入模型执行或账号路由。KISS：仅一条有明确证据的别名。DRY：每个运行时复用既有认证投影及帧转发。YAGNI：不添加路径缓存、域名规则、通用重试框架或额外配置产品。
