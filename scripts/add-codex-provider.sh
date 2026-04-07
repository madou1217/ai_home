#!/bin/bash
# 为指定的 Codex 账号添加自定义 Provider
# 用法: ./add-codex-provider.sh <account_id> <provider_name> <base_url> [api_key_env]

set -e

ACCOUNT_ID=$1
PROVIDER_NAME=$2
BASE_URL=$3
API_KEY_ENV=${4:-"OPENAI_API_KEY"}

if [ -z "$ACCOUNT_ID" ] || [ -z "$PROVIDER_NAME" ] || [ -z "$BASE_URL" ]; then
  echo "❌ 缺少必需参数"
  echo ""
  echo "用法:"
  echo "  $0 <account_id> <provider_name> <base_url> [api_key_env]"
  echo ""
  echo "参数说明:"
  echo "  account_id    账号 ID (数字)"
  echo "  provider_name Provider 名称 (小写字母,短横线连接)"
  echo "  base_url      Provider 的 Base URL"
  echo "  api_key_env   API Key 环境变量名 (可选,默认: OPENAI_API_KEY)"
  echo ""
  echo "示例:"
  echo "  $0 10 replit1 https://xxx.replit.dev"
  echo "  $0 10 local-aih http://localhost:8317/v1"
  echo "  $0 11 custom-api https://api.example.com MY_API_KEY"
  exit 1
fi

# 验证账号 ID 是数字
if ! [[ "$ACCOUNT_ID" =~ ^[0-9]+$ ]]; then
  echo "❌ 错误: 账号 ID 必须是数字"
  exit 1
fi

# 验证 Provider 名称格式
if ! [[ "$PROVIDER_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "❌ 错误: Provider 名称只能包含小写字母、数字和短横线"
  exit 1
fi

# 验证 URL 格式
if ! [[ "$BASE_URL" =~ ^https?:// ]]; then
  echo "❌ 错误: Base URL 必须以 http:// 或 https:// 开头"
  exit 1
fi

# 使用真实用户的 HOME 目录,而不是被 aih 覆盖的 HOME
REAL_HOME="${REAL_HOME:-$HOME}"
if [[ "$HOME" =~ \.ai_home/profiles ]]; then
  # 当前在 aih 沙盒中,提取真实 HOME
  REAL_HOME=$(echo "$HOME" | sed 's|/.ai_home/profiles/[^/]*/[^/]*||')
fi

CONFIG_DIR="${REAL_HOME}/.ai_home/profiles/codex/${ACCOUNT_ID}/.codex"
CONFIG_PATH="${CONFIG_DIR}/config.toml"

# 确保目录存在
mkdir -p "$CONFIG_DIR"

# 如果文件不存在,创建头部
if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" <<EOF
# Codex configuration for account ${ACCOUNT_ID}
# This file is managed by ai-home (aih)
# Add your custom providers here

EOF
  echo "📄 创建配置文件: ${CONFIG_PATH}"
fi

# 检查 provider 是否已存在
if grep -q "name = \"${PROVIDER_NAME}\"" "$CONFIG_PATH" 2>/dev/null; then
  echo "⚠️  警告: Provider '${PROVIDER_NAME}' 已存在于账号 ${ACCOUNT_ID} 的配置中"
  echo "📄 配置文件: ${CONFIG_PATH}"
  echo ""
  read -p "是否覆盖? [y/N]: " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 取消操作"
    exit 1
  fi

  # 删除旧的 provider 配置
  # 使用临时文件避免原地编辑问题
  TMP_FILE=$(mktemp)
  awk -v name="$PROVIDER_NAME" '
    BEGIN { skip=0 }
    /^\[\[providers\]\]/ {
      if (skip == 1) skip = 0
      block = $0
      next
    }
    skip == 1 { next }
    block != "" {
      if (/^name = /) {
        if ($0 ~ "\"" name "\"") {
          skip = 1
          block = ""
          next
        }
      }
      print block
      block = ""
    }
    { print }
    END { if (block != "") print block }
  ' "$CONFIG_PATH" > "$TMP_FILE"
  mv "$TMP_FILE" "$CONFIG_PATH"
fi

# 添加 provider 配置
cat >> "$CONFIG_PATH" <<EOF

[[providers]]
name = "${PROVIDER_NAME}"
base_url = "${BASE_URL}"
api_key_env = "${API_KEY_ENV}"
EOF

echo "✅ 成功添加 provider '${PROVIDER_NAME}' 到账号 ${ACCOUNT_ID}"
echo ""
echo "📋 配置信息:"
echo "  Provider 名称: ${PROVIDER_NAME}"
echo "  Base URL:      ${BASE_URL}"
echo "  API Key 环境变量: ${API_KEY_ENV}"
echo "  配置文件:      ${CONFIG_PATH}"
echo ""
echo "🚀 使用方法:"
echo "  1. 启动账号: aih codex ${ACCOUNT_ID}"
echo "  2. 在 Codex 中切换 provider: /provider ${PROVIDER_NAME}"
echo "  3. 验证配置: /status"
echo ""

if [ "$API_KEY_ENV" != "OPENAI_API_KEY" ]; then
  ENV_FILE="${REAL_HOME}/.ai_home/profiles/codex/${ACCOUNT_ID}/.aih_env.json"
  echo "💡 提示: 记得在环境变量文件中配置 ${API_KEY_ENV}"
  echo "  编辑: vim ${ENV_FILE}"
  echo "  添加: {\"${API_KEY_ENV}\": \"your-api-key-here\"}"
  echo ""
fi
