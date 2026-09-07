# WSS 可行性真实验证

验证时间：2026-09-07 15:22–15:24（Asia/Shanghai）。

**历史结论：该时间窗口内，公网入口及 AIH 转发链完成 12 轮 Responses WebSocket 模型响应，全部成功。**

这些测试发生在此前误改上游标准路由之后。用户随后要求撤销 `llm_api` 推送；Git 已回退，生产没有在本轮回退。本页证明 WSS 协议可行，但不能证明 AIH 能兼容仅开放 `/responses/ws` 的上游，也不代表 App/CLI 的当前入口已接入兼容链。

独立于上游标准路由的后续验证及待办见 [AIH 侧兼容与接入方案](codex-wss-aih-only-compatibility-2026-09-07.md)。

## 验证对象和方法

- 公网：`wss://www.yeslaoban.com/llm/api/v1/responses`。
- 本机：`ws://127.0.0.1:9527/v1/responses`，使用 `X-Account-Ref` 钉住 Codex 账号 1，由 AIH 转发到公网 WSS。
- App：运行 App 随附的 `codex app-server`，执行真实 `thread/start` 和两次 `turn/start`；使用隔离 CODEX_HOME，不修改原始会话。
- 模型：`gpt-6-astra`。
- 网络探针只有 WebSocket 客户端，没有 HTTP POST/SSE fallback；开启 TLS 证书校验，不跟随重定向。
- 仅发送诊断短句和无外部副作用的常量工具结果，不发送已有会话历史。认证在内存读取，证据不包含密钥。

## 实测结果

| 项目 | 公网直连 | 经本机 AIH |
| --- | --- | --- |
| 标准路径 Upgrade | 101 | 101 |
| TLS | TLS 1.3，证书校验通过 | 本机段 WS；AIH 到远端为 WSS |
| 首轮创建 | completed | completed |
| 随机口令跨轮回忆 | 精确匹配 | 精确匹配 |
| Function tool 调用 | 收到真实 function_call | 收到真实 function_call |
| 随机工具结果回传 | 精确匹配，completed | 精确匹配，completed |
| 强制断开、重连、新建一轮 | 101 + completed | 101 + completed |
| JSON 消息帧 | 全部文本帧 | 全部文本帧 |
| 无效 key | 401 | 401 |
| 兼容 `/responses/ws` | 101，TLS 校验通过 | 不适用 |

多轮验证没有重复提供答案：第一轮生成随机 `CTX_…`，让模型记住并只回复 `STORED`；第二轮只提交 `previous_response_id` 和“返回刚才口令”。两条链路都准确返回第一轮值，证明了上下文延续。

工具验证先取得真实 `function_call.call_id`，再生成此前没有出现过的随机 `TOOL_…`，通过 `function_call_output` 回传。两条链路均准确返回该值，证明工具结果被模型收到。

App 实际 app-server 两轮分别回复 `APP_SERVER_WSS_OK` 与 `APP_SERVER_CONTINUE_OK`。日志记录一次 WebSocket 建立成功，`transport="responses_websocket"`；所选调试日志无 404 或 HTTP fallback 记录。本次没有进行 App UI 点击验收。

## 时间数据

下面是本次单次观察值，未做同负载 A/B 对照，不能据此断言 WSS 比 HTTP 更快。

| 场景 | 公网完成时间 | 经 AIH 完成时间 |
| --- | --- | --- |
| 首轮写入口令 | 6.115s | 13.932s |
| 跨轮回忆口令 | 4.381s | 17.315s |
| 工具调用 | 4.725s | 5.977s |
| 工具结果回传 | 4.275s | 17.205s |
| 断开后重连并新建一轮 | 3.700s | 3.261s |

公网 Ping/Pong RTT 为 220ms。本机 Ping/Pong 由本机 WS 服务响应，不能当作到模型上游的 RTT。首个 JSON 帧可能是额度或元数据，未将它误报为首个答案 token。

## 运行状态与结论边界

生产 `llm_api.service` 实测 active，PID 893966，部署文件 SHA-256：

`9a20eb546014a64ab9007b962045824e2afc5647f3fab7e7ed5ec4f1be35a7d8`

本次证明当前 WSS 实际可用，覆盖上下文续接、工具闭环和重新连接，之前的标准入口 404 未复现。

未覆盖小时级长连接、高并发、断线后以旧 `previous_response_id` 跨连接续接、所有账号/模型，以及 App 界面操作。不据此宣称无限稳定性或所有协议功能等价。

本次未修改业务源码、生产部署、配置或账号数据，只运行验收并写证据文档。没有引入业务设计模式；按 KISS/YAGNI 将验证与实现分离。

## 可复核证据

- [公网完整结果](/Users/model/.ai_home/backups/wss-feasibility-20260907T072216Z/public.json)：握手、TLS、request ID、每轮请求/事件/耗时及结果。
- [AIH 转发完整结果](/Users/model/.ai_home/backups/wss-feasibility-20260907T072216Z/gateway.json)。
- [App 实际运行时结果](/Users/model/.ai_home/backups/wss-feasibility-20260907T072216Z/app-server-acceptance.json)。
- [App WSS 日志](/Users/model/.ai_home/backups/wss-feasibility-20260907T072216Z/native-runtime/app-server/stderr.log)。
- [探针源码](/Users/model/.ai_home/backups/wss-feasibility-20260907T072216Z/wss-feasibility.cjs)：没有 HTTP fallback 分支。
- [此前根因和部署记录](codex-responses-websocket-404-analysis-2026-09-07.md)。
