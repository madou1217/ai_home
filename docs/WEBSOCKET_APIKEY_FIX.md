# WebSocket 代理 - API Key 模式支持

## 问题

用户报告的 BUG:

> 上游 WebSocket 端点: `wss://chatgpt.com/backend-api/codex/responses`
> 我们如果走的 API Key (这个可能是中转服务啊 你直接使用官方的 这里肯定会出问题的)

**核心问题**: WebSocket 代理直接使用官方 ChatGPT 端点，但 API Key 模式下应该使用用户配置的中转服务器。

## 原因分析

**之前的错误实现**:

```javascript
// ❌ 错误: 所有账号都使用同一个上游端点
const codexBaseUrl = String(options.codexBaseUrl || '').trim().replace(/\/+$/, '');
const upstreamUrl = codexBaseUrl.replace(/^https?:/, 'wss:') + '/responses';
// 结果: wss://chatgpt.com/backend-api/codex/responses
```

**问题**:
- OAuth 模式账号 → 连接到官方 ChatGPT ✅ (正确)
- API Key 模式账号 → 也连接到官方 ChatGPT ❌ (错误，应该连接中转服务器)

## 解决方案

### 1. 账号加载时读取 API Key 配置

**修改文件**: `lib/server/accounts.js`

```javascript
function loadCodexServerAccounts(deps) {
  // ...
  ids.forEach((id) => {
    const profileDir = getProfileDir('codex', id);
    const authPath = path.join(getToolConfigDir('codex', id), 'auth.json');
    const authJson = parseJsonFileSafe(authPath, fs);

    // ✅ 读取 API Key 模式的环境变量配置
    const envPath = path.join(profileDir, '.aih_env.json');
    const envData = parseJsonFileSafe(envPath, fs);
    const openaiBaseUrl = envData && envData.OPENAI_BASE_URL
      ? String(envData.OPENAI_BASE_URL).trim()
      : '';

    out.push({
      id: String(id),
      email,
      accessToken: '...',
      // ... 其他字段
      openaiBaseUrl  // ✅ API Key 模式的 base URL (中转服务器)
    });
  });
}
```

**配置文件路径**:
- OAuth 模式: 无 `.aih_env.json` → `account.openaiBaseUrl` 为空
- API Key 模式: `~/.ai_home/profiles/codex/{id}/.aih_env.json` → 包含 `OPENAI_BASE_URL`

### 2. WebSocket 代理根据账号类型选择端点

**修改文件**: `lib/server/server.js`

```javascript
server.on('upgrade', async (req, socket, head) => {
  // 选择可用账号
  const account = chooseServerAccount(pool, state.cursors, 'codex', {...});

  // ✅ 构建上游 WebSocket URL
  // - API Key 模式: 使用账号配置的 openai_base_url (中转服务器)
  // - OAuth 模式: 使用默认的 codexBaseUrl (官方 ChatGPT API)
  let upstreamBaseUrl = String(options.codexBaseUrl || '').trim().replace(/\/+$/, '');

  // 检查账号是否使用 API Key 模式 (有 openaiBaseUrl 配置)
  if (account.openaiBaseUrl && String(account.openaiBaseUrl).trim()) {
    upstreamBaseUrl = String(account.openaiBaseUrl).trim().replace(/\/+$/, '');
    if (options.verbose || options.debug) {
      console.log(`[aih:ws] Account ${account.id} uses API Key mode with base URL: ${upstreamBaseUrl}`);
    }
  }

  const upstreamUrl = upstreamBaseUrl.replace(/^https?:/, 'wss:') + '/responses';
  // OAuth 模式: wss://chatgpt.com/backend-api/codex/responses
  // API Key 模式: wss://localhost:8317/v1/responses (中转服务器)

  // 创建上游连接
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      'Authorization': `Bearer ${account.accessToken}`,
      'User-Agent': req.headers['user-agent'] || 'aih-proxy'
    }
  });

  // 双向转发...
});
```

## 工作流程

### OAuth 模式账号

```
客户端 Codex
    ↓ ws://localhost:8317/v1/responses
aih 服务器 (代理)
    ├─ 选择账号 (OAuth 模式, openaiBaseUrl 为空)
    ├─ upstreamUrl = wss://chatgpt.com/backend-api/codex/responses
    └─ 连接官方 ChatGPT WebSocket
    ↓
官方 ChatGPT API
```

### API Key 模式账号

```
客户端 Codex
    ↓ ws://localhost:8317/v1/responses
aih 服务器 (代理)
    ├─ 选择账号 (API Key 模式, openaiBaseUrl = http://localhost:9000/v1)
    ├─ upstreamUrl = wss://localhost:9000/v1/responses
    └─ 连接中转服务器 WebSocket
    ↓
中转服务器 (例如: 本地部署的 OpenAI 兼容服务)
```

## 调试

### 启用调试日志

```bash
# 启动 aih 服务器时启用调试
aih server --verbose
```

**输出示例**:

```
[aih:ws] Account 10 uses API Key mode with base URL: http://localhost:9000/v1
[aih:ws] Client 127.0.0.1 -> upstream wss://localhost:9000/v1/responses (account 10)
[aih:ws] WebSocket relay established (request_id: a1b2c3d4)
```

### 验证账号配置

```bash
# 检查账号是否配置了 API Key
cat ~/.ai_home/profiles/codex/10/.aih_env.json
```

**期望内容** (API Key 模式):
```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_BASE_URL": "http://localhost:9000/v1"
}
```

**如果文件不存在或为空** → OAuth 模式

## 测试

### 场景 1: API Key 模式连接中转服务器

```bash
# 1. 配置 API Key 账号
export OPENAI_API_KEY=sk-test
export OPENAI_BASE_URL=http://localhost:9000/v1
aih codex 10

# 2. 启动 aih 服务器
aih server --verbose

# 3. 客户端连接
codex  # 使用 aih 服务器作为代理
```

**期望**:
- ✅ WebSocket 连接到 `wss://localhost:9000/v1/responses`
- ✅ 不会尝试连接官方 ChatGPT
- ✅ 调试日志显示 "Account 10 uses API Key mode"

### 场景 2: OAuth 模式连接官方 ChatGPT

```bash
# 1. OAuth 登录
aih codex login

# 2. 启动 aih 服务器
aih server --verbose

# 3. 客户端连接
codex
```

**期望**:
- ✅ WebSocket 连接到 `wss://chatgpt.com/backend-api/codex/responses`
- ✅ 使用 OAuth access token 认证

## 相关文件

- **账号加载**: `lib/server/accounts.js` (loadCodexServerAccounts)
- **WebSocket 代理**: `lib/server/server.js` (server.on('upgrade'))
- **文档**: `docs/WEBSOCKET_PROXY_DESIGN.md`

## 总结

修复后的 WebSocket 代理能够:

1. ✅ **自动检测账号类型** (OAuth vs API Key)
2. ✅ **OAuth 模式** → 连接官方 ChatGPT WebSocket
3. ✅ **API Key 模式** → 连接用户配置的中转服务器 WebSocket
4. ✅ **双向消息转发** → 完全透明的代理
5. ✅ **调试支持** → 详细的日志记录

这样用户无论使用哪种模式，WebSocket 都能正常工作！
