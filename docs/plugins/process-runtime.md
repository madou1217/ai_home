# Process 插件运行时（语言无关）

> 目标：插件语言不限定，宿主框架保持 Go。Node 插件继续走 Node 宿主；
> Python / Go / Rust / 任意可执行程序走本协议。

## Manifest

```json
{
  "manifestVersion": 1,
  "protocolVersion": 1,
  "pluginId": "demo.account",
  "version": "1.0.0",
  "engines": { "aih": ">=1.0.0" },
  "runtime": "process",
  "entry": "main.py",
  "exec": {
    "argv": ["python3", "main.py"],
    "env": ["DEMO_TOKEN"]
  },
  "permissions": {
    "network": [],
    "filesystem": { "read": ["state"], "write": ["state"] },
    "secrets": [],
    "environment": ["DEMO_TOKEN"]
  },
  "contributes": [
    { "id": "account.login.demo", "capability": "account.login", "version": 1 }
  ]
}
```

- `runtime`: `node`（默认）或 `process`。
- `exec.argv`: 进程命令；相对路径以插件目录为 cwd。
- `exec.env`: 只允许引用 `permissions.environment` 中声明的变量。
- process 插件只允许控制面能力：`account.*`、`pricing.*`、`model.catalog`、
  `model.metadata`、`quota.probe`、`usage.scan`、`provider.descriptor` 等；
  `gateway.*` / `chat.*` / `tool` / `approval` / `ui` / `observe` 仍只支持 Node 后端。

## 线协议

stdin/stdout 行分隔 JSON，一行一个请求/响应：

```json
{"id":"1","method":"prepare","params":{"generation":1,"plugins":[{"instanceId":"demo","manifest":{}}]}}
{"id":"1","result":{"state":"prepared"}}
{"id":"2","method":"invoke","params":{"generation":1,"contributionId":"account.login.demo","value":{"schemaVersion":1,"kind":"start"}}}
{"id":"2","result":{"status":"waiting_user","verificationUri":"https://..."}}
{"id":"3","method":"dispose","params":{"generation":1}}
{"id":"3","result":{"state":"disposed"}}
```

- 方法：`prepare` / `activate` / `invoke` / `dispose` / `status` / `ping` / `shutdown`。
- 错误：`{"id":"2","error":{"code":"account_login_failed","message":"..."}}`。
- 日志只能写 stderr；stdout 只放协议 JSON。
- 插件进程按 `(generation, instanceId)` 启动；`dispose` 后宿主会结束进程。
- 没有沙箱：安装并启用插件等于以服务端用户身份执行任意代码；权限声明只用于
  安装确认，不是执行隔离。

## account.login 约定

process 插件与 Node 插件使用同一份 account 合同（`lib/plugins/account/contract.js`）：
`start` / `poll` / `submit` / `cancel` 的请求值包含 `schemaVersion:1` 与 `kind`，
返回 `{status, jobId, message, verificationUri, ..., files?, credential?}`。
宿主（Go）负责写投影文件与登记账号；插件不要直接写账号库。