# Codex API Key 持久化机制

## 🐛 问题背景

### 用户遇到的问题

```bash
# 第一次使用 API Key 模式
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=http://localhost:8317/v1
aih codex 10
# ✅ 正常工作

# 退出后再次启动
aih codex 10
# ❌ [Notice] Account 10 exists but seems to have no login state.
# ❌ Do you want to run the login flow for Account 10 now? [Y/n]:
```

### 根本原因

**Codex 的 API Key 机制**:
- Codex 通过环境变量 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 使用 API Key 模式
- 环境变量是**临时的**,只在当前 shell 会话中有效
- 退出 shell 后,环境变量丢失

**aih 的问题**:
- 用户在 shell 中 `export OPENAI_API_KEY`
- aih 启动时能读到环境变量,Codex 正常工作
- 但 aih **没有持久化**这些环境变量
- 退出后再启动,找不到 API Key,判定为"未登录"

## ✅ 解决方案

### 自动检测和持久化

当启动 Codex 账号时,aih 会自动检测环境变量中的 `OPENAI_API_KEY`:
- 如果发现环境变量中有 API Key,但 `.aih_env.json` 中没有
- 自动保存到 `~/.ai_home/profiles/codex/{id}/.aih_env.json`
- 下次启动时自动加载,无需重新设置

### 实现逻辑

```javascript
// 启动账号时 (lib/cli/services/pty/runtime.js)
function spawnPty(cliName, cliBin, id, forwardArgs, isLogin) {
  const sandboxDir = getProfileDir(cliName, id);

  // 1. 读取已保存的环境变量
  let loadedEnv = {};
  const envPath = path.join(sandboxDir, '.aih_env.json');
  if (fs.existsSync(envPath)) {
    loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  }

  // 2. 检测当前环境变量
  if (cliName === 'codex') {
    const hasApiKeyInProcess = !!process.env.OPENAI_API_KEY;
    const hasApiKeyInSaved = !!loadedEnv.OPENAI_API_KEY;
    const hasBaseUrlInProcess = !!process.env.OPENAI_BASE_URL;

    // 3. 如果环境变量有,但保存的配置没有,则自动保存
    if (hasApiKeyInProcess && !hasApiKeyInSaved) {
      const envToSave = { ...loadedEnv };
      envToSave.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if (hasBaseUrlInProcess) {
        envToSave.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
      }
      fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2));
      console.log('[aih] Detected OPENAI_API_KEY, saved for persistence.');
    }
  }

  // 4. 启动时合并环境变量
  const envOverrides = {
    ...process.env,
    ...loadedEnv,  // 加载保存的环境变量
    HOME: sandboxDir,
    // ...
  };
}
```

## 📋 使用方法

### 方法 1: 自动持久化 (推荐)

```bash
# 1. 设置环境变量
export OPENAI_API_KEY=sk-your-api-key
export OPENAI_BASE_URL=http://localhost:8317/v1

# 2. 首次启动账号
aih codex 10
# 输出: [aih] Detected OPENAI_API_KEY in environment, saved to account config for persistence.

# 3. 退出

# 4. 下次启动 (无需重新 export)
aih codex 10
# ✅ 直接启动,自动加载保存的 API Key
```

### 方法 2: 手动编辑配置文件

```bash
# 1. 编辑账号环境变量配置
vim ~/.ai_home/profiles/codex/10/.aih_env.json

# 2. 添加内容
{
  "OPENAI_API_KEY": "sk-your-api-key",
  "OPENAI_BASE_URL": "http://localhost:8317/v1"
}

# 3. 启动账号
aih codex 10
# ✅ 自动加载 API Key
```

### 方法 3: 使用脚本快速配置

```bash
# 创建辅助脚本
cat > set-codex-apikey.sh <<'EOF'
#!/bin/bash
ACCOUNT_ID=$1
API_KEY=$2
BASE_URL=${3:-"https://api.openai.com/v1"}

if [ -z "$ACCOUNT_ID" ] || [ -z "$API_KEY" ]; then
  echo "Usage: $0 <account_id> <api_key> [base_url]"
  exit 1
fi

ENV_FILE=~/.ai_home/profiles/codex/${ACCOUNT_ID}/.aih_env.json
mkdir -p $(dirname "$ENV_FILE")

cat > "$ENV_FILE" <<EOJ
{
  "OPENAI_API_KEY": "${API_KEY}",
  "OPENAI_BASE_URL": "${BASE_URL}"
}
EOJ

echo "✅ API Key configured for account ${ACCOUNT_ID}"
echo "   File: ${ENV_FILE}"
EOF

chmod +x set-codex-apikey.sh

# 使用
./set-codex-apikey.sh 10 sk-your-key http://localhost:8317/v1
```

## 🔒 安全性

### 文件权限

`.aih_env.json` 文件包含敏感的 API Key,应该设置适当的权限:

```bash
# 检查权限
ls -la ~/.ai_home/profiles/codex/10/.aih_env.json
# 应该是: -rw------- (600) 或 -rw-r--r-- (644)

# 如果需要,设置更严格的权限
chmod 600 ~/.ai_home/profiles/codex/10/.aih_env.json
```

### 环境变量隔离

每个账号的环境变量是**完全隔离**的:

```bash
# 账号 10 的配置
~/.ai_home/profiles/codex/10/.aih_env.json
{
  "OPENAI_API_KEY": "sk-key-for-account-10"
}

# 账号 11 的配置
~/.ai_home/profiles/codex/11/.aih_env.json
{
  "OPENAI_API_KEY": "sk-key-for-account-11"
}
```

启动不同账号时,使用各自的 API Key,互不干扰。

### 不建议的做法

❌ **不要在全局环境中永久设置 API Key**:

```bash
# ❌ 不推荐: 添加到 ~/.bashrc 或 ~/.zshrc
echo 'export OPENAI_API_KEY=sk-xxx' >> ~/.bashrc

# 原因:
# 1. 所有 shell 会话都会暴露 API Key
# 2. 如果有其他程序也使用 OPENAI_API_KEY,可能冲突
# 3. 不够灵活,无法为不同账号设置不同的 Key
```

✅ **推荐**: 使用 aih 的账号专属配置:

```bash
# ✅ 推荐: 为每个账号单独配置
vim ~/.ai_home/profiles/codex/10/.aih_env.json
```

## 📊 配置优先级

当同时存在多个配置源时,优先级如下:

```
1. .aih_env.json (账号专属,最高优先级)
   ↓
2. 当前 shell 环境变量 (如果首次启动会自动保存到 .aih_env.json)
   ↓
3. auth.json (OAuth 认证,不适用于 API Key 模式)
```

**示例**:

```bash
# 场景 1: 已有 .aih_env.json
cat ~/.ai_home/profiles/codex/10/.aih_env.json
# { "OPENAI_API_KEY": "sk-saved-key" }

export OPENAI_API_KEY=sk-temp-key
aih codex 10
# 使用: sk-saved-key (来自 .aih_env.json,不会被环境变量覆盖)

# 场景 2: 没有 .aih_env.json
export OPENAI_API_KEY=sk-new-key
aih codex 10
# 使用: sk-new-key (来自环境变量,并自动保存到 .aih_env.json)
```

## 🧪 测试验证

### 测试 1: 自动保存环境变量

```bash
# 1. 删除现有配置
rm -f ~/.ai_home/profiles/codex/99/.aih_env.json

# 2. 设置环境变量
export OPENAI_API_KEY=sk-test-key-99
export OPENAI_BASE_URL=http://localhost:8000

# 3. 启动账号
aih codex 99
# 应该看到: [aih] Detected OPENAI_API_KEY in environment, saved to account config for persistence.

# 4. 验证保存成功
cat ~/.ai_home/profiles/codex/99/.aih_env.json
# 应该包含:
# {
#   "OPENAI_API_KEY": "sk-test-key-99",
#   "OPENAI_BASE_URL": "http://localhost:8000"
# }

# 5. 退出

# 6. 不设置环境变量,直接启动
unset OPENAI_API_KEY
unset OPENAI_BASE_URL
aih codex 99
# ✅ 应该正常启动,不提示"未登录"
```

### 测试 2: 不覆盖已有配置

```bash
# 1. 手动创建配置
mkdir -p ~/.ai_home/profiles/codex/88
cat > ~/.ai_home/profiles/codex/88/.aih_env.json <<EOF
{
  "OPENAI_API_KEY": "sk-original-key",
  "OPENAI_BASE_URL": "https://original.api.com",
  "CUSTOM_VAR": "custom-value"
}
EOF

# 2. 设置不同的环境变量
export OPENAI_API_KEY=sk-new-key
export OPENAI_BASE_URL=http://localhost:9000

# 3. 启动账号
aih codex 88
# 应该不显示"Detected OPENAI_API_KEY"消息 (因为已有配置)

# 4. 验证配置未被覆盖
cat ~/.ai_home/profiles/codex/88/.aih_env.json
# 应该保持原样:
# {
#   "OPENAI_API_KEY": "sk-original-key",  ← 未被覆盖
#   "OPENAI_BASE_URL": "https://original.api.com",  ← 未被覆盖
#   "CUSTOM_VAR": "custom-value"  ← 保持不变
# }
```

### 测试 3: 账号状态正确识别

```bash
# 1. 配置 API Key
export OPENAI_API_KEY=sk-test
aih codex 77

# 2. 退出后重新启动
exit
aih codex 77

# ✅ 应该直接启动,不提示"未登录"

# 3. 查看账号列表
aih codex ls

# 应该显示:
# - Account ID: 77 [Active] (API Key: sk-te...test) [Remaining: API Key mode]
#   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#   正确识别为 API Key 模式
```

## 🔧 故障排查

### 问题 1: 仍然提示"未登录"

**症状**:
```bash
aih codex 10
# [Notice] Account 10 exists but seems to have no login state.
```

**排查步骤**:

```bash
# 1. 检查 .aih_env.json 是否存在
ls -la ~/.ai_home/profiles/codex/10/.aih_env.json

# 2. 检查内容
cat ~/.ai_home/profiles/codex/10/.aih_env.json

# 3. 确认有 OPENAI_API_KEY
cat ~/.ai_home/profiles/codex/10/.aih_env.json | grep OPENAI_API_KEY

# 4. 如果没有,手动创建
cat > ~/.ai_home/profiles/codex/10/.aih_env.json <<EOF
{
  "OPENAI_API_KEY": "sk-your-key",
  "OPENAI_BASE_URL": "http://localhost:8317/v1"
}
EOF
```

### 问题 2: API Key 不生效

**症状**: 启动后 Codex 提示 API Key 无效或未设置

**排查步骤**:

```bash
# 1. 启动账号并检查环境变量
aih codex 10

# 2. 在 Codex 中执行
/shell env | grep OPENAI

# 应该看到:
# OPENAI_API_KEY=sk-your-key
# OPENAI_BASE_URL=http://localhost:8317/v1

# 如果没有,检查 .aih_env.json 的 JSON 格式
cat ~/.ai_home/profiles/codex/10/.aih_env.json
# 确保是有效的 JSON (使用双引号,不是单引号)
```

### 问题 3: 环境变量被覆盖

**症状**: 修改了 `.aih_env.json`,但启动后使用的是旧的 API Key

**原因**: 当前 shell 环境变量优先级更高

**解决方案**:

```bash
# 方法 1: 取消环境变量
unset OPENAI_API_KEY
unset OPENAI_BASE_URL
aih codex 10

# 方法 2: 使用新 shell 会话
bash
aih codex 10
```

## 📝 最佳实践

### 1. 为不同账号配置不同的 API Key

```bash
# 开发环境 API Key (账号 1)
cat > ~/.ai_home/profiles/codex/1/.aih_env.json <<EOF
{
  "OPENAI_API_KEY": "sk-dev-key",
  "OPENAI_BASE_URL": "http://localhost:8000/v1"
}
EOF

# 生产环境 API Key (账号 2)
cat > ~/.ai_home/profiles/codex/2/.aih_env.json <<EOF
{
  "OPENAI_API_KEY": "sk-prod-key",
  "OPENAI_BASE_URL": "https://api.openai.com/v1"
}
EOF
```

### 2. 使用环境变量别名

为不同账号创建 shell 别名:

```bash
# 添加到 ~/.bashrc 或 ~/.zshrc
alias codex-dev='OPENAI_API_KEY=sk-dev aih codex 1'
alias codex-prod='OPENAI_API_KEY=sk-prod aih codex 2'
alias codex-local='OPENAI_API_KEY=dummy OPENAI_BASE_URL=http://localhost:8317/v1 aih codex 10'
```

### 3. 保护 API Key

```bash
# 1. 设置严格的文件权限
chmod 600 ~/.ai_home/profiles/codex/*/. aih_env.json

# 2. 添加到 .gitignore (如果备份配置到 git)
echo '.aih_env.json' >> ~/.ai_home/.gitignore

# 3. 定期轮换 API Key
# 更新所有账号的 API Key:
for id in $(ls ~/.ai_home/profiles/codex/); do
  vim ~/.ai_home/profiles/codex/$id/.aih_env.json
done
```

### 4. 备份配置

```bash
# 备份所有账号的 API Key 配置
tar -czf aih-apikeys-backup-$(date +%Y%m%d).tar.gz \
  ~/.ai_home/profiles/codex/*/.aih_env.json

# 恢复
tar -xzf aih-apikeys-backup-YYYYMMDD.tar.gz -C /
```

## 🔄 迁移指南

### 从手动 export 迁移到 aih 管理

**之前的方式**:
```bash
# ~/.bashrc
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=http://localhost:8317/v1
codex  # 直接使用 codex
```

**迁移到 aih**:
```bash
# 1. 删除 ~/.bashrc 中的 export 语句

# 2. 为每个需要的账号配置 API Key
cat > ~/.ai_home/profiles/codex/10/.aih_env.json <<EOF
{
  "OPENAI_API_KEY": "sk-xxx",
  "OPENAI_BASE_URL": "http://localhost:8317/v1"
}
EOF

# 3. 使用 aih 启动
aih codex 10
```

**优势**:
- ✅ 支持多个 API Key (不同账号不同 Key)
- ✅ 自动持久化,无需每次 export
- ✅ 账号隔离,互不干扰

---

**版本**: v1.0.0
**最后更新**: 2026-04-07
**作者**: ai-home 开发团队
