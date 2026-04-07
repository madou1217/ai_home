# Config.toml 历史账号迁移指南

## 🎯 目的

这个迁移脚本用于修复历史存量 Codex 账号的 `config.toml` 仍然使用非独立配置(软链接到全局配置)的问题。

## 📋 问题背景

在早期版本中,`config.toml` 被错误地加入到 `SESSION_STORE_ALLOWLIST` 中,导致:

- 所有账号的 `~/.ai_home/profiles/codex/{id}/.codex/config.toml` 都是软链接
- 软链接指向 `~/.codex/config.toml`(全局配置)
- **无法为不同账号配置独立的 Provider**

### 修复前的问题

```bash
# 所有账号都使用同一个配置
~/.ai_home/profiles/codex/10/.codex/config.toml -> ~/.codex/config.toml
~/.ai_home/profiles/codex/11/.codex/config.toml -> ~/.codex/config.toml

# 问题:无法为账号 10 单独配置 Replit Provider
```

### 修复后的效果

```bash
# 每个账号都有独立的配置文件
~/.ai_home/profiles/codex/10/.codex/config.toml  # 真实文件,账号 10 专属
~/.ai_home/profiles/codex/11/.codex/config.toml  # 真实文件,账号 11 专属

# 可以为不同账号配置不同的 Provider
```

## 🚀 使用方法

### 方法 1: 直接运行迁移脚本

```bash
# 进入项目目录
cd /path/to/ai_home

# 运行迁移脚本
node scripts/migrate-codex-config.js
```

### 方法 2: 使用 npm 脚本(如果已配置)

```bash
npm run migrate:config
```

## 📊 迁移脚本行为

脚本会自动检测所有 Codex 账号的配置状态,并执行相应操作:

### 情况 1: 软链接 → 独立文件(迁移)

```bash
输入: ~/.ai_home/profiles/codex/10/.codex/config.toml -> ~/.codex/config.toml
输出: ~/.ai_home/profiles/codex/10/.codex/config.toml (独立文件)
```

- 删除软链接
- 创建独立配置文件
- **保留全局配置中的自定义 `[[providers]]`**

### 情况 2: 不存在 → 创建默认配置

```bash
输入: ~/.ai_home/profiles/codex/10/.codex/config.toml (不存在)
输出: ~/.ai_home/profiles/codex/10/.codex/config.toml (新建文件)
```

- 创建默认配置文件
- 包含注释和示例

### 情况 3: 已是独立文件 → 跳过

```bash
输入: ~/.ai_home/profiles/codex/10/.codex/config.toml (真实文件)
输出: 跳过,不做任何修改
```

## 📝 迁移脚本输出示例

```bash
============================================================
Codex Config.toml 迁移脚本
============================================================

找到 3 个 Codex 账号: 1, 10, 11

开始迁移:

  [迁移] 账号 1: 从软链接转换为独立文件
    - 原软链接目标: /Users/model/.codex/config.toml
    - 保留 1 个自定义 provider 配置
    ✓ 迁移完成
  [跳过] 账号 10: 已经是独立配置文件
  [创建] 账号 11: 创建新的独立配置文件

============================================================
迁移完成
============================================================

统计信息:
  - 总账号数: 3
  - 新创建: 1
  - 已迁移: 1
  - 已跳过: 1
  - 错误: 0

✓ 成功将 1 个账号从软链接迁移为独立配置

后续步骤:
1. 使用 ./scripts/add-codex-provider.sh 为账号添加自定义 provider
2. 或手动编辑 ~/.ai_home/profiles/codex/<ID>/.codex/config.toml
```

## 🔍 迁移后验证

### 验证 1: 检查是否还有软链接

```bash
# 检查所有账号的 config.toml 是否还是软链接
for id in $(ls ~/.ai_home/profiles/codex/); do
  config_path=~/.ai_home/profiles/codex/$id/.codex/config.toml
  if [ -L "$config_path" ]; then
    echo "❌ 账号 $id 仍是软链接"
  else
    echo "✓ 账号 $id 已是独立文件"
  fi
done
```

### 验证 2: 检查配置文件内容

```bash
# 查看账号 10 的配置
cat ~/.ai_home/profiles/codex/10/.codex/config.toml

# 应该看到:
# # Codex configuration for account 10
# # This file is managed by ai-home (aih)
# # Add your custom providers here
```

### 验证 3: 在 Codex 中验证

```bash
# 启动账号 10
aih codex 10

# 在 Codex 中执行
/provider

# 应该只看到账号 10 专属的 providers,而不是全局配置中的
```

## 📌 迁移后配置 Provider

迁移完成后,有两种方式为账号添加自定义 Provider:

### 方式 1: 使用辅助脚本(推荐)

```bash
# 为账号 10 添加 Replit provider
./scripts/add-codex-provider.sh 10 replit1 "https://your-instance.replit.dev"

# 为账号 10 添加本地 aih server
./scripts/add-codex-provider.sh 10 local-aih "http://localhost:8317/v1"
```

### 方式 2: 手动编辑配置文件

```bash
# 编辑账号 10 的配置
vim ~/.ai_home/profiles/codex/10/.codex/config.toml
```

添加以下内容:

```toml
[[providers]]
name = "my-provider"
base_url = "https://api.example.com/v1"
api_key_env = "MY_API_KEY"
```

## ⚠️ 注意事项

### 1. 备份建议

虽然脚本会自动处理,但建议先备份:

```bash
# 备份全局配置
cp ~/.codex/config.toml ~/.codex/config.toml.backup

# 备份整个 ai_home 目录(可选)
tar -czf ~/ai_home_backup_$(date +%Y%m%d).tar.gz ~/.ai_home
```

### 2. 全局配置中的 Provider

- 迁移脚本会**自动保留**全局配置中的 `[[providers]]` 配置
- 迁移后,每个账号都会有这些 providers 的副本
- 如果不需要某个 provider,可以手动从账号配置中删除

### 3. 新账号

- 迁移脚本只处理现有账号
- 新创建的账号会自动使用独立配置(不会创建软链接)
- 这是因为 `config.toml` 已从 `SESSION_STORE_ALLOWLIST` 中移除

## 🧪 测试

迁移脚本包含完整的单元测试:

```bash
# 运行迁移脚本测试
npm test test/migrate-codex-config.test.js

# 或运行所有测试
npm test
```

## 🔗 相关文档

- [Config.toml 隔离修复说明](CONFIG_ISOLATION_FIX.md)
- [自定义 Provider 配置](CUSTOM_PROVIDER_PER_ACCOUNT.md)
- [添加 Codex Provider 脚本](../scripts/add-codex-provider.sh)

## 📞 故障排查

### 问题 1: 迁移后仍显示全局 Provider

**症状**: 启动账号后,`/provider` 显示的是全局配置中的 providers

**解决方案**:

```bash
# 1. 确认配置文件已不是软链接
ls -la ~/.ai_home/profiles/codex/10/.codex/config.toml

# 2. 如果仍是软链接,手动删除并重新运行迁移
rm -f ~/.ai_home/profiles/codex/10/.codex/config.toml
node scripts/migrate-codex-config.js

# 3. 重启账号
exit
aih codex 10
```

### 问题 2: 迁移脚本报错

**症状**: 脚本执行时出现权限错误或文件不存在

**解决方案**:

```bash
# 1. 检查目录权限
ls -ld ~/.ai_home/profiles/codex/

# 2. 确保目录存在
mkdir -p ~/.ai_home/profiles/codex/

# 3. 重新运行脚本
node scripts/migrate-codex-config.js
```

### 问题 3: Provider 配置丢失

**症状**: 迁移后,之前配置的自定义 provider 消失了

**解决方案**:

```bash
# 1. 检查全局配置备份
cat ~/.codex/config.toml.backup

# 2. 手动复制 provider 配置到账号配置
# 从备份中复制 [[providers]] 部分到:
vim ~/.ai_home/profiles/codex/10/.codex/config.toml

# 3. 重启账号使配置生效
```

---

**版本**: v1.0.0
**最后更新**: 2026-04-07
**作者**: ai-home 开发团队
