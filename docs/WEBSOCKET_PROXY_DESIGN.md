# WebSocket 代理设计

## 问题分析

### 当前问题

用户报告:
```
Reconnecting... 4/5 (4s • esc to interrupt)
└ Unexpected status 405 Method Not Allowed: {"detail":"Method Not Allowed"},
url: ws://localhost:8317/v1/responses
```

然后 50 多秒后触发账号切换。

### 根本原因

当前实现只是**接受 WebSocket 连接**,但没有:
1. 连接到上游 Codex 服务器的 WebSocket
2. 在客户端和上游之间转发消息

## 参考实现

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 `wsrelay` 模块实现了完整的 WebSocket 代理:

### 核心组件

1. **Session** (`session.go`)
   - 管理单个 WebSocket 连接
   - 请求-响应映射 (ID -> pendingRequest channel)
   - 心跳保活 (每30秒发送 Ping)
   - 超时控制 (读60s, 写10s)

2. **Manager** (`manager.go`)
   - 管理多个 WebSocket 会话
   - 处理 HTTP 升级到 WebSocket
   - 提供商(provider)管理
   - 请求转发 (`Send` 方法)

### 消息流程

```
客户端 (Codex CLI)
    ↓
    WebSocket 连接 ws://localhost:8317/v1/responses
    ↓
aih 服务器 (代理)
    ├─ 选择可用账号
    ├─ 创建到上游的 WebSocket 连接 (wss://api.codex.com/...)
    └─ 双向转发消息
    ↓
上游 Codex 服务器
```

## 设计方案

### 方案 1: 完整 WebSocket 代理 (推荐)

**实现要点**:
1. 接收客户端 WebSocket 连接
2. 选择可用的 Codex 账号
3. 使用账号的 access_token 创建到上游的 WebSocket 连接
4. 双向转发所有消息
5. 处理心跳、超时和错误

**优点**:
- 完整支持 WebSocket 特性
- 性能更好 (实时双向通信)
- 与 Codex 的最佳实践一致

**缺点**:
- 实现复杂度较高
- 需要处理连接管理、消息路由等

### 方案 2: HTTP/SSE 降级 (当前状态)

**实现**:
- 不支持 WebSocket
- Codex 自动降级到 HTTP/SSE

**优点**:
- 实现简单
- 功能可用

**缺点**:
- 每次启动都会尝试 WebSocket 并失败 (显示 "Reconnecting")
- 延迟较高
- 用户体验不佳

## 实现计划

### 阶段 1: 基础 WebSocket 代理

1. **修改服务器 upgrade 处理**:
   ```javascript
   server.on('upgrade', async (req, socket, head) => {
     // 1. 选择可用账号
     const account = chooseServerAccount(...);

     // 2. 创建到上游的 WebSocket
     const upstream = new WebSocket('wss://api.codex.com/v1/responses', {
       headers: {
         'Authorization': `Bearer ${account.accessToken}`
       }
     });

     // 3. 升级客户端连接
     wss.handleUpgrade(req, socket, head, (client) => {
       // 4. 双向转发
       client.on('message', (data) => upstream.send(data));
       upstream.on('message', (data) => client.send(data));

       // 5. 错误处理
       client.on('error', () => upstream.close());
       upstream.on('error', () => client.close());
     });
   });
   ```

2. **账号选择逻辑**:
   - 复用现有的 `chooseServerAccount` 函数
   - 支持会话绑定 (同一会话使用同一账号)

3. **连接管理**:
   - 心跳保活
   - 超时重连
   - 优雅关闭

### 阶段 2: 高级特性

1. **会话管理**:
   - 会话 ID 映射
   - 多个客户端连接

2. **消息路由**:
   - 请求-响应匹配
   - 流式消息处理

3. **监控与日志**:
   - 连接统计
   - 错误追踪

## 关键问题

### Q1: Codex 上游 WebSocket 端点是什么?

**已确认**:

1. **OAuth 模式**: `wss://chatgpt.com/backend-api/codex/responses`
2. **API Key 模式**: 使用账号配置的 `openai_base_url` (中转服务器)

**实现方式**:
```javascript
// 从账号配置读取 openaiBaseUrl
const envPath = path.join(profileDir, '.aih_env.json');
const envData = parseJsonFileSafe(envPath, fs);
const openaiBaseUrl = envData && envData.OPENAI_BASE_URL ? String(envData.OPENAI_BASE_URL).trim() : '';

// 账号对象包含 openaiBaseUrl 字段
account = {
  id: '10',
  accessToken: '...',
  openaiBaseUrl: 'http://localhost:8317/v1'  // API Key 模式
};

// WebSocket 代理选择上游端点
let upstreamBaseUrl = options.codexBaseUrl;  // 默认: 官方 ChatGPT API
if (account.openaiBaseUrl) {
  upstreamBaseUrl = account.openaiBaseUrl;   // API Key 模式: 使用中转服务器
}
const upstreamUrl = upstreamBaseUrl.replace(/^https?:/, 'wss:') + '/responses';
```

### Q2: 是否需要会话保持?

**问题**: 多个请求是否需要使用同一个 WebSocket 连接?

**影响**:
- 如果需要会话保持,需要实现会话 ID 映射
- 如果不需要,每个请求可以使用独立连接

### Q3: 账号轮换策略

**问题**: WebSocket 连接失败或超时时,是否切换账号?

**策略**:
- 连接失败: 尝试下一个账号
- 运行中错误: 根据错误类型决定是否切换

## 下一步

1. **确认 Codex 上游 WebSocket 端点**
2. **实现基础 WebSocket 代理**
3. **测试与优化**

---

**参考资料**:
- [CLIProxyAPI wsrelay 模块](https://github.com/router-for-me/CLIProxyAPI/tree/main/internal/wsrelay)
- [Node.js ws 库文档](https://github.com/websockets/ws)
