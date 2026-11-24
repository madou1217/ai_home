# 插件作者最小样例

这三个目录是**可复制的最小骨架**，用于说明三类插件的声明与入口。它们不是产品内置插件，也不会被打分包收录。

| 样例 | 平面 | 声明 | 入口 |
|---|---|---|---|
| `capability-account` | AIH 能力插件 | `plugin.json` → `account.source` / `account.login` | AIH 宿主 |
| `capability-provider` | AIH 能力插件 | `plugin.json` → `gateway.account` + `scope.providers` | AIH 宿主 |
| `harness-claude` | Harness 原生插件 | `package.json#agentPlugin` → `kind: harness` | Provider / Harness |

## 验证清单

```bash
# AIH 能力插件清单（Node 侧 SDK 校验，与安装校验同源）
node -e "require('./lib/plugins/sdk/manifest').validateManifest(require('./docs/plugins/examples/capability-account/plugin.json'), { hostVersion: '1.0.0' })"
node -e "require('./lib/plugins/sdk/manifest').validateManifest(require('./docs/plugins/examples/capability-provider/plugin.json'), { hostVersion: '1.0.0' })"

# 安装与真机验证
aih plugin install docs/plugins/examples/capability-account --require-signed=false
aih plugin doctor
```

Harness 样例通过“插件与资源 → 安装 → 本地文件夹 / URL”安装；预检会读取 `agentPlugin.engines` 并只展示兼容目标。

## 边界

- AIH 能力插件运行在 AIH 宿主内；账号入库由宿主完成，插件只返回来源、登录状态、刷新结果与投影文件。
- Harness 原生插件运行在 Provider / Harness 内；AIH 只负责安装与投影，不证明插件在 Harness 内执行成功。
- 样例中的 `example` Provider 并不存在，只用于演示声明与作用域；接入真实 Provider 时替换成实际 ID。
