# AI Home Web UI 使用指南

## 概述

AI Home 提供了一个现代化的 Web 管理界面，让您可以通过浏览器轻松管理多个 AI 账号，发送会话，监控账号状态。

## 快速开始

### 1. 安装前端依赖

```bash
npm run web:install
```

### 2. 构建 Web UI

```bash
npm run web:build
```

或者使用构建脚本：

```bash
./scripts/build-web.sh
```

### 3. 启动服务器

```bash
aih server
```

默认配置下，服务器将在 `http://127.0.0.1:8317` 启动。

### 4. 访问 Web UI

在浏览器中打开：

```
http://127.0.0.1:8317/ui/
```

## 功能介绍

### 📊 仪表盘

仪表盘页面提供了系统的总体概览：

- **账号统计**：显示总账号数、已配置数、健康账号数、已耗尽数
- **账号列表**：展示所有账号的实时状态
  - 账号名称和 ID
  - 认证类型（OAuth 或 API Key）
  - 运行状态（正常/已耗尽/未配置）
  - 剩余额度百分比
  - 最后更新时间
- **自动刷新**：每 30 秒自动刷新数据
- **重新加载**：手动触发重新加载所有账号

### 👥 账号管理

账号管理页面允许您管理所有 AI 账号：

#### 添加账号

点击"添加账号"按钮，填写以下信息：

1. **Provider**：选择 AI 提供商
   - Codex (ChatGPT)
   - Gemini (Google)
   - Claude (Anthropic)

2. **账号 ID**：输入数字 ID（如 1, 2, 3...）

3. **认证方式**：
   - **OAuth 登录**（推荐）：留空 API Key 字段，后续使用 CLI 登录
   - **API Key 模式**：填写 API Key 和可选的 Base URL

#### 删除账号

点击账号列表中的"删除"按钮，确认后将删除该账号及其所有数据。

**注意**：删除操作不可逆，请谨慎操作！

#### 账号状态说明

- **已配置**：账号已完成配置，可以使用
- **未配置**：账号目录已创建，但尚未登录或配置
- **正常**：账号可用，额度充足
- **已耗尽**：账号额度已用完或被限流

### 💬 会话交互

会话页面提供了与 AI 直接对话的功能：

1. **选择 Provider**：从下拉菜单选择要使用的 AI 服务
2. **输入消息**：在输入框中输入您的问题或指令
3. **发送消息**：
   - 点击"发送"按钮
   - 或按 Enter 键（Shift+Enter 换行）
4. **查看响应**：AI 的回复将显示在对话框中
5. **清空会话**：点击"清空会话"按钮重新开始

**特性**：
- 支持多轮对话
- 消息历史记录
- 自动选择最佳可用账号
- 响应时显示加载状态

### ⚙️ 系统设置

设置页面允许您配置系统参数：

#### 账号管理设置

- **自动切换阈值**：当账号剩余额度低于此百分比时，自动切换到下一个可用账号
  - 默认值：95%
  - 范围：0-100%

#### 额度刷新设置

- **活跃刷新间隔**：正在使用的账号额度刷新间隔时间
  - 默认值：60 秒
  - 最小值：10 秒

- **后台刷新间隔**：未使用账号的额度刷新间隔时间
  - 默认值：3600 秒（1 小时）
  - 最小值：60 秒

**保存设置**：修改后点击"保存设置"按钮，建议之后重新加载账号以使配置生效。

## API 端点

Web UI 使用以下 API 端点与服务器通信：

### 账号管理 API

- `GET /v0/webui/accounts` - 获取所有账号列表
- `POST /v0/webui/accounts/add` - 添加新账号
- `DELETE /v0/webui/accounts/:provider/:id` - 删除指定账号

### 配置管理 API

- `GET /v0/webui/config` - 获取系统配置
- `POST /v0/webui/config` - 更新系统配置

### 会话 API

- `POST /v0/webui/chat` - 发送聊天消息

### 管理 API

- `GET /v0/management/status` - 获取服务器状态
- `GET /v0/management/metrics` - 获取服务器性能指标
- `POST /v0/management/reload` - 重新加载账号配置

## 开发模式

如果您想开发或调试 Web UI：

### 启动开发服务器

```bash
cd web
npm run dev
```

开发服务器将在 `http://localhost:3000` 启动，并自动代理 API 请求到 `http://127.0.0.1:8317`。

### 热重载

开发模式下，修改代码后浏览器会自动刷新，无需手动重新构建。

## 部署到生产环境

### 方式一：使用内置服务器（推荐）

1. 构建前端：
```bash
npm run web:build
```

2. 启动 AI Home 服务器：
```bash
aih server
```

3. Web UI 将自动在 `/ui/` 路径下提供服务。

### 方式二：使用独立 Web 服务器

如果您想使用 Nginx 或其他 Web 服务器：

1. 构建前端：
```bash
npm run web:build
```

2. 将 `web/dist/` 目录的内容部署到您的 Web 服务器。

3. 配置反向代理，将 API 请求转发到 AI Home 服务器。

Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name aihome.example.com;

    # 静态文件
    location /ui/ {
        alias /path/to/ai_home/web/dist/;
        try_files $uri $uri/ /ui/index.html;
    }

    # API 代理
    location /v0/ {
        proxy_pass http://127.0.0.1:8317;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 安全建议

1. **启用管理密钥**：在生产环境中，建议为管理 API 设置密钥：
   ```bash
   aih server --management-key your-secret-key
   ```

2. **使用 HTTPS**：如果通过互联网访问，务必使用 HTTPS 加密传输。

3. **防火墙规则**：限制服务器端口（默认 8317）的访问来源。

4. **定期更新**：保持 AI Home 和依赖包的更新。

## 故障排除

### Web UI 无法访问

1. 确认服务器已启动：
   ```bash
   aih server
   ```

2. 检查端口是否被占用：
   ```bash
   lsof -i :8317
   ```

3. 查看服务器日志：
   ```bash
   cat ~/.ai_home/proxy_requests.jsonl
   ```

### API 请求失败

1. 检查浏览器控制台的错误信息（F12）

2. 确认 API 端点是否正确：
   - 开发模式：`http://localhost:3000`
   - 生产模式：`http://127.0.0.1:8317/ui/`

3. 检查服务器是否返回 CORS 错误

### 构建失败

1. 清理 node_modules 并重新安装：
   ```bash
   cd web
   rm -rf node_modules package-lock.json
   npm install
   ```

2. 检查 Node.js 版本（推荐 v18 或更高）：
   ```bash
   node --version
   ```

3. 查看构建错误日志并修复报错

## 技术栈

- **前端框架**：React 18
- **构建工具**：Vite
- **UI 库**：Ant Design
- **路由**：React Router
- **HTTP 客户端**：Axios
- **语言**：TypeScript

## 相关文档

- [AI Home 主文档](../README.md)
- [API 参考](./API.md)
- [配置指南](./CONFIGURATION.md)

## 贡献

欢迎提交问题和拉取请求！

## 许可证

ISC
