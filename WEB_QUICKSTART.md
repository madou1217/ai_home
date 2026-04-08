# AI Home Web UI 快速入门

## 🚀 5 分钟快速开始

### 第 1 步：安装前端依赖

```bash
npm run web:install
```

### 第 2 步：构建 Web UI

```bash
npm run web:build
```

### 第 3 步：启动服务器

```bash
aih server
```

### 第 4 步：访问 Web UI

在浏览器中打开：

```
http://127.0.0.1:8317/ui/
```

就这么简单！🎉

---

## 📚 核心功能

### 1️⃣ 仪表盘
- 查看所有账号的实时状态
- 监控账号健康度和剩余额度
- 自动刷新数据

### 2️⃣ 账号管理
- ➕ 添加新账号（支持 Codex、Gemini、Claude）
- 🔑 支持 OAuth 和 API Key 两种认证方式
- 🗑️ 删除账号

### 3️⃣ 会话交互
- 💬 直接在浏览器中与 AI 对话
- 🔄 支持多轮对话
- 🤖 自动选择最佳可用账号

### 4️⃣ 系统设置
- ⚙️ 配置自动切换阈值
- 🔄 设置额度刷新间隔
- 💾 保存和恢复配置

---

## 🛠️ 开发模式

如果您想修改或调试 Web UI：

```bash
cd web
npm run dev
```

开发服务器将在 `http://localhost:3000` 启动，支持热重载。

---

## 📖 详细文档

查看完整文档：[docs/WEB_UI.md](docs/WEB_UI.md)

---

## ❓ 常见问题

### Q: Web UI 构建失败怎么办？

A: 确保 Node.js 版本 >= 18，然后重新安装依赖：

```bash
cd web
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Q: 如何在生产环境部署？

A: 构建后，Web UI 会自动集成到 `aih server` 中，无需额外部署。

### Q: 如何启用安全认证？

A: 启动服务器时添加管理密钥：

```bash
aih server --management-key your-secret-key
```

---

## 🎨 技术栈

- ⚛️ React 18
- ⚡ Vite
- 🎨 Ant Design
- 📘 TypeScript
- 🌐 Axios

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

ISC
