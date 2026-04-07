# Config.toml 隔离修复说明

## 🐛 问题描述

### 原始问题

用户报告:**所有 Codex 账号都使用同一个 `config.toml`,导致无法为不同账号配置独立的 Provider**。

```bash
# 用户期望
aih codex 10   # 应该使用 ~/.ai_home/profiles/codex/10/.codex/config.toml
aih codex 11   # 应该使用 ~/.ai_home/profiles/codex/11/.codex/config.toml

# 实际情况
aih codex 10   # ❌ 使用 ~/.codex/config.toml (全局配置)
aih codex 11   # ❌ 使用 ~/.codex/config.toml (全局配置)
```

### 具体表现

1. 启动 `aih codex 10` 后,在 Codex 中执行 `/status`,显示的 Provider 是全局配置中的,而不是账号专属的
2. 无法为账号 10 单独配置 Replit Provider
3. 所有账号的 `~/.ai_home/profiles/codex/{id}/.codex/config.toml` 都是指向 `~/.codex/config.toml` 的软链接

## 🔍 根本原因

### 原因 1: `config.toml` 被错误地加入了软链接白名单

**文件**: `lib/cli/services/session-store.js:22`

```javascript
const SESSION_STORE_ALLOWLIST = {
  codex: [
    'sessions',
    'history.jsonl',
    'archived_sessions',
    'shell_snapshots',
    'config.toml',  // ❌ 这导致 config.toml 被软链接到全局配置
    'version.json',
    // ...
  ],
  // ...
};
```

**影响**:
- `ensureSessionStoreLinks()` 函数会为每个账号创建软链接:
  ```
  ~/.ai_home/profiles/codex/10/.codex/config.toml -> ~/.codex/config.toml
  ```
- 所有账号共享同一个配置文件
- **无法实现 Provider 隔离**

### 原因 2: 账号专属配置目录可能不存在

**文件**: `lib/cli/services/pty/runtime.js:89-131`

当 `~/.ai_home/profiles/codex/{id}/.codex/` 目录不存在时,Codex 会 fallback 到全局配置 `~/.codex/config.toml`。

## ✅ 修复方案

### 修复 1: 从软链接白名单中移除 `config.toml`

**文件**: `lib/cli/services/session-store.js:16-43`

```javascript
const SESSION_STORE_ALLOWLIST = {
  codex: [
    'sessions',
    'history.jsonl',
    'archived_sessions',
    'shell_snapshots',
    // ✅ 移除 config.toml - 每个账号应该有独立的配置
    // 'config.toml',
    'version.json',
    'models_cache.json',
    // ...
  ],
  // ...
};
```

**效果**:
- 新账号不再自动创建 `config.toml` 软链接
- 每个账号可以有独立的配置文件

### 修复 2: 启动时确保账号专属配置目录和文件存在

**文件**: `lib/cli/services/pty/runtime.js:98-117`

```javascript
function spawnPty(cliName, cliBin, id, forwardArgs, isLogin) {
  const sandboxDir = getProfileDir(cliName, id);

  // ...

  const codexConfigDir = path.join(sandboxDir, '.codex');

  // ✅ 确保账号专属的配置目录存在
  if (cliName === 'codex') {
    try {
      fs.mkdirSync(codexConfigDir, { recursive: true });

      // ✅ 如果账号专属的 config.toml 不存在,创建一个空的默认配置
      const accountConfigPath = path.join(codexConfigDir, 'config.toml');
      if (!fs.existsSync(accountConfigPath)) {
        // 创建一个最小化的配置文件,确保不会 fallback 到全局配置
        const defaultConfig = '# Codex configuration for account ' + id + '\n' +
          '# This file is managed by ai-home (aih)\n' +
          '# Add your custom providers here\n\n';
        fs.writeFileSync(accountConfigPath, defaultConfig, 'utf8');
      }
    } catch (_error) {
      // 如果创建失败,继续执行
    }
  }

  // ✅ 设置环境变量确保 Codex 使用账号专属的配置目录
  const envOverrides = normalizeProxyEnv({
    ...processObj.env,
    ...loadedEnv,
    HOME: sandboxDir,
    USERPROFILE: sandboxDir,
    CODEX_HOME: codexConfigDir,
    // 确保 Codex 使用账号专属的配置目录
    XDG_CONFIG_HOME: sandboxDir,
    XDG_DATA_HOME: path.join(sandboxDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(sandboxDir, '.local', 'state'),
    // ...
  });

  // ...
}
```

**效果**:
- 启动账号时自动创建 `.codex` 目录和空的 `config.toml`
- 设置正确的环境变量,确保 Codex 使用账号专属的配置
- 避免 fallback 到全局配置

### 修复 3: 提供辅助脚本方便添加 Provider

**文件**: `scripts/add-codex-provider.sh`

创建了一个 Bash 脚本,方便用户为指定账号添加自定义 Provider:

```bash
#!/bin/bash
# 用法: ./scripts/add-codex-provider.sh <account_id> <provider_name> <base_url> [api_key_env]

ACCOUNT_ID=$1
PROVIDER_NAME=$2
BASE_URL=$3
API_KEY_ENV=${4:-"OPENAI_API_KEY"}

# 创建或更新账号专属的 config.toml
CONFIG_PATH="${REAL_HOME}/.ai_home/profiles/codex/${ACCOUNT_ID}/.codex/config.toml"

# 添加 provider 配置
cat >> "$CONFIG_PATH" <<EOF

[[providers]]
name = "${PROVIDER_NAME}"
base_url = "${BASE_URL}"
api_key_env = "${API_KEY_ENV}"
EOF
```

**使用示例**:
```bash
# 为账号 10 添加 Replit provider
./scripts/add-codex-provider.sh 10 replit1 "https://xxx.replit.dev"

# 为账号 10 添加本地 aih server
./scripts/add-codex-provider.sh 10 local-aih "http://localhost:8317/v1"
```

## 📊 修复前后对比

### 修复前

```bash
# 目录结构
~/.ai_home/profiles/codex/10/.codex/
└── config.toml -> ~/.codex/config.toml  # ❌ 软链接到全局配置

# 启动账号 10
aih codex 10

# 在 Codex 中
/provider
# 显示: 全局配置中的 providers

/status
# Model provider: aih codex - http://127.0.0.1:8317/v1
# (来自 ~/.codex/config.toml)
```

### 修复后

```bash
# 目录结构
~/.ai_home/profiles/codex/10/.codex/
└── config.toml  # ✅ 真实的文件,账号专属配置

# 配置内容
cat ~/.ai_home/profiles/codex/10/.codex/config.toml
# Codex configuration for account 10
# This file is managed by ai-home (aih)
# Add your custom providers here

[[providers]]
name = "replit1"
base_url = "https://ad4ee30b-9282-4c7d-8d32-0ac9f79188ec-00-2r4nq0xubnbk9.riker.replit.dev"
api_key_env = "OPENAI_API_KEY"

# 启动账号 10
aih codex 10

# 在 Codex 中
/provider
# 显示: replit1  # ✅ 账号专属的 provider

/provider replit1  # 切换到 Replit provider

/status
# Model provider: replit1 - https://xxx.replit.dev
# ✅ 使用账号专属的配置
```

## 🧪 测试验证

### 测试 1: 验证配置文件隔离

```bash
# 1. 为账号 10 添加 Replit provider
./scripts/add-codex-provider.sh 10 replit1 "https://instance1.replit.dev"

# 2. 为账号 11 添加不同的 provider
./scripts/add-codex-provider.sh 11 replit2 "https://instance2.replit.dev"

# 3. 验证配置文件是独立的
cat ~/.ai_home/profiles/codex/10/.codex/config.toml
# 应该只包含 replit1

cat ~/.ai_home/profiles/codex/11/.codex/config.toml
# 应该只包含 replit2

# 4. 启动账号 10
aih codex 10

# 在 Codex 中执行
/provider
# 应该只看到 replit1

# 5. 退出并启动账号 11
exit
aih codex 11

# 在 Codex 中执行
/provider
# 应该只看到 replit2
```

### 测试 2: 验证不会 fallback 到全局配置

```bash
# 1. 清空账号 99 的配置目录
rm -rf ~/.ai_home/profiles/codex/99

# 2. 启动账号 99(第一次)
aih codex 99

# 3. 检查是否自动创建了配置文件
ls -la ~/.ai_home/profiles/codex/99/.codex/config.toml
# 应该显示: -rw-r--r-- (真实文件,不是软链接)

cat ~/.ai_home/profiles/codex/99/.codex/config.toml
# 应该显示:
# # Codex configuration for account 99
# # This file is managed by ai-home (aih)
# # Add your custom providers here
```

### 测试 3: 验证旧账号的软链接清理

```bash
# 1. 检查现有账号是否还有软链接
for id in $(ls ~/.ai_home/profiles/codex/); do
  if [ -L ~/.ai_home/profiles/codex/$id/.codex/config.toml ]; then
    echo "账号 $id 的 config.toml 仍是软链接"
  fi
done

# 2. 手动清理旧软链接(如果需要)
for id in $(ls ~/.ai_home/profiles/codex/); do
  config_path=~/.ai_home/profiles/codex/$id/.codex/config.toml
  if [ -L "$config_path" ]; then
    echo "清理账号 $id 的软链接"
    rm -f "$config_path"
    # 创建空配置
    cat > "$config_path" <<EOF
# Codex configuration for account $id
# This file is managed by ai-home (aih)
# Add your custom providers here

EOF
  fi
done
```

## 📝 迁移指南

### 对于现有账号

如果你已经有正在使用的账号,需要手动迁移:

**步骤 1: 检查哪些账号需要迁移**
```bash
cd ~/.ai_home/profiles/codex
for id in */; do
  id=${id%/}
  if [ -L "$id/.codex/config.toml" ]; then
    echo "账号 $id 需要迁移"
  fi
done
```

**步骤 2: 迁移单个账号**
```bash
ACCOUNT_ID=10

# 备份全局配置(可选)
cp ~/.codex/config.toml ~/.codex/config.toml.backup

# 删除软链接
rm -f ~/.ai_home/profiles/codex/$ACCOUNT_ID/.codex/config.toml

# 创建独立配置(从全局配置复制或创建空配置)
# 选项 A: 从全局配置复制(如果需要保留全局 providers)
cp ~/.codex/config.toml ~/.ai_home/profiles/codex/$ACCOUNT_ID/.codex/config.toml

# 选项 B: 创建空配置(推荐,干净的开始)
cat > ~/.ai_home/profiles/codex/$ACCOUNT_ID/.codex/config.toml <<EOF
# Codex configuration for account $ACCOUNT_ID
# This file is managed by ai-home (aih)
# Add your custom providers here

EOF

# 为账号添加自定义 provider
./scripts/add-codex-provider.sh $ACCOUNT_ID replit1 "https://xxx.replit.dev"
```

**步骤 3: 批量迁移所有账号**
```bash
cd ~/.ai_home/profiles/codex
for id_dir in */; do
  id=${id_dir%/}
  config_path="$id/.codex/config.toml"

  if [ -L "$config_path" ]; then
    echo "迁移账号 $id..."
    rm -f "$config_path"

    # 创建空配置
    cat > "$config_path" <<EOF
# Codex configuration for account $id
# This file is managed by ai-home (aih)
# Add your custom providers here

EOF
    echo "✅ 账号 $id 迁移完成"
  fi
done
```

## 🔧 故障排查

### 问题 1: 启动账号后仍然使用全局配置

**症状**: `/provider` 显示的是全局配置中的 providers

**检查步骤**:
```bash
# 1. 检查配置文件是否是软链接
ls -la ~/.ai_home/profiles/codex/10/.codex/config.toml

# 如果显示: lrwxr-xr-x (软链接)
# 解决: 删除软链接并创建独立配置
rm -f ~/.ai_home/profiles/codex/10/.codex/config.toml
cat > ~/.ai_home/profiles/codex/10/.codex/config.toml <<EOF
# Codex configuration for account 10
EOF

# 2. 检查 CODEX_HOME 环境变量
aih codex 10
# 在 Codex 中执行
/shell env | grep CODEX_HOME
# 应该显示: CODEX_HOME=/Users/model/.ai_home/profiles/codex/10/.codex
```

### 问题 2: 添加 provider 后不显示

**症状**: 添加了 provider 但 `/provider` 看不到

**检查步骤**:
```bash
# 1. 检查配置文件语法
cat ~/.ai_home/profiles/codex/10/.codex/config.toml

# 确保使用双方括号
# ✅ [[providers]]
# ❌ [providers]

# 确保使用下划线
# ✅ base_url = "..."
# ❌ base-url = "..."

# 2. 重启账号
exit
aih codex 10
/provider
```

### 问题 3: 环境变量 API Key 未生效

**症状**: Provider 提示 API Key 无效

**解决方案**:
```bash
# 编辑账号专属环境变量
vim ~/.ai_home/profiles/codex/10/.aih_env.json

# 添加 API Key
{
  "OPENAI_API_KEY": "your-api-key-here",
  "MY_CUSTOM_API_KEY": "another-key"
}

# 重启账号
exit
aih codex 10
```

## 🎯 最佳实践

### 1. 每个账号使用独立的 Provider

```bash
# 开发环境 (账号 1)
./scripts/add-codex-provider.sh 1 dev-api "https://dev.api.example.com"

# 测试环境 (账号 2)
./scripts/add-codex-provider.sh 2 test-api "https://test.api.example.com"

# 生产环境 (账号 3)
./scripts/add-codex-provider.sh 3 prod-api "https://api.example.com"
```

### 2. 使用环境变量管理 API Key

✅ **推荐**: 使用 `.aih_env.json`
```json
{
  "REPLIT_API_KEY": "your-secret-key"
}
```

```toml
[[providers]]
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key_env = "REPLIT_API_KEY"
```

❌ **不推荐**: 明文存储
```toml
[[providers]]
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key = "sk-plaintext-key"  # 不安全
```

### 3. 定期备份配置

```bash
# 备份所有账号的配置
tar -czf codex-configs-$(date +%Y%m%d).tar.gz \
  ~/.ai_home/profiles/codex/*/. codex/config.toml
```

## 📚 相关文档

- [多账号隔离机制说明](MULTI_ACCOUNT_ISOLATION.md)
- [自定义 Provider 配置](CUSTOM_PROVIDER_PER_ACCOUNT.md)
- [Token 自动刷新功能](TOKEN_AUTO_REFRESH.md)

---

**版本**: v1.0.0
**最后更新**: 2026-04-07
**作者**: ai-home 开发团队
