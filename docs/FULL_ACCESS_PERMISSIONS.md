# Full Access 权限配置和 OPENAI_BASE_URL 迁移

## 问题背景

### 问题 1: Permissions 显示为 "Custom"

用户启动 `aih codex 10` 后看到:
```
Permissions: Custom (workspace-write, on-request)
```

期望显示:
```
Permissions: Full Access
```

### 问题 2: OPENAI_BASE_URL 废弃警告

用户看到警告:
```
⚠ `OPENAI_BASE_URL` is deprecated. Set `openai_base_url` in config.toml instead.
```

## 解决方案

### 1. Full Access 权限配置

**实现位置**: `lib/cli/services/pty/runtime.js`

**核心逻辑**:

在每次启动 Codex 账号时,自动同步配置文件,强制设置:
- `sandbox_mode = "danger-full-access"`
- `approvals_reviewer = "auto"`

**配置同步流程**:

```javascript
// 1. 读取宿主配置: ~/.codex/config.toml
const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');

// 2. 过滤敏感和账号专属字段
const safeHostConfig = filterHostConfig(hostConfig, {
  excludeAccountOnly: true,   // 排除 preferred_auth_method, model_provider
  excludeSensitive: true,      // 排除 bearer_token, api_key
  excludePermissions: true     // 排除 approvals_reviewer, sandbox_mode
});

// 3. 合并配置
const mergedConfig = mergeConfigs(safeHostConfig, accountOnlyConfig, accountId, {
  openaiBaseUrl: loadedEnv.OPENAI_BASE_URL || processObj.env.OPENAI_BASE_URL
});

// 4. 写入账号配置: ~/.ai_home/profiles/codex/{id}/.codex/config.toml
fs.writeFileSync(accountConfigPath, mergedConfig, 'utf8');
```

**生成的配置文件示例**:

```toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)
# Synced from host config (excluding sensitive fields)

preferred_auth_method = "oauth"
model_provider = "openai"

# AI Home managed permissions: Full Access with auto-approval
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto"

# API endpoint configuration (migrated from OPENAI_BASE_URL env var)
openai_base_url = "http://localhost:8317/v1"

# ... 其他宿主配置 (已过滤敏感字段) ...
```

**关键点**:

1. **显式设置** `approvals_reviewer = "auto"` - 不依赖隐式默认值
2. **强制设置** `sandbox_mode = "danger-full-access"` - 覆盖宿主配置
3. **配置隔离** - 每个账号使用独立的 `.codex/config.toml`
4. **环境变量优先** - `CODEX_HOME` 指向账号专属配置目录

### 2. OPENAI_BASE_URL 迁移

**问题**: Codex 废弃了 `OPENAI_BASE_URL` 环境变量,推荐使用配置文件中的 `openai_base_url`。

**解决方案**:

1. **检测环境变量**:
   ```javascript
   const openaiBaseUrl = loadedEnv.OPENAI_BASE_URL || processObj.env.OPENAI_BASE_URL || '';
   ```

2. **写入配置文件**:
   ```javascript
   if (options.openaiBaseUrl && String(options.openaiBaseUrl).trim()) {
     lines.push('# API endpoint configuration (migrated from OPENAI_BASE_URL env var)');
     lines.push(`openai_base_url = "${String(options.openaiBaseUrl).trim()}"`);
     lines.push('');
   }
   ```

3. **移除环境变量**:
   ```javascript
   // ✅ 移除废弃的 OPENAI_BASE_URL 环境变量 (已迁移到 config.toml)
   if (cliName === 'codex' && envOverrides.OPENAI_BASE_URL) {
     delete envOverrides.OPENAI_BASE_URL;
   }
   ```

**效果**:
- ✅ 不再传递 `OPENAI_BASE_URL` 环境变量给 Codex 进程
- ✅ Codex 从配置文件读取 `openai_base_url`
- ✅ 消除废弃警告

## 调试

### 启用调试日志

```bash
AIH_DEBUG_CONFIG_SYNC=1 aih codex 10
```

**输出示例**:
```
[aih:config] Syncing config for account 10
[aih:config]   Account config: /Users/xxx/.ai_home/profiles/codex/10/.codex/config.toml
[aih:config]   Host config: /Users/xxx/.codex/config.toml
[aih:config] Config sync completed for account 10
[aih:config]   Migrated OPENAI_BASE_URL to config: http://localhost:8317/v1
```

### 验证配置文件

```bash
cat ~/.ai_home/profiles/codex/10/.codex/config.toml
```

**检查点**:
- ✅ 包含 `sandbox_mode = "danger-full-access"`
- ✅ 包含 `approvals_reviewer = "auto"`
- ✅ 包含 `openai_base_url = "..."`
- ✅ 不包含敏感字段 (`bearer_token`, `api_key`)

### 验证环境变量

```bash
# 启动 Codex 后,在另一个终端查看进程环境变量
ps -p <codex-pid> -o args -o env
```

**检查点**:
- ✅ `CODEX_HOME` 指向 `~/.ai_home/profiles/codex/10/.codex`
- ✅ 不包含 `OPENAI_BASE_URL` 环境变量

## 测试

### 单元测试

```bash
npm test test/permissions-full-access.test.js
```

**测试覆盖**:
1. 过滤宿主配置时移除 `approvals_reviewer` 和 `sandbox_mode`
2. 合并配置时强制设置 Full Access 权限
3. 合并配置时迁移 `OPENAI_BASE_URL` 到 `openai_base_url`

### 集成测试

```bash
# 1. 清理现有配置
rm -rf ~/.ai_home/profiles/codex/10/.codex

# 2. 设置环境变量
export OPENAI_BASE_URL=http://localhost:8317/v1

# 3. 启动 Codex
AIH_DEBUG_CONFIG_SYNC=1 aih codex 10

# 4. 检查启动信息
# 应该显示: Permissions: Full Access
# 不应该显示: ⚠ `OPENAI_BASE_URL` is deprecated
```

## 常见问题

### Q1: 为什么配置文件没有生成?

**可能原因**:
1. 宿主配置文件不存在 (`~/.codex/config.toml`)
2. 配置同步失败 (检查错误日志)

**解决方法**:
- 启用调试日志查看详细信息
- 检查文件权限

### Q2: 为什么 Permissions 还是显示 "Custom"?

**可能原因**:
1. 配置文件生成了,但 Codex 没有读取
2. 环境变量 `CODEX_HOME` 设置不正确
3. 其他配置文件优先级更高

**解决方法**:
1. 确认配置文件内容正确
2. 检查环境变量: `echo $CODEX_HOME`
3. 查看 Codex 读取的配置: `codex config show`

### Q3: 为什么还是有 OPENAI_BASE_URL 警告?

**可能原因**:
1. 环境变量没有被移除
2. 配置文件中没有 `openai_base_url`

**解决方法**:
1. 重启 Codex 进程
2. 检查配置文件是否包含 `openai_base_url`
3. 确认环境变量移除代码生效

## 相关文件

- **核心实现**: `lib/cli/services/pty/runtime.js`
  - `syncCodexConfigFromHost()` - 配置同步
  - `filterHostConfig()` - 过滤敏感字段
  - `mergeConfigs()` - 合并配置
  - `spawnPty()` - PTY 启动和环境变量设置

- **测试文件**: `test/permissions-full-access.test.js`
  - 验证配置过滤逻辑
  - 验证权限设置逻辑
  - 验证 OPENAI_BASE_URL 迁移

- **文档**:
  - `docs/FULL_ACCESS_PERMISSIONS.md` (本文件)
  - `docs/CONFIG_ISOLATION_FIX.md` - 配置隔离机制
  - `docs/CODEX_APIKEY_PERSISTENCE.md` - API Key 持久化

## 总结

本次变更实现了:

1. **Full Access 权限自动配置**
   - 每次启动时同步配置
   - 强制设置 `sandbox_mode = "danger-full-access"`
   - 显式设置 `approvals_reviewer = "auto"`
   - 自动审批所有操作

2. **OPENAI_BASE_URL 废弃警告消除**
   - 检测环境变量并迁移到配置文件
   - 移除传递给 Codex 的环境变量
   - 使用新的 `openai_base_url` 配置项

3. **调试和验证工具**
   - `AIH_DEBUG_CONFIG_SYNC=1` 调试开关
   - 详细的配置同步日志
   - 单元测试和集成测试

用户体验改进:
- ✅ 启动后直接显示 "Permissions: Full Access"
- ✅ 不再显示废弃警告
- ✅ 所有操作自动审批,无需手动确认
