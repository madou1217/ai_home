# ai-home

`ai-home` (`aih`) 用来管理 Gemini / Claude / Codex 多账号、多沙箱运行，并提供内置 OpenAI 兼容代理服务。

## 安装

```bash
npm install
```

## 常用命令

### 账号

使用内置 AIH Server profile 启动客户端：

```bash
aih gemini
aih claude
aih codex
```

新增账号：

```bash
aih gemini add
aih claude add
aih codex add
```

指定账号运行：

```bash
aih gemini 1
aih claude 2
aih codex 3
```

查看账号：

```bash
aih ls
aih gemini ls
aih claude ls
aih codex ls
```

查看 usage：

```bash
aih gemini usage 1
aih claude usage 1
aih codex usage 1
```

刷新账号额度状态：

```bash
aih codex usage 4 --no-cache
```

### 导入导出

导出账号：

```bash
aih export accounts.zip
```

导入账号：

```bash
aih import accounts.zip
aih import ./accounts
aih codex import ./some-folder
```

支持的导入来源：

- 目录
- zip 压缩包
- `accounts/<provider>` 结构目录
- 单账号 JSON
- 多行 JSONL
- 手动粘贴 JSON / JSONL
- CLIProxyAPI codex auth

### 内置代理服务

启动默认 AIH provider 服务：

```bash
aih provider
```

默认监听：

- `base_url`: `http://127.0.0.1:9527/v1`
- `api_key`: 未配置时可使用 `dummy`

`aih claude`、`aih codex` 不带账号 ID 时会使用内置 AIH Server profile，不需要把 `127.0.0.1:9527` 手动添加成 provider 账号。

启动后台服务：

```bash
aih server start
```

前台运行：

```bash
aih server serve
```

查看状态 / 重启 / 停止：

```bash
aih server status
aih server restart
aih server stop
```

自定义监听地址、端口、API Key：

```bash
aih server start --host 0.0.0.0 --port 9527 --api-key my-key
aih server serve --host=0.0.0.0 --port=9527 --api-key=my-key
```

外部调用方配置：

- `base_url`: `http://127.0.0.1:9527/v1`
- `api_key`: 你配置的 `--api-key`，未配置时默认可用 `dummy`

### Web UI

启动服务后打开：

- `http://127.0.0.1:9527/ui/`

当前 Web UI 支持：

- 账号管理
- 账号导入 / 导出
- 模型别名管理
- 手动打开项目
- 选择文件夹打开项目
- 新建会话
- 原生会话续写
- 图片粘贴发送
- 运行中交互输入回写（`y` / `n` / 文本）
- Server 配置与一键重启

## 开发

运行测试：

```bash
npm test
```

构建前端：

```bash
npm run build
```

## 说明

- 关于 agy (Antigravity CLI) 用量刷新：由于 `agy` 账号采用命令行 consumerOAuth 方式授权，其 OAuth Token 不具备 IDE (`antigravity-ide`) 专属的 Code Assist 接口权限范围。向 `cloudcode-pa.googleapis.com` (Product Agent) 接口查询会遭遇 403 Forbidden 响应。因此系统对 `agy` 账号屏蔽了自动用量刷新，以保护账号免受频繁请求触发的风控及拉黑限制。
- 文档只保留当前可用用法
- 具体实现细节以代码和测试为准
