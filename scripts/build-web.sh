#!/bin/bash

# AI Home Web UI 构建脚本

set -e

echo "🏗️  开始构建 AI Home Web UI..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js，请先安装 Node.js"
    exit 1
fi

# 进入 web 目录
cd "$(dirname "$0")/../web"

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
fi

# 清理旧的构建产物
echo "🧹 清理旧的构建产物..."
rm -rf dist

# 构建
echo "⚙️  编译 TypeScript 和打包..."
npm run build

# 检查构建结果
if [ -d "dist" ] && [ -f "dist/index.html" ]; then
    echo "✅ Web UI 构建成功！"
    echo "📂 构建产物位置: $(pwd)/dist"
    echo ""
    echo "💡 提示："
    echo "   - 启动服务器: aih server"
    echo "   - 访问 Web UI: http://127.0.0.1:8317/ui/"
else
    echo "❌ 构建失败，请检查错误信息"
    exit 1
fi
