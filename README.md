# ai-home

`ai-home` (`aih`) 用来管理 Gemini / Claude / Codex 多账号、多沙箱运行，以及本地 OpenAI 兼容代理服务。

## 安装

```bash
npm install
```

## 常用命令

### 账号

初始化或登录一个账号：

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

清除 exhausted 标记：

```bash
aih codex unlock 4
aih codex 4 unlock
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

### 本地代理服务

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
aih server start --host 0.0.0.0 --port 8317 --api-key my-key
aih server serve --host=0.0.0.0 --port=8317 --api-key=my-key
```

调用方配置：

- `base_url`: `http://127.0.0.1:8317/v1`
- `api_key`: 你配置的 `--api-key`，未配置时默认可用 `dummy`

### Web UI

启动服务后打开：

- `http://127.0.0.1:8317/ui/`

当前 Web UI 支持：

- 账号管理
- 账号导入 / 导出
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

- 文档只保留当前可用用法
- 具体实现细节以代码和测试为准
