# AI Home Web UI

AI Home 的现代化 Web 管理界面。

## 功能特性

- 📊 **实时仪表盘** - 查看所有账号的状态和健康度
- 👥 **账号管理** - 添加、删除、配置多个 AI 账号
- 💬 **会话交互** - 直接在浏览器中与 AI 对话
- ⚙️ **系统设置** - 配置额度阈值和刷新间隔

## 技术栈

- React 18
- TypeScript
- Vite
- Ant Design
- Axios
- React Router

## 开发

### 安装依赖

```bash
cd web
npm install
```

### 启动开发服务器

```bash
npm run dev
```

开发服务器将在 http://localhost:3000 启动。

### 构建生产版本

```bash
npm run build
```

构建产物将输出到 `dist/` 目录。

## 部署

Web UI 集成在 AI Home 服务器中。

1. 构建前端：
```bash
cd web
npm run build
```

2. 启动 AI Home 服务器：
```bash
aih server
```

3. 访问 Web UI：
```
http://127.0.0.1:8317/ui/
```

## API 路由

Web UI 使用以下 API 端点：

- `GET /v0/webui/accounts` - 获取账号列表
- `POST /v0/webui/accounts/add` - 添加账号
- `DELETE /v0/webui/accounts/:provider/:id` - 删除账号
- `GET /v0/webui/config` - 获取配置
- `POST /v0/webui/config` - 更新配置
- `POST /v0/webui/chat` - 发送聊天消息
- `GET /v0/management/status` - 服务器状态
- `GET /v0/management/metrics` - 服务器指标
- `POST /v0/management/reload` - 重新加载账号

## 目录结构

```
web/
├── src/
│   ├── components/     # 可复用组件
│   ├── pages/          # 页面组件
│   │   ├── Dashboard.tsx
│   │   ├── Accounts.tsx
│   │   ├── Chat.tsx
│   │   └── Settings.tsx
│   ├── services/       # API 服务
│   │   └── api.ts
│   ├── types/          # TypeScript 类型
│   │   └── index.ts
│   ├── styles/         # 样式文件
│   ├── App.tsx         # 主应用组件
│   └── main.tsx        # 入口文件
├── public/             # 静态资源
├── index.html          # HTML 模板
├── vite.config.ts      # Vite 配置
├── tsconfig.json       # TypeScript 配置
└── package.json        # 依赖配置
```
