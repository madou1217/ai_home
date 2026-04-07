# Codex 配置同步机制

## 🎯 设计目标

实现以下需求:
1. **每个账号有独立的 `config.toml`**,不共享配置文件
2. **账号专属字段独立配置**:`preferred_auth_method`, `model_provider`, `[[providers]]`
3. **非敏感配置从宿主继承**:如 `model`, `sandbox_mode`, `[projects]`, `[features]` 等
4. **敏感信息绝不共享**:`bearer_token`, `api_key` 等凭证字段

## 📋 配置分类

### 1. 账号专属配置 (Account-Only)

每个账号独立配置,**不从宿主继承**:

```toml
# ✅ 账号专属 - 独立配置
preferred_auth_method = "oauth"      # 认证方式
model_provider = "aih"               # 模型提供商

[[providers]]                         # 自定义 Provider
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key_env = "OPENAI_API_KEY"
```

**原因**:
- `preferred_auth_method`: 不同账号可能使用不同认证方式 (OAuth vs API Key)
- `model_provider`: 不同账号可能使用不同的模型提供商
- `[[providers]]`: 每个账号可能需要不同的 Provider 配置

### 2. 共享配置 (Shared/Inherited)

从宿主配置继承,所有账号共享:

```toml
# ✅ 从宿主继承 - 共享配置
model = "gpt-5.4"
model_reasoning_effort = "high"
model_context_window = 550000
model_auto_compact_token_limit = 397500
sandbox_mode = "danger-full-access"
approvals_reviewer = "user"

compact_prompt = """
压缩上下文时,必须保留:
- 当前任务目标
...
"""

[projects."/Users/model/projects/feature/ai_home"]
trust_level = "trusted"

[features]
multi_agent = true

[plugins."github@openai-curated"]
enabled = true

[notice]
hide_full_access_warning = true
```

**原因**:
- 这些配置是用户偏好和环境设置
- 所有账号应该保持一致的行为
- 避免每个账号都需要重复配置

### 3. 敏感配置 (Sensitive - Excluded)

**绝对不**从宿主同步到账号:

```toml
# ❌ 敏感信息 - 不同步
[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"        # ← 敏感!不同步
api_key = "sk-xxx"           # ← 敏感!不同步
wire_api = "responses"        # ← 安全,可同步
```

**原因**:
- 如果宿主设置了 `api_key`,同步到账号配置会导致:
  - 所有账号共享同一个 API Key
  - 账号隔离失效
  - 安全风险

## 🔄 同步流程

### 启动账号时自动同步

```
用户执行: aih codex 8888
    ↓
1. 检查账号 8888 的配置目录
    ~/.ai_home/profiles/codex/8888/.codex/
    ↓
2. 读取宿主配置
    ~/.codex/config.toml
    ↓
3. 过滤宿主配置
    - 移除账号专属字段 (preferred_auth_method, model_provider, [[providers]])
    - 移除敏感字段 (bearer_token, api_key, *_token, *_key)
    ↓
4. 读取账号配置
    ~/.ai_home/profiles/codex/8888/.codex/config.toml
    - 提取账号专属配置
    ↓
5. 合并配置
    账号专属配置 + 过滤后的宿主配置
    ↓
6. 写回账号配置
    ~/.ai_home/profiles/codex/8888/.codex/config.toml
    ↓
7. 启动 Codex PTY
    使用账号专属的配置文件
```

### 配置优先级

```
账号专属配置 > 宿主配置 > 默认配置
```

**示例**:

如果宿主配置:
```toml
model = "gpt-5.4"
preferred_auth_method = "apikey"
```

账号 10 配置:
```toml
preferred_auth_method = "oauth"
```

最终账号 10 使用:
```toml
preferred_auth_method = "oauth"    # ← 来自账号配置 (优先)
model = "gpt-5.4"                  # ← 来自宿主配置 (继承)
```

## 📄 配置文件示例

### 宿主配置 (`~/.codex/config.toml`)

```toml
# 宿主的 Codex 配置
preferred_auth_method = "apikey"
model_provider = "aih"
model = "gpt-5.4"
model_reasoning_effort = "high"
model_context_window = 550000
sandbox_mode = "danger-full-access"

[projects."/Users/model/projects/feature/ai_home"]
trust_level = "trusted"

[features]
multi_agent = true

[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"    # ← 敏感!
wire_api = "responses"
```

### 账号 8888 配置 (同步后)

```toml
# Codex configuration for account 8888
# This file is managed by ai-home (aih)
# Synced from host config (excluding sensitive fields)

# ✅ 账号专属配置 (如果之前设置过)
# preferred_auth_method = "oauth"
# model_provider = "custom"

# ✅ 从宿主继承的配置
model = "gpt-5.4"
model_reasoning_effort = "high"
model_context_window = 550000
sandbox_mode = "danger-full-access"

[projects."/Users/model/projects/feature/ai_home"]
trust_level = "trusted"

[features]
multi_agent = true

[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
# ❌ bearer_token 被过滤掉了!
wire_api = "responses"

# ✅ 账号专属 Providers (如果之前添加过)
# [[providers]]
# name = "replit1"
# base_url = "https://xxx.replit.dev"
```

### 账号 10 配置 (有自定义配置)

```toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)
# Synced from host config (excluding sensitive fields)

# ✅ 账号专属配置
preferred_auth_method = "oauth"
model_provider = "aih"

# ✅ 从宿主继承的配置
model = "gpt-5.4"
model_reasoning_effort = "high"
model_context_window = 550000
sandbox_mode = "danger-full-access"

[projects."/Users/model/projects/feature/ai_home"]
trust_level = "trusted"

[features]
multi_agent = true

[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"

# Account-specific providers
[[providers]]
name = "replit1"
base_url = "https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev"
api_key_env = "OPENAI_API_KEY"
```

## 🔍 过滤规则

### 规则 1: 排除账号专属字段

```javascript
if (trimmed.startsWith('preferred_auth_method') ||
    trimmed.startsWith('model_provider')) {
  continue; // 跳过,不同步
}

if (trimmed === '[[providers]]') {
  skipUntilNextSection = true; // 跳过整个 [[providers]] section
}
```

### 规则 2: 排除敏感字段

```javascript
// 在 [model_providers.*] section 中
if (trimmed.startsWith('bearer_token') ||
    trimmed.startsWith('api_key') ||
    trimmed.includes('_token =') ||
    trimmed.includes('_key =')) {
  continue; // 跳过敏感字段
}
```

### 规则 3: 保留账号已有的专属配置

```javascript
// 1. 提取账号已有的专属配置
const accountOnlyConfig = extractAccountOnlyConfig(accountConfigText);

// 2. 合并时,账号配置优先
if (accountOnlyConfig.preferred_auth_method) {
  lines.push(accountOnlyConfig.preferred_auth_method);
}

if (accountOnlyConfig.providers.length > 0) {
  accountOnlyConfig.providers.forEach((provider) => {
    lines.push(provider);
  });
}
```

## ✅ 优势

### 1. **安全性**
- 敏感凭证不会泄露到账号配置
- 每个账号独立的认证方式
- 避免 API Key 共享导致的安全问题

### 2. **灵活性**
- 账号可以使用不同的 Provider
- 账号可以覆盖宿主的认证方式
- 宿主配置更新后自动同步到所有账号

### 3. **便捷性**
- 不需要为每个账号手动配置所有选项
- 宿主更新 `model` 或 `sandbox_mode`,所有账号自动继承
- 新账号立即获得宿主的配置 (除了专属和敏感字段)

### 4. **隔离性**
- 每个账号有完全独立的 `config.toml` 文件
- 修改账号配置不影响宿主
- 修改宿主配置不覆盖账号专属设置

## 🧪 测试验证

### 测试 1: 验证敏感字段过滤

```bash
# 1. 在宿主配置中设置 bearer_token
cat > ~/.codex/config.toml <<EOF
[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "secret-token"
wire_api = "responses"
EOF

# 2. 启动账号 8888
aih codex 8888

# 3. 检查账号配置
cat ~/.ai_home/profiles/codex/8888/.codex/config.toml | grep bearer_token
# 应该输出为空 (bearer_token 被过滤)

# 4. 验证其他字段
cat ~/.ai_home/profiles/codex/8888/.codex/config.toml | grep wire_api
# 应该输出: wire_api = "responses" (安全字段被继承)
```

### 测试 2: 验证账号专属配置优先级

```bash
# 1. 宿主配置
echo 'preferred_auth_method = "apikey"' >> ~/.codex/config.toml

# 2. 为账号 10 设置不同的认证方式
cat > ~/.ai_home/profiles/codex/10/.codex/config.toml <<EOF
# Codex configuration for account 10
preferred_auth_method = "oauth"
EOF

# 3. 启动账号 10
aih codex 10

# 4. 检查账号配置
cat ~/.ai_home/profiles/codex/10/.codex/config.toml | grep preferred_auth_method
# 应该输出: preferred_auth_method = "oauth" (账号配置优先)
```

### 测试 3: 验证共享配置继承

```bash
# 1. 更新宿主配置
cat >> ~/.codex/config.toml <<EOF
[features]
multi_agent = true
new_feature = true
EOF

# 2. 启动账号 9999
aih codex 9999

# 3. 检查账号配置
cat ~/.ai_home/profiles/codex/9999/.codex/config.toml | grep "new_feature"
# 应该输出: new_feature = true (从宿主继承)
```

## 🔧 手动同步

如果需要手动同步宿主配置到现有账号:

```bash
# 方法 1: 重新启动账号 (推荐)
aih codex 10
# 启动时自动同步

# 方法 2: 删除账号配置并重新启动
rm -f ~/.ai_home/profiles/codex/10/.codex/config.toml
aih codex 10
# 会从宿主重新同步

# 方法 3: 批量同步所有账号
for id in $(ls ~/.ai_home/profiles/codex/); do
  echo "同步账号 $id..."
  aih codex $id --version  # 启动并立即退出,触发同步
done
```

## 📝 注意事项

### 1. 宿主配置修改

**场景**: 修改了宿主的 `~/.codex/config.toml`

**影响**:
- 下次启动账号时,会自动同步新配置
- 账号专属配置不会被覆盖
- 敏感字段不会被同步

**建议**:
- 在宿主配置中设置通用选项 (`model`, `sandbox_mode` 等)
- 不要在宿主配置中设置敏感凭证
- 账号专属的 Provider 在账号配置中设置

### 2. 账号配置修改

**场景**: 手动修改了账号的 `config.toml`

**影响**:
- 账号专属配置会被保留
- 下次启动时,宿主的非专属配置会重新同步
- 如果账号配置与宿主冲突,账号配置优先

**建议**:
- 使用 `./scripts/add-codex-provider.sh` 添加 Provider
- 手动修改账号专属字段时,使用注释标记
- 避免直接修改从宿主继承的字段 (会被覆盖)

### 3. 敏感信息管理

**宿主配置** (`~/.codex/config.toml`):
```toml
# ❌ 不要这样做
[model_providers.custom]
api_key = "sk-xxx"  # 会被过滤,不会同步到账号

# ✅ 如果需要,使用环境变量
[model_providers.custom]
api_key_env = "CUSTOM_API_KEY"
```

**账号配置** (`.aih_env.json`):
```json
{
  "CUSTOM_API_KEY": "sk-xxx"
}
```

## 🎯 最佳实践

### 1. 宿主配置管理

**宿主配置应该包含**:
- ✅ 通用模型设置 (`model`, `model_reasoning_effort`)
- ✅ 安全模式配置 (`sandbox_mode`, `approvals_reviewer`)
- ✅ 项目信任级别 (`[projects]`)
- ✅ 功能开关 (`[features]`)
- ✅ 插件配置 (`[plugins]`)

**宿主配置不应该包含**:
- ❌ 具体的认证方式 (`preferred_auth_method`) - 应该由账号决定
- ❌ API Key 或 Bearer Token - 应该使用环境变量
- ❌ 账号专属的 Provider - 应该在账号配置中设置

### 2. 账号配置管理

**使用脚本添加 Provider**:
```bash
./scripts/add-codex-provider.sh 10 replit1 "https://xxx.replit.dev"
```

**手动设置认证方式**:
```bash
# 编辑账号配置
vim ~/.ai_home/profiles/codex/10/.codex/config.toml

# 添加
preferred_auth_method = "oauth"
model_provider = "custom"
```

### 3. 环境变量管理

**为账号设置 API Key**:
```bash
# 编辑账号环境变量
vim ~/.ai_home/profiles/codex/10/.aih_env.json

# 添加
{
  "OPENAI_API_KEY": "sk-xxx",
  "REPLIT_API_KEY": "xxx"
}
```

---

**版本**: v1.0.0
**最后更新**: 2026-04-07
**作者**: ai-home 开发团队
