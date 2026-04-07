# 为不同账号配置独立的 Provider

## 🎯 需求背景

不同账号可能需要使用不同的 API Provider:
- 账号 1: 使用 OpenAI 官方 API
- 账号 2: 使用自定义 Replit Provider (`https://xxx.replit.dev`)
- 账号 3: 使用本地 aih server (`http://localhost:8317/v1`)

## 📂 配置文件路径

每个账号都有独立的配置目录:

```
~/.ai_home/profiles/codex/{id}/.codex/config.toml
```

例如:
- 账号 1: `~/.ai_home/profiles/codex/1/.codex/config.toml`
- 账号 2: `~/.ai_home/profiles/codex/2/.codex/config.toml`
- 账号 10: `~/.ai_home/profiles/codex/10/.codex/config.toml`

⚠️ **重要**: 这些配置文件**完全独立于全局配置** `~/.codex/config.toml`

## ✅ 配置方法

### 方法 1: 手动编辑配置文件

```bash
# 为账号 10 添加 Replit provider
vim ~/.ai_home/profiles/codex/10/.codex/config.toml
```

添加以下内容:

```toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)

[[providers]]
name = "replit1"
base_url = "https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev"
api_key_env = "OPENAI_API_KEY"  # 或者直接写 api_key = "your-key"

[[providers]]
name = "local-aih"
base_url = "http://localhost:8317/v1"
api_key_env = "OPENAI_API_KEY"
```

### 方法 2: 使用命令行工具 (推荐)

创建一个辅助脚本来快速添加 provider:

```bash
#!/bin/bash
# 文件名: add-codex-provider.sh

ACCOUNT_ID=$1
PROVIDER_NAME=$2
BASE_URL=$3

if [ -z "$ACCOUNT_ID" ] || [ -z "$PROVIDER_NAME" ] || [ -z "$BASE_URL" ]; then
  echo "Usage: $0 <account_id> <provider_name> <base_url>"
  echo "Example: $0 10 replit1 https://xxx.replit.dev"
  exit 1
fi

CONFIG_PATH=~/.ai_home/profiles/codex/${ACCOUNT_ID}/.codex/config.toml

# 确保目录存在
mkdir -p "$(dirname "$CONFIG_PATH")"

# 如果文件不存在,创建头部
if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" <<EOF
# Codex configuration for account ${ACCOUNT_ID}
# This file is managed by ai-home (aih)

EOF
fi

# 添加 provider 配置
cat >> "$CONFIG_PATH" <<EOF

[[providers]]
name = "${PROVIDER_NAME}"
base_url = "${BASE_URL}"
api_key_env = "OPENAI_API_KEY"
EOF

echo "✅ Added provider '${PROVIDER_NAME}' to account ${ACCOUNT_ID}"
echo "📄 Config file: ${CONFIG_PATH}"
```

使用示例:

```bash
# 为账号 10 添加 Replit provider
./add-codex-provider.sh 10 replit1 "https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev"

# 为账号 10 添加本地 aih server
./add-codex-provider.sh 10 local-aih "http://localhost:8317/v1"
```

## 🚀 使用自定义 Provider

### 在 Codex 会话中切换 Provider

```bash
# 启动账号 10
aih codex 10

# 在 Codex 会话中
/provider

# 选择自定义的 provider
# 会看到: replit1, local-aih, 等你配置的 providers

# 或者直接指定
/provider replit1
```

### 验证配置

```bash
# 启动账号 10
aih codex 10

# 在 Codex 中执行
/status

# 应该看到:
# Model provider: replit1 - https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev
```

## 📋 完整配置示例

### 账号 1: 使用 OpenAI 官方 + 本地 aih

`~/.ai_home/profiles/codex/1/.codex/config.toml`:

```toml
# Codex configuration for account 1

[[providers]]
name = "openai-official"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"

[[providers]]
name = "aih-local"
base_url = "http://localhost:8317/v1"
api_key_env = "OPENAI_API_KEY"
```

### 账号 10: 使用 Replit Provider

`~/.ai_home/profiles/codex/10/.codex/config.toml`:

```toml
# Codex configuration for account 10

[[providers]]
name = "replit-dev"
base_url = "https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev"
api_key_env = "OPENAI_API_KEY"

[[providers]]
name = "replit-prod"
base_url = "https://prod.replit.dev"
api_key_env = "REPLIT_API_KEY"
```

## 🔧 故障排查

### 问题 1: Codex 仍然使用全局配置

**症状**: `/provider` 显示的是 `~/.codex/config.toml` 中的 providers

**原因**: 账号专属的 `config.toml` 不存在或为空

**解决方案**:
```bash
# 检查配置文件是否存在
ls -la ~/.ai_home/profiles/codex/10/.codex/config.toml

# 如果不存在,创建一个
mkdir -p ~/.ai_home/profiles/codex/10/.codex
echo '# Codex configuration for account 10' > ~/.ai_home/profiles/codex/10/.codex/config.toml

# 重新启动账号
aih codex 10
```

### 问题 2: Provider 配置后不显示

**症状**: 添加了 provider 但 `/provider` 看不到

**检查配置语法**:
```bash
# 查看配置文件
cat ~/.ai_home/profiles/codex/10/.codex/config.toml

# 确保 TOML 语法正确
# 常见错误:
# ❌ [providers]         (错误: 单方括号)
# ✅ [[providers]]       (正确: 双方括号)

# ❌ base-url = "..."   (错误: 短横线)
# ✅ base_url = "..."   (正确: 下划线)
```

### 问题 3: 环境变量配置

Provider 可以使用环境变量或直接配置 API Key:

**方式 1: 使用环境变量 (推荐)**
```toml
[[providers]]
name = "my-provider"
base_url = "https://api.example.com"
api_key_env = "MY_PROVIDER_API_KEY"  # 从环境变量读取
```

然后在 `.aih_env.json` 中配置:
```bash
# 编辑账号专属环境变量
vim ~/.ai_home/profiles/codex/10/.aih_env.json
```

```json
{
  "MY_PROVIDER_API_KEY": "your-api-key-here"
}
```

**方式 2: 直接配置 (不推荐,不安全)**
```toml
[[providers]]
name = "my-provider"
base_url = "https://api.example.com"
api_key = "sk-your-api-key"  # 明文存储,不推荐
```

## 📝 最佳实践

### 1. 使用环境变量管理 API Key

✅ 推荐:
```toml
[[providers]]
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key_env = "REPLIT_API_KEY"
```

配合 `.aih_env.json`:
```json
{
  "REPLIT_API_KEY": "your-secret-key"
}
```

❌ 不推荐:
```toml
[[providers]]
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key = "sk-plaintext-key"  # 明文存储,不安全
```

### 2. 命名规范

- Provider 名称使用小写字母和短横线: `replit-dev`, `local-aih`
- 避免使用空格和特殊字符

### 3. 配置文件备份

```bash
# 备份所有账号的配置
tar -czf codex-configs-backup.tar.gz ~/.ai_home/profiles/codex/*/. codex/config.toml
```

## 🎯 常见场景

### 场景 1: 开发环境 vs 生产环境

```bash
# 开发账号 (ID 1)
aih codex 1
# config.toml 配置: dev-api.example.com

# 生产账号 (ID 2)
aih codex 2
# config.toml 配置: prod-api.example.com
```

### 场景 2: 多个 Replit 实例

```bash
# 账号 10: Replit Instance 1
# ~/.ai_home/profiles/codex/10/.codex/config.toml
[[providers]]
name = "replit1"
base_url = "https://instance1.replit.dev"

# 账号 11: Replit Instance 2
# ~/.ai_home/profiles/codex/11/.codex/config.toml
[[providers]]
name = "replit2"
base_url = "https://instance2.replit.dev"
```

### 场景 3: 本地测试 + 远程 API

```bash
# 账号 99: 本地测试专用
# ~/.ai_home/profiles/codex/99/.codex/config.toml
[[providers]]
name = "localhost"
base_url = "http://localhost:8000/v1"
api_key_env = "LOCAL_API_KEY"

[[providers]]
name = "aih-server"
base_url = "http://localhost:8317/v1"
api_key_env = "OPENAI_API_KEY"
```

---

**版本**: v1.0.0
**最后更新**: 2026-04-06
**作者**: ai-home 开发团队
