# API Key 模式配置修复

## 问题

用户反馈 API Key 模式的账号配置不完整：

1. ❌ `preferred_auth_method` 缺失
2. ❌ `model_provider` 缺失
3. ❌ `[[providers]]` section 缺失
4. ❌ 宿主配置未继承

**结果**: Codex 无法正确识别 API Key 模式，也无法使用配置的 `OPENAI_BASE_URL`。

## 完整的 API Key 模式配置

### 期望的 config.toml 内容

```toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)
# Synced from host config (excluding sensitive fields)

preferred_auth_method = "apikey"
model_provider = "aih"

# AI Home managed permissions: Full Access with auto-approval
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto"

# API endpoint configuration (migrated from OPENAI_BASE_URL env var)
openai_base_url = "http://localhost:8317/v1"

# ... 其他从宿主配置继承的设置 ...

# AI Home managed provider for API Key mode
[[providers]]
name = "aih"
provider_type = "openai"
base_url = "http://localhost:8317/v1"
```

### 各字段说明

| 字段 | 值 | 说明 |
|-----|-----|-----|
| `preferred_auth_method` | `"apikey"` | 告诉 Codex 使用 API Key 认证而非 OAuth |
| `model_provider` | `"aih"` | 使用自定义 provider (如果有 base_url) |
| `sandbox_mode` | `"danger-full-access"` | Full Access 权限 |
| `approvals_reviewer` | `"auto"` | 自动审批 |
| `openai_base_url` | `"http://..."` | 全局 API 端点配置 |
| `[[providers]]` | - | 自定义 provider 定义 |
| `providers.name` | `"aih"` | Provider 名称 (对应 model_provider) |
| `providers.provider_type` | `"openai"` | Provider 类型 (OpenAI 兼容) |
| `providers.base_url` | `"http://..."` | Provider 的 API 端点 |

## 解决方案

### 1. 检测 API Key 模式

```javascript
// 检测是否为 API Key 模式
const openaiApiKey = loadedEnv.OPENAI_API_KEY || processObj.env.OPENAI_API_KEY || '';
const isApiKeyMode = !!(openaiApiKey && String(openaiApiKey).trim());
```

### 2. 自动设置 auth_method 和 model_provider

```javascript
if (options.isApiKeyMode) {
  if (!accountOnlyConfig.preferred_auth_method) {
    accountOnlyConfig.preferred_auth_method = 'preferred_auth_method = "apikey"';
  }
  if (!accountOnlyConfig.model_provider) {
    accountOnlyConfig.model_provider = options.openaiBaseUrl
      ? 'model_provider = "aih"'  // 有自定义 URL 用 aih
      : 'model_provider = "openai"';  // 否则用 openai
  }
}
```

### 3. 创建 [[providers]] section

```javascript
// API Key 模式:如果有 openaiBaseUrl 且没有现有 providers,创建一个 aih provider
if (options.isApiKeyMode && options.openaiBaseUrl &&
    (!accountOnlyConfig.providers || accountOnlyConfig.providers.length === 0)) {
  lines.push('');
  lines.push('# AI Home managed provider for API Key mode');
  lines.push('[[providers]]');
  lines.push('name = "aih"');
  lines.push('provider_type = "openai"');
  lines.push(`base_url = "${String(options.openaiBaseUrl).trim()}"`);
  lines.push('');
}
```

### 4. 继承宿主配置

```javascript
// 读取宿主配置
const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');

// 过滤宿主配置,移除敏感和账号专属字段
const safeHostConfig = filterHostConfig(hostConfig, {
  excludeAccountOnly: true,  // 排除 preferred_auth_method, model_provider
  excludeSensitive: true      // 排除 bearer_token, api_key 等
});

// 合并到账号配置中
const mergedConfig = mergeConfigs(safeHostConfig, accountOnlyConfig, accountId, options);
```

## 使用方法

### 创建 API Key 模式账号

```bash
# 设置环境变量
export OPENAI_API_KEY=sk-your-key
export OPENAI_BASE_URL=http://localhost:8317/v1

# 启动账号 (会自动检测 API Key 模式)
aih codex 10
```

**自动执行**:
1. ✅ 检测到 `OPENAI_API_KEY` → 识别为 API Key 模式
2. ✅ 保存环境变量到 `.aih_env.json`
3. ✅ 设置 `preferred_auth_method = "apikey"`
4. ✅ 设置 `model_provider = "aih"`
5. ✅ 创建 `[[providers]]` section
6. ✅ 继承宿主的其他配置 (model, temperature 等)
7. ✅ 设置 Full Access 权限

### 调试配置生成

```bash
# 启用调试日志
AIH_DEBUG_CONFIG_SYNC=1 aih codex 10
```

**输出示例**:
```
[aih:config] Syncing config for account 10
[aih:config]   Account config: ~/.ai_home/profiles/codex/10/.codex/config.toml
[aih:config]   Host config: ~/.codex/config.toml
[aih:config] Config sync completed for account 10
[aih:config]   API Key mode: YES
[aih:config]   Migrated OPENAI_BASE_URL to config: http://localhost:8317/v1
[aih:config]   Auth method: apikey
[aih:config]   Model provider: aih
```

### 验证配置

```bash
# 查看生成的配置文件
cat ~/.ai_home/profiles/codex/10/.codex/config.toml
```

**检查清单**:
- ✅ 包含 `preferred_auth_method = "apikey"`
- ✅ 包含 `model_provider = "aih"`
- ✅ 包含 `openai_base_url = "http://..."`
- ✅ 包含 `[[providers]]` section
- ✅ 包含 `sandbox_mode = "danger-full-access"`
- ✅ 包含 `approvals_reviewer = "auto"`
- ✅ 包含从宿主继承的其他配置

### Codex 启动验证

启动后应该看到:
```
Account: API key configured (run codex login to use ChatGPT)
Collaboration mode: Default
Permissions: Full Access
```

如果看到 `Permissions: Custom`，说明配置未生效，需要：
1. 检查 config.toml 内容
2. 查看调试日志
3. 重启账号

## 测试

新增测试用例验证 API Key 模式配置:

```javascript
// test/permissions-full-access.test.js

it('should set preferred_auth_method and model_provider for API Key mode', () => {
  // 验证 API Key 模式自动设置配置字段
});

it('should create [[providers]] section for API Key mode with custom base URL', () => {
  // 验证创建 providers section
});
```

## 常见问题

### Q1: 为什么要设置 model_provider = "aih"?

**A**: 当使用自定义 `base_url` 时，需要一个自定义 provider 来指向该 URL。`aih` 是我们创建的 provider 名称，对应 `[[providers]]` section。

### Q2: providers section 和 openai_base_url 有什么区别?

**A**:
- `openai_base_url`: 全局默认 API 端点
- `[[providers]]`: 定义具体的 provider 配置，可以有多个

当设置了 `model_provider = "aih"` 时，Codex 会查找名为 `aih` 的 provider 并使用它的 `base_url`。

### Q3: 为什么宿主配置要排除 preferred_auth_method 和 model_provider?

**A**: 这些是账号专属配置:
- OAuth 账号: `preferred_auth_method = "oauth"`
- API Key 账号: `preferred_auth_method = "apikey"`

不同账号可能使用不同的认证方式，所以不能继承宿主的设置。

### Q4: 如果宿主配置不存在怎么办?

**A**: 即使没有宿主配置，API Key 模式也会自动创建完整的配置文件，包含所有必要的字段。

## 相关文件

- **实现**: `lib/cli/services/pty/runtime.js`
  - `syncCodexConfigFromHost()` - 配置同步主函数
  - `mergeConfigs()` - 配置合并逻辑
- **测试**: `test/permissions-full-access.test.js`
- **文档**:
  - `docs/APIKEY_CONFIG_FIX.md` (本文件)
  - `docs/FULL_ACCESS_PERMISSIONS.md`

## 总结

修复后的 API Key 模式配置:

1. ✅ **自动检测** API Key 模式
2. ✅ **自动设置** `preferred_auth_method = "apikey"`
3. ✅ **自动设置** `model_provider = "aih"` (如果有自定义 URL)
4. ✅ **自动创建** `[[providers]]` section
5. ✅ **继承宿主配置** (除敏感和账号专属字段)
6. ✅ **Full Access 权限** (`sandbox_mode` + `approvals_reviewer`)
7. ✅ **调试支持** (`AIH_DEBUG_CONFIG_SYNC=1`)

现在 API Key 模式的账号可以完整工作了！
