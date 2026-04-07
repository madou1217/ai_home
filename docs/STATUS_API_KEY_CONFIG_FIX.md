# API Key 模式配置修复 - 实现状态

## ✅ 已完成的修复

### 1. API Key 模式自动检测
**文件**: `lib/cli/services/pty/runtime.js:410`

```javascript
const openaiApiKey = loadedEnv.OPENAI_API_KEY || processObj.env.OPENAI_API_KEY || '';
const isApiKeyMode = !!(openaiApiKey && String(openaiApiKey).trim());
```

**功能**: 当环境中存在 `OPENAI_API_KEY` 时，自动识别为 API Key 模式。

---

### 2. 自动设置 `preferred_auth_method` 和 `model_provider`
**文件**: `lib/cli/services/pty/runtime.js:92-102`

```javascript
if (options.isApiKeyMode) {
  if (!accountOnlyConfig.preferred_auth_method) {
    accountOnlyConfig.preferred_auth_method = 'preferred_auth_method = "apikey"';
  }
  if (!accountOnlyConfig.model_provider) {
    // 如果有 openaiBaseUrl，使用自定义 provider，否则使用 openai
    accountOnlyConfig.model_provider = options.openaiBaseUrl
      ? 'model_provider = "aih"'
      : 'model_provider = "openai"';
  }
}
```

**功能**:
- ✅ 自动设置 `preferred_auth_method = "apikey"`
- ✅ 根据是否有自定义 Base URL 设置 `model_provider`
  - 有自定义 URL → `model_provider = "aih"`
  - 无自定义 URL → `model_provider = "openai"`

---

### 3. 自动创建 `[model_providers.aih]` Section
**文件**: `lib/cli/services/pty/runtime.js:319-329`

```javascript
// ✅ API Key 模式:创建 model_providers.aih section
if (options.isApiKeyMode && options.openaiBaseUrl && options.openaiApiKey) {
  lines.push('');
  lines.push('# AI Home managed provider for API Key mode');
  lines.push('[model_providers.aih]');
  lines.push('name = "aih codex"');
  lines.push(`base_url = "${String(options.openaiBaseUrl).trim()}"`);
  lines.push(`bearer_token = "${String(options.openaiApiKey).trim()}"`);
  lines.push('wire_api = "responses"');
  lines.push('');
}
```

**功能**: 当使用自定义 Base URL 时，自动创建对应的 provider 配置（使用 `[model_providers.*]` 格式）。

---

### 4. 继承宿主配置
**文件**: `lib/cli/services/pty/runtime.js:75-134`

**`syncCodexConfigFromHost()` 函数流程**:
1. ✅ 读取账号现有配置（如果存在）
2. ✅ 提取账号专属字段 (`preferred_auth_method`, `model_provider`, `[[providers]]`)
3. ✅ 读取宿主配置
4. ✅ 过滤敏感和账号专属字段
5. ✅ 合并宿主配置和账号配置
6. ✅ 写回账号配置文件

**过滤规则** (`filterHostConfig()`):
- ❌ 排除: `preferred_auth_method` (账号专属)
- ❌ 排除: `model_provider` (账号专属)
- ❌ 排除: `[[providers]]` section (账号专属)
- ❌ 排除: `approvals_reviewer` (强制设置为 `auto`)
- ❌ 排除: `sandbox_mode` (强制设置为 `danger-full-access`)
- ❌ 排除: 敏感字段 (`bearer_token`, `api_key` 等)
- ✅ 保留: `model`, `temperature` 等其他配置

---

### 5. OPENAI_BASE_URL 迁移
**文件**: `lib/cli/services/pty/runtime.js:287-292`

```javascript
// ✅ 如果提供了 openai_base_url,写入配置文件 (替代废弃的 OPENAI_BASE_URL 环境变量)
if (options.openaiBaseUrl && String(options.openaiBaseUrl).trim()) {
  lines.push('# API endpoint configuration (migrated from OPENAI_BASE_URL env var)');
  lines.push(`openai_base_url = "${String(options.openaiBaseUrl).trim()}"`);
  lines.push('');
}
```

**移除废弃的环境变量** (`runtime.js:449-451`):
```javascript
// ✅ 移除废弃的 OPENAI_BASE_URL 环境变量 (已迁移到 config.toml)
if (cliName === 'codex' && envOverrides.OPENAI_BASE_URL) {
  delete envOverrides.OPENAI_BASE_URL;
}
```

**功能**: 将 `OPENAI_BASE_URL` 从环境变量迁移到 `config.toml`，消除废弃警告。

---

### 6. Full Access 权限自动设置
**文件**: `lib/cli/services/pty/runtime.js:281-285`

```javascript
// ✅ 强制设置权限策略: Full Access + 自动审批
lines.push('# AI Home managed permissions: Full Access with auto-approval');
lines.push('sandbox_mode = "danger-full-access"');
lines.push('approvals_reviewer = "auto"');
lines.push('');
```

**功能**: 确保所有账号默认使用 Full Access 权限并自动审批。

---

### 7. 调试支持
**文件**: `lib/cli/services/pty/runtime.js:399-428`

```javascript
if (String(processObj.env.AIH_DEBUG_CONFIG_SYNC || '0') === '1') {
  console.log(`\x1b[36m[aih:config]\x1b[0m Syncing config for account ${id}`);
  console.log(`\x1b[36m[aih:config]\x1b[0m   Account config: ${accountConfigPath}`);
  console.log(`\x1b[36m[aih:config]\x1b[0m   Host config: ${hostConfigPath || 'none'}`);
  // ... 完成后
  console.log(`\x1b[32m[aih:config]\x1b[0m Config sync completed for account ${id}`);
  console.log(`\x1b[36m[aih:config]\x1b[0m   API Key mode: ${isApiKeyMode ? 'YES' : 'NO'}`);
  if (openaiBaseUrl) {
    console.log(`\x1b[36m[aih:config]\x1b[0m   Migrated OPENAI_BASE_URL to config: ${openaiBaseUrl}`);
  }
  if (isApiKeyMode) {
    console.log(`\x1b[36m[aih:config]\x1b[0m   Auth method: apikey`);
    console.log(`\x1b[36m[aih:config]\x1b[0m   Model provider: ${openaiBaseUrl ? 'aih' : 'openai'}`);
  }
}
```

**使用方法**:
```bash
AIH_DEBUG_CONFIG_SYNC=1 aih codex 10
```

---

### 8. WebSocket API Key 模式支持
**文件**: `lib/server/accounts.js`

```javascript
// ✅ 读取 API Key 模式环境配置
const envPath = path.join(profileDir, '.aih_env.json');
const envData = parseJsonFileSafe(envPath, fs);
const openaiBaseUrl = envData && envData.OPENAI_BASE_URL 
  ? String(envData.OPENAI_BASE_URL).trim() 
  : '';

out.push({
  id: String(id),
  email,
  accessToken: '...',
  openaiBaseUrl  // ✅ API Key 模式的 base URL
});
```

**文件**: `lib/server/server.js`

```javascript
// ✅ 构建上游 WebSocket URL
let upstreamBaseUrl = options.codexBaseUrl;  // 默认: 官方 ChatGPT

// 检查账号是否使用 API Key 模式
if (account.openaiBaseUrl && String(account.openaiBaseUrl).trim()) {
  upstreamBaseUrl = String(account.openaiBaseUrl).trim().replace(/\/+$/, '');
}

const upstreamUrl = upstreamBaseUrl.replace(/^https?:/, 'wss:') + '/responses';
// OAuth: wss://chatgpt.com/backend-api/codex/responses
// API Key: wss://localhost:8317/v1/responses
```

**功能**: WebSocket 代理根据账号类型自动选择上游端点。

---

## 📋 生成的配置示例

### 完整的 API Key 模式 config.toml

```toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)
# Synced from host config (excluding sensitive fields)

preferred_auth_method = "apikey"
model_provider = "aih"

# AI Home managed permissions: Full Access
sandbox_mode = "danger-full-access"

# API endpoint configuration (migrated from OPENAI_BASE_URL env var)
openai_base_url = "http://localhost:8317/v1"

# ... 从宿主配置继承的其他设置 ...
# 例如:
# model = "gpt-5.4"
# temperature = 0.7

# AI Home managed provider for API Key mode
[model_providers.aih]
name = "aih codex"
base_url = "http://localhost:8317/v1"
bearer_token = "dummy"
wire_api = "responses"
```

---

## 🧪 测试

### 单元测试
**文件**: `test/permissions-full-access.test.js`

新增测试用例:
1. ✅ `should set preferred_auth_method and model_provider for API Key mode`
2. ✅ `should create [model_providers.aih] section for API Key mode with custom base URL`

### 手动测试

#### 测试步骤 1: 创建 API Key 模式账号

```bash
# 1. 删除旧账号
aih codex delete 10

# 2. 设置环境变量
export OPENAI_API_KEY=dummy
export OPENAI_BASE_URL=http://localhost:8317/v1

# 3. 启用调试并创建账号
AIH_DEBUG_CONFIG_SYNC=1 aih codex 10
```

**期望输出**:
```
[aih] Detected OPENAI_API_KEY in environment, saved to account config for persistence.
[aih:config] Syncing config for account 10
[aih:config]   Account config: ~/.ai_home/profiles/codex/10/.codex/config.toml
[aih:config]   Host config: ~/.codex/config.toml
[aih:config] Config sync completed for account 10
[aih:config]   API Key mode: YES
[aih:config]   Migrated OPENAI_BASE_URL to config: http://localhost:8317/v1
[aih:config]   Auth method: apikey
[aih:config]   Model provider: aih
```

#### 测试步骤 2: 验证配置文件

```bash
# 使用验证脚本
/tmp/test-apikey-config.sh 10
```

**检查清单**:
- ✅ 包含 `preferred_auth_method = "apikey"`
- ✅ 包含 `model_provider = "aih"`
- ✅ 包含 `sandbox_mode = "danger-full-access"`
- ✅ 包含 `openai_base_url = "http://localhost:8317/v1"`
- ✅ 包含 `[model_providers.aih]` section
  - ✅ `name = "aih codex"`
  - ✅ `base_url = "http://localhost:8317/v1"`
  - ✅ `bearer_token = "dummy"`
  - ✅ `wire_api = "responses"`

#### 测试步骤 3: Codex 启动验证

启动后应该看到:
```
Account: API key configured (run codex login to use ChatGPT)
Collaboration mode: Default
Permissions: Full Access
```

如果看到 `Permissions: Custom`，需要:
1. 检查 config.toml 内容
2. 查看调试日志
3. 重启账号

---

## 📝 使用说明

### 创建 API Key 模式账号

```bash
# 方式 1: 使用环境变量
export OPENAI_API_KEY=sk-your-key
export OPENAI_BASE_URL=http://localhost:8317/v1
aih codex 10

# 方式 2: 使用调试模式
AIH_DEBUG_CONFIG_SYNC=1 \
OPENAI_API_KEY=sk-your-key \
OPENAI_BASE_URL=http://localhost:8317/v1 \
aih codex 10
```

**自动执行**:
1. ✅ 检测到 `OPENAI_API_KEY` → 识别为 API Key 模式
2. ✅ 保存环境变量到 `.aih_env.json`
3. ✅ 设置 `preferred_auth_method = "apikey"`
4. ✅ 设置 `model_provider = "aih"`
5. ✅ 创建 `[model_providers.aih]` section (包含 `bearer_token` 和 `wire_api`)
6. ✅ 继承宿主的其他配置 (model, temperature 等)
7. ✅ 设置 Full Access 权限
8. ✅ 迁移 `OPENAI_BASE_URL` 到 config.toml
9. ✅ 移除废弃的环境变量

---

## 🐛 常见问题

### Q1: 为什么要设置 model_provider = "aih"?

**A**: 当使用自定义 `base_url` 时，需要一个自定义 provider 来指向该 URL。`aih` 是我们创建的 provider 名称，对应 `[model_providers.aih]` section。

### Q2: [model_providers.*] 和 openai_base_url 有什么区别?

**A**:
- `openai_base_url`: 全局默认 API 端点
- `[model_providers.*]`: 定义具体的 provider 配置，可以有多个

当设置了 `model_provider = "aih"` 时，Codex 会查找名为 `aih` 的 `[model_providers.aih]` section 并使用它的配置。

### Q3: 为什么宿主配置要排除 preferred_auth_method 和 model_provider?

**A**: 这些是账号专属配置:
- OAuth 账号: `preferred_auth_method = "oauth"`
- API Key 账号: `preferred_auth_method = "apikey"`

不同账号可能使用不同的认证方式，所以不能继承宿主的设置。

### Q4: 如果宿主配置不存在怎么办?

**A**: 即使没有宿主配置，API Key 模式也会自动创建完整的配置文件，包含所有必要的字段。

---

## 📄 相关文档

- **API Key 配置修复详解**: `docs/APIKEY_CONFIG_FIX.md`
- **WebSocket API Key 支持**: `docs/WEBSOCKET_APIKEY_FIX.md`
- **WebSocket 代理设计**: `docs/WEBSOCKET_PROXY_DESIGN.md`
- **Full Access 权限**: `docs/FULL_ACCESS_PERMISSIONS.md`

---

## ✅ 总结

API Key 模式配置修复已完成，实现了:

1. ✅ **自动检测** API Key 模式
2. ✅ **自动设置** `preferred_auth_method = "apikey"`
3. ✅ **自动设置** `model_provider = "aih"` (如果有自定义 URL)
4. ✅ **自动创建** `[model_providers.aih]` section (包含 `bearer_token` 和 `wire_api`)
5. ✅ **继承宿主配置** (除敏感和账号专属字段)
6. ✅ **Full Access 权限** (`sandbox_mode = "danger-full-access"`)
7. ✅ **OPENAI_BASE_URL 迁移** (环境变量 → config.toml)
8. ✅ **WebSocket 支持** (根据账号类型选择上游端点)
9. ✅ **调试支持** (`AIH_DEBUG_CONFIG_SYNC=1`)

现在 API Key 模式的账号可以完整工作了！
