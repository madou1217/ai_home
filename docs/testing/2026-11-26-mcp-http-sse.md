# MCP HTTP / SSE 传输支持（2026-11-26）

## 范围

原生 MCP 安装从仅 stdio 扩展为：

- `stdio`：command / args / cwd / env；
- `http`：Streamable HTTP（JSON-RPC POST，可返回 JSON 或 SSE）；
- `sse`：旧版 SSE（GET 事件流 + endpoint + POST messages）。

CLI：

```bash
aih mcp add name --command npx --arg -y --arg @scope/server --provider claude
aih mcp add name --transport http --url https://example.com/mcp \
  --header "Authorization: Bearer ..." --provider claude
aih mcp add name --transport sse --url https://example.com/sse --provider gemini
```

WebUI：开发工具 → 插件与资源 → MCP → 安装资源 → 传输协议 `stdio / HTTP / SSE`。

## Provider 投影

格式按已安装 CLI 实际生成的文件验证：

| Provider | 格式 | 远端形状 |
| --- | --- | --- |
| Claude | `.claude.json` | `{type:"http"|"sse", url, headers}` |
| CodeBuddy / WorkBuddy | `.mcp.json` / `.codebuddy.json` | `{type:"http"|"sse", url, headers}` |
| Gemini | `settings.json` | `{url, type:"http"|"sse", headers}` |
| Codex | `config.toml` | `url` + `[mcp_servers.<id>.http_headers]`；**只支持 HTTP** |
| OpenCode | `opencode.json` | `mcp.servers.<id> = {type:"remote", url, headers}` |
| Cline | `cline_mcp_settings.json` | 远端暂未声明，返回 `mcp_transport_unsupported` |

OpenCode 原有投影写入的是 `mcp.<id>`，与当前 CLI 的 `mcp.servers.<id>` 不一致；
本次一并修正，读取/写入都使用嵌套 `servers`。

## 客户端

新增 `dialMCPClient`，按 `server.Transport` 选择：

- Streamable HTTP：POST JSON-RPC；支持 JSON 与 `text/event-stream` 响应；
  捕获并回传 `Mcp-Session-Id`；初始化后发送 `notifications/initialized`。
- 旧版 SSE：GET 事件流，处理 `endpoint` 事件并 POST 到消息端点；
  后台按 id 分发响应，支持服务端 ping。
- stdio 保持原实现。
- `mcp test/tools/call` 全部走同一接口。

## 验证

测试服务器：本地 Python MCP server（HTTP `/mcp`、SSE `/sse`），提供
`initialize`、`tools/list`、`tools/call(echo)`。

结果：

| 项 | HTTP | SSE |
| --- | --- | --- |
| `MCPTest` | ok，tools=[echo] | ok，tools=[echo] |
| `MCPTools` | 1 个工具 | 1 个工具 |
| `MCPCall` | `hello-http` | `hello-sse` |
| UI 安装 | Gemini 安装成功，测试返回 echo | 后端 API 安装/测试/移除通过 |
| 移除后配置 | entry 消失 | entry 消失 |

同时验证：

- 同一 `MCPAdd` 在 Claude/Codex/Gemini/CodeBuddy/WorkBuddy/OpenCode 生成的配置文件形状；
- Codex SSE 返回 `mcp_transport_unsupported`；
- Cline HTTP 返回 `mcp_transport_unsupported`；
- WebUI 真实安装 `ui-http-probe` 到 Gemini，API `mcp test` 返回
  `protocolVersion=2025-03-26`、`tools=[echo]`，随后 remove 清理。

## 边界

- 未实现远端 MCP 的 OAuth 交互；认证目前通过静态 `headers`。
- Codex 远端只支持 Streamable HTTP，不支持旧版 SSE。
- Cline 远端未声明；不猜测其配置格式。
- Kiro / Antigravity 等 `json-command` Provider 使用同一 JSON 形状，但未逐机验证远端运行。
- 账号注册表 MCP 仍是 stdio；HTTP/SSE 是 Provider 原生配置安装。

## 提交

`02d3fcf3 feat(mcp): support HTTP and SSE transports`
