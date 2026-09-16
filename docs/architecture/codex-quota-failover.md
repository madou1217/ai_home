# Codex：会话内额度耗尽后的账号接续

## 适用入口

本改动针对 Node 网关承接的 Codex Responses 请求。裸 `aih codex` 使用内置 server profile；
直连 OAuth、未经过该网关的客户端不在此处接管。WebSocket 的账号 pin 仍是初始偏好，
当前响应遇到明确额度错误后可以换到同 Provider 的可用账号。
HTTP 适配器的显式单账号过滤语义没有在本改动中改写；HTTP 池化请求复用既有尝试循环。

## 原始缺口

- WebSocket 只在建连时选号，此后原样透传额度错误，没有会话内换号。
- HTTP 流把 `response.created` 当作正式输出；后续即便正文尚未开始，额度拒绝也无法进入重试。
- Codex 额度错误可能包在 HTTP 200 SSE / WebSocket 事件里，不能仅按 HTTP 状态判断。

## 处理规则

只识别协议错误对象中的 `usage_limit_reached`、`insufficient_quota`、
`rate_limit_exceeded`、`quota_exceeded`，不按用户消息、回答或工具输出中的文字猜测。
额度不足不等于登录失效，不清除 Token，不切换全局默认账号。

`response.created` / `response.in_progress` / `response.queued` 的空输出元数据最多暂存
16 帧 / 64 KiB。首个正文、推理摘要、工具事件或其它非前导事件立即提交并保持实时流式输出。
一旦已有事件提交给客户端，本次响应不自动重放，避免重复输出或客户端工具副作用。

WebSocket 接续保持原客户端连接，仅更换失败的上游连接。每个被拒绝的响应分别记录已尝试账号；
按现有 `maxAttempts` 限制尝试次数（未配置时 3，最多 16），重连共享 30 秒拨号预算。
重新读取当前账号池，复用模型能力筛选与既有调度器，不放行已停用、已删除或模型冷却中的账号。
错误冷却按账号＋模型记录，优先采用上游重置提示，缺失时使用现有短限流冷却。
预热 `generate:false` 的完成不算模型推理成功，不能解除已知额度冷却。

## 上下文与工具结果

连接内保留一个有界的已完成响应检查点（默认上限 32 MiB）。
当增量输入引用该响应时，使用已观察到的输入、已完成输出和本次工具结果组成完整公开上下文。
只有出现额度拒绝才执行跨账号可移植性整理，正常请求不重复整理整段历史。

跨账号请求不携带旧 `previous_response_id`、旧输出 item id 或账户绑定的加密推理项；
保留消息、调用名称、参数、`call_id` 和已经执行完的工具结果。上游握手也不复用旧账号的
`x-codex-turn-state`。网关不执行工具、不模拟键盘、不生成额外的用户 `continue`。
后续增量请求继续使用新上游响应的检查点。

未知历史引用、孤立工具结果、opaque compaction、文件 ID 引用、后台/会话存储引用，
以及无法关联到单一响应的流水线请求，不猜测恢复。客户端取消/断开会取消重连并释放活动计数。
候选耗尽或预算用完时保留真正的终止错误，不伪造成功。

不修改登录凭据、默认账号或历史文件。更换上游不等于切换原生 App 的登录身份。
HTTP 的未知远程 `previous_response_id` 也没有通过本补丁建立持久化历史服务。

## 验证（2026-09-16）

基线：`12ad5ab251e489c3b3a850390992cdc6ecb93479`。
本地：macOS，Node v26.8.1；项目声明的 Node 22 CI 是独立验证环境。

- 177 项相关测试通过：真实 HTTP/SSE 与 WebSocket、模型冷却、候选删除、错误握手、
  上下文重建、终止错误、取消、二进制帧、预热、流水线和原有适配器回归。
- 原始源码的隔离快照运行新增核心案例：3 项均失败（会话内 WS 接续及 HTTP 两种响应协议），
  不是缺失依赖造成的失败。修复后相同案例通过。
- 真实已安装 Codex CLI 0.142.3 的隔离冒烟通过：临时 HOME/CODEX_HOME、临时工作区，
  模型流量全部由本地模拟上游提供。原生 CLI 实际采用 WebSocket，账号顺序
  first → first（额度拒绝）→ second；一条本地写文件工具调用只执行一次，原进程正常完成。
  没有使用真实账号令牌或消耗真实推理额度，没有启动用户的 GUI App。
- 本地完整 `npm test`：7239 项，7195 通过、1 失败、43 跳过、0 取消。
  唯一失败是已有的 pending OAuth 注册用例 `missing_stable_identity`；
  在未修改的基线独立运行同一用例也失败。本改动未删除或削弱该断言，不宣称全量全绿。
- 原生冒烟是显式启用的测试，默认套件跳过；这项测试已单独实际运行并通过。

复核命令：

```sh
node --test test/codex-response-recovery.test.js test/codex-quota-failover.test.js test/codex-responses-websocket.test.js test/server.codex-streaming.test.js test/server.codex-adapter.test.js test/upstream-failure-policy.test.js test/upstream-failure-policy-auth-fallback.test.js
AIH_NATIVE_CODEX_QUOTA_SMOKE=1 node --test test/codex-quota-native.test.js
npm test
```

## 代码边界与上线

- `codex-response-recovery.js` → 提交门控 / 有界检查点 → 共享安全重试条件 → 纯函数与大小边界测试。
- `codex-responses-session.js` → 每响应重试状态机 → 保持客户端、抛弃旧连接迟到事件 → 真实套接字和原生 CLI 冒烟。
- `codex-responses-websocket.js` / `server.js` → 组合现有选号与持久化状态回调 → 不重造账号系统 → 调度及传输回归。
- `codex-response-stream.js` / `upstream-failure-policy.js` → 复用既有请求尝试策略 → HTTP 前导帧不提前封死重试 → 双协议 SSE 回归。

未引入新依赖、数据库表、账号迁移或 Web UI 改动。已自检 SOLID/KISS/DRY/YAGNI；
无独立审查者，采用明确的 self-review。用户授权本任务的修复闭环和此前的提交推送要求。

更新后需要重启实际承接请求的 Node Server；已有进程缓存旧模块不会自动加载源码变更。
本次开发未强制重启正在运行的生产服务。已经返回失败的旧回合也不会被后台偷偷重开；
部署后在原会话继续，后续符合安全条件的额度拒绝由网关自动接续。
