# Token 自动刷新功能说明

## 📋 概述

从本版本开始，`aih serve` 启动的后台服务器会自动维护所有 OAuth 账号的 access token，无需依赖账号使用或手动刷新。

## ✨ 核心特性

### 1. **自动刷新机制**
- ✅ **启动时刷新**：Server 启动时立即检查并刷新即将过期的 token（提前 5 分钟）
- ✅ **后台定时刷新**：每 10 分钟自动检查所有账号，提前 30 分钟刷新即将过期的 token
- ✅ **独立运行**：不依赖账号是否被使用，即使长时间不调用 API 也会自动维护

### 2. **支持的 Provider**
| Provider | 刷新支持 | 配置文件 |
|----------|---------|---------|
| **Codex** | ✅ | `~/.codex/auth.json` |
| **Gemini (OAuth)** | ✅ | `~/.gemini/oauth_creds.json` |
| **Claude (OAuth)** | ✅ | `~/.claude/.credentials.json` |

### 3. **智能刷新策略**
- **防抖机制**：同一账号 30 秒内只刷新一次
- **并发刷新**：支持多账号并行刷新，提升效率
- **失败重试**：请求失败（401/403）时自动强制刷新

## 🚀 使用方法

### 基础用法

```bash
# 启动 Server（自动启用 Token 刷新）
aih serve

# 启动后会看到类似日志（如果启用了 verbose 模式）
# [aih:token-refresh] Token refresh daemon tick #1 completed in 120ms (accounts: 15, refreshed: 3, errors: 0)
```

### 配置选项

可以通过环境变量或启动参数自定义刷新行为：

```bash
# 自定义刷新间隔（默认 10 分钟）
aih serve --token-refresh-interval-ms 300000  # 5 分钟

# 自定义提前刷新时间（默认 30 分钟）
aih serve --token-refresh-before-expiry-ms 600000  # 10 分钟

# 启用详细日志
aih serve --verbose
# 或
aih serve --debug
```

### 环境变量

```bash
# 在 server 配置文件中设置
{
  "tokenRefreshIntervalMs": 600000,          // 刷新检查间隔（毫秒）
  "tokenRefreshBeforeExpiryMs": 1800000,     // 提前刷新时间（毫秒）
  "tokenStartupRefreshBeforeExpiryMs": 300000 // 启动时提前刷新（毫秒）
}
```

## 📊 监控和日志

### 启用详细日志

```bash
aih serve --verbose
```

日志示例：
```
[aih:token-refresh] Token refresh daemon started (interval: 600000ms, skew: 1800000ms)
[aih:token-refresh] Token refreshed for codex#1 (expires: 2026-04-07T10:30:00.000Z) persisted=true
[aih:token-refresh] Token refresh daemon tick #1 completed in 345ms (accounts: 15, refreshed: 3, errors: 0)
```

### 错误处理

刷新失败时会输出警告日志：
```
[aih:token-refresh] Token refresh failed for gemini#2: refresh_http_401 {"error":"invalid_grant"}
```

常见错误原因：
- `missing_refresh_token`：账号未配置 refresh token（API Key 模式不需要刷新）
- `refresh_http_401`：Refresh token 已过期，需要重新登录
- `refresh_http_403`：权限不足或账号被封禁
- `not_oauth`：非 OAuth 账号（如 API Key）不支持刷新

## 🔧 技术实现

### 架构设计

```
┌─────────────────────────────────────────┐
│         aih serve (server.js)          │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  Token Refresh Daemon             │ │
│  │  ┌─────────────┬─────────────┐   │ │
│  │  │  Startup    │  Periodic   │   │ │
│  │  │  Refresh    │  Refresh    │   │ │
│  │  │  (5 min)    │  (30 min)   │   │ │
│  │  └──────┬──────┴──────┬──────┘   │ │
│  │         │             │           │ │
│  │         v             v           │ │
│  │  ┌──────────────────────────┐    │ │
│  │  │  refreshAccountToken()   │    │ │
│  │  └────┬─────┬─────┬──────┘      │ │
│  │       │     │     │              │ │
│  └───────│─────│─────│──────────────┘ │
│          v     v     v                 │
│  ┌──────────┬──────────┬──────────┐  │
│  │ Codex    │ Gemini   │ Claude   │  │
│  │ Refresh  │ Refresh  │ Refresh  │  │
│  └────┬─────┴────┬─────┴────┬─────┘  │
│       │          │          │         │
│       v          v          v         │
│  ┌─────────────────────────────────┐ │
│  │  Persist to Config Files        │ │
│  │  - auth.json                    │ │
│  │  - oauth_creds.json             │ │
│  │  - .credentials.json            │ │
│  └─────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 代码模块

| 模块 | 文件路径 | 功能 |
|------|---------|------|
| Codex 刷新 | `lib/server/codex-token-refresh.js` | OpenAI OAuth token 刷新 |
| Gemini 刷新 | `lib/server/gemini-token-refresh.js` | Google OAuth token 刷新 |
| Claude 刷新 | `lib/server/claude-token-refresh.js` | Claude OAuth token 刷新 |
| 守护进程 | `lib/server/token-refresh-daemon.js` | 统一调度和管理 |
| 测试 | `test/server.token-refresh-daemon.test.js` | 单元测试 |

## 🐛 故障排查

### 问题：Token 一直提示过期

**原因**：Refresh token 本身已失效

**解决方案**：
```bash
# 重新登录账号
aih codex 1 login
aih gemini 1 login
aih claude 1 login

# 重启 server
aih server restart
```

### 问题：刷新日志显示 `not_oauth`

**原因**：该账号使用的是 API Key，不是 OAuth 模式

**说明**：API Key 账号不需要刷新，可以忽略此警告

### 问题：启用 verbose 后看不到刷新日志

**原因**：所有账号的 token 都还很健康，不需要刷新

**验证方法**：
```bash
# 查看账号的 token 过期时间
aih codex 1 usage
aih gemini 1 usage
aih claude 1 usage
```

## 📝 最佳实践

### 1. **推荐配置**

生产环境推荐配置：
```json
{
  "tokenRefreshIntervalMs": 300000,        // 5 分钟检查一次
  "tokenRefreshBeforeExpiryMs": 600000,    // 提前 10 分钟刷新
  "verbose": false                         // 生产环境关闭详细日志
}
```

开发环境推荐配置：
```json
{
  "tokenRefreshIntervalMs": 60000,         // 1 分钟检查一次（快速测试）
  "tokenRefreshBeforeExpiryMs": 300000,    // 提前 5 分钟刷新
  "verbose": true                          // 查看详细刷新日志
}
```

### 2. **监控建议**

定期检查刷新状态：
```bash
# 查看 server 日志
tail -f ~/.ai_home/logs/server.log | grep token-refresh

# 检查账号健康度
aih codex usages
aih gemini usages
aih claude usages
```

### 3. **安全建议**

- ✅ 确保配置文件权限安全（仅当前用户可读写）
- ✅ 定期检查账号状态，及时发现异常
- ✅ 重要账号建议手动备份 refresh token

## 🎯 常见场景

### 场景 1：长时间运行的 Server

适用于 7x24 运行的后台服务：
```bash
# 启动 server 并设置为开机自启
aih server serve --port 8317
aih server autostart install

# Token 会自动维护，无需担心过期
```

### 场景 2：多账号管理

适用于管理大量账号的场景：
```bash
# Server 会并发刷新所有账号
# 假设有 50 个账号，刷新时间约 5-10 秒

aih serve --verbose
# [aih:token-refresh] Token refresh daemon tick #1 completed in 8234ms (accounts: 50, refreshed: 12, errors: 0)
```

### 场景 3：测试和调试

快速验证刷新功能：
```bash
# 临时缩短刷新间隔
aih serve --verbose --token-refresh-interval-ms 30000

# 观察日志
# 每 30 秒会执行一次检查
```

## 🔄 升级指南

### 从旧版本升级

如果你之前使用的版本没有自动刷新功能：

1. **更新代码**：
   ```bash
   git pull
   npm install
   ```

2. **重启 Server**：
   ```bash
   aih server restart
   ```

3. **验证功能**：
   ```bash
   # 启用 verbose 模式查看刷新日志
   aih server stop
   aih serve --verbose
   ```

### 兼容性说明

- ✅ 完全向后兼容，不影响现有账号
- ✅ 不改变 API 接口和使用方式
- ✅ 自动处理新旧账号格式

## 🤝 贡献

如需报告问题或提出改进建议：

1. 提供详细的错误日志（`--verbose` 模式）
2. 说明账号类型（Codex/Gemini/Claude）和认证方式（OAuth/API Key）
3. 描述预期行为和实际行为

---

**版本**：v1.0.0
**最后更新**：2026-04-06
**作者**：ai-home 开发团队
