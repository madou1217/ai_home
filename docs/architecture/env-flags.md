# 环境准入（公开环境变量，≤10）

> 生成命令：`npm run env:inventory -- --write`　生成时间：2026-10-17T11:20:27.678Z
> 公开变量 **10 / 10**（白名单：`lib/config/public-env.js`，测试守住上限）。
> 其余 `AIH_*` 都是**内部变量**（进程间身份/标记、实验开关、测试钩子），见 [`env-flags.internal.md`](./env-flags.internal.md)：不要写进部署脚本。

## 规则

1. **能进 `aih server config set …` 或 WebUI 的，就不要做环境变量**；env 只用于「配置还读不到」或容器编排的一次性注入。
2. **一个语义只用一个名字**；同义别名只允许一处解析（数据根目录见 `lib/runtime/aih-home.js`）。
3. **公开变量上限 10 个**：新增必须同时改 `lib/config/public-env.js`、重跑本命令，并在 PR 里说明为什么 config/WebUI 放不下；超过上限 `test/env-inventory.test.js` 直接红。
4. 调试/实验开关不进公开清单；确实需要长期保留的，先回答「能不能做成 server config 字段」。

## 公开变量（10 / 10）

| 变量 | 用途 | 默认 | 等价持久化入口（推荐） |
| --- | --- | --- | --- |
| `AIH_HOME_DIR` | 数据根目录（账号库、配置、会话注册表、日志）。容器 / 多实例部署改这里。 | ~/.ai_home | 无（定位 data root 必须在读配置之前） |
| `AIH_HOST_HOME` | 宿主真实家目录。在 provider 沙箱会话里启动 server/autostart 时必须钉住，否则会从投影目录装 launchd job。 | $HOME（沙箱会话里不要依赖） | 无（启动前就需要） |
| `AIH_SERVER_HOST` | 网关监听地址。容器里通常设 0.0.0.0（等价 --open-network，务必同时设 key）。 | 127.0.0.1 | `aih server config set --host <ip>`（推荐） |
| `AIH_SERVER_PORT` | 网关监听端口（HTTP/WS、WebUI、中转 TCP 分流与 UDP 侧共用）。 | 9527 | `aih server config set --port <n>`（推荐） |
| `AIH_SERVER_API_KEY` | 客户端调用 /v1 的 key（Bearer）。容器编排一次性注入时用；长期部署建议写进 server config。 | （空 = 不校验） | `aih server config set --client-key <key>` |
| `AIH_SERVER_MANAGEMENT_KEY` | 管理面 key（WebUI / 远程管理 / 中转服务）。 | （空 = 管理面关闭） | `aih server config set --management-key <key>` |
| `AIH_SERVER_PROXY_URL` | 上游请求出口代理（HTTP(S)）。 | （空 = 直连） | `aih server config set --proxy-url <url>` |
| `AIH_SERVER_NO_PROXY` | 不走代理的主机列表（逗号分隔，兼容标准 NO_PROXY 语义）。 | （空） | `aih server config set --no-proxy <hosts>` |
| `AIH_MULTIPLEXER` | 持久会话/后台运行使用的复用器（auto / tmux / herdr / off）。off = 关闭复用器直接前台运行（排障用）。 | auto | 无（CLI 运行时选择，不属于 server 配置） |
| `AIH_NO_PERSIST` | 交互式 CLI 的逃生门：=1 时不套 tmux/psmux，直接前台运行（排查卡死/嵌套会话时用）。 | （未设置 = 启用持久会话） | 无（一次性排障开关） |

## 内部变量

共 **52** 个（进程间传递的身份/标记、实验与调试开关、测试钩子）。按分类明细见 [`env-flags.internal.md`](./env-flags.internal.md)。

它们不是配置项：aih 自己会设置（例如账号投影、会话目标、网关连接串），手工覆盖通常会导致路由错乱或凭据串号。

