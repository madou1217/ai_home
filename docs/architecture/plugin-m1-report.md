# 插件架构 M1 报告：安装与生命周期

日期：2026-10-04。对应 [插件化规划](../plans/2026-09-30-plugin-architecture-plan.md) §7 的 M1，建立在 [M0](plugin-m0-report.md) 之上。只记录有运行证据的结论；没有证据的条目标为「未完成」。

## 1. 交付物

| 交付 | 落点 | 说明 |
| --- | --- | --- |
| 离线插件包 | `lib/plugins/control/artifact.js` | `.aih-plugin`：魔数 + 元数据（manifest + 每个文件的 sha256）+ 文件内容。接受时先复制成私有副本并流式计算整体摘要，再校验结构与每个文件；解压时边写边校验，写入临时目录后原子 rename。拒绝路径穿越、符号链接、Windows 保留名、大小写不敏感重名、篡改、截断、尾随字节 |
| 控制面 | `control.js`、`state-store.js` | 唯一持久事实是 `app-state.db` 的 `plugins.control.v1`（已接受制品 + 实例配置 + revision，CAS 更新）。配置按插件 `configSchema` 校验并补默认值；列表只回显配置键名；仍被实例引用的版本不能卸载 |
| 受监督运行时 | `runtime-service.js`、`plugin-system.js` | 服务端独占 Plugin Host。发布顺序为准备候选 → CAS 提交 → 激活，全部串行。没有启用实例不启动宿主；启动恢复异步、不阻塞网关；宿主崩溃按退避重启并恢复，连续失败超过上限停在 degraded；累计代数达到阈值（默认 32）时先回收宿主再发布 |
| 管理接口 | `lib/server/plugin-management-routes.js` | `/v0/plugins`、`/doctor`、`/install`、`/uninstall`、`/enable`、`/disable`、`/invoke`。只认管理密钥：没配密钥返回 503，不沿用 `/v0/management` 在无密钥时对本机放行的规则，因为安装插件等于以服务端用户身份执行代码 |
| 命令行 | `aih plugin` | `validate [--load]`、`pack` 离线可用（`--load` 在一次性宿主里试加载）；`install / list / enable / disable / uninstall / call / doctor` 经运行中的 aih server 执行。CLI 不自己拉宿主；服务端不可达时明确报 `plugin_server_unreachable` |
| 接线 | `lib/server/server.js`（+5 行）、`management-router.js`、CLI 根路由 | 启动时后台恢复，关闭时停止宿主 |

## 2. 验收证据

测试：`node --test test/plugin-control-m1.test.js`（13 项）。macOS（Node 22.16）13/13 通过；Windows（Node 22.23）12 项通过、1 项跳过（创建符号链接需要额外权限）。闭环测试在 `/tmp` 临时 aiHomeDir、随机端口上进程内启动真实 `startLocalServer`，不触碰用户的 `~/.ai_home` 与 9527。

| 规划要求的证据 | 证据 |
| --- | --- |
| 外部目录插件仅依赖 SDK | `examples/plugins/echo` 经 `buildArtifact` 打包、`acceptArtifact` 接受，解压内容与源文件一致 |
| 安装 → 配置 → 启用 → 调用 → 停用 → 重启后恢复 | 「closed loop through aih server and the CLI…」：经 CLI 依次 `pack`、`validate --load`、`install`、带配置 `enable`、`call` 拿到按配置生成的返回值；停止服务端后用同一 aiHomeDir 重新启动，运行时自动回到 active，`call` 再次成功；最后 `disable`，`doctor` 报告健康 |
| 配置校验 | 违反 `configSchema`（空字符串、多余字段）→ `plugin_config_invalid`，revision 不变 |
| 监听器/定时器清理 | 插件经 `ctx.effect` 注册每 20 ms 写一次文件的定时器；停用后 200 ms 内文件不再增长。M0 已覆盖服务注销与异步 disposer |
| 普通异常诊断 | apply 抛错的插件 → `plugin_candidate_rejected`，诊断 `plugin_apply_failed` 带原始信息；当前代次继续服务，状态不写入 |
| 宿主崩溃诊断 | SIGKILL 宿主进程 → 自动重启并恢复已启用插件，`restarts = 1`，记录上一次退出；调用再次成功 |
| 坏包无运行副作用 | 篡改、截断、尾随字节、路径穿越、保留名、大小写重名、缺入口、非插件包共 8 类全部被拒；`accepted/`、`extracted/` 为空，revision 不变 |
| 发布协议 | 候选被拒、提交冲突（并发写入抢先）两种情况下，当前代次都继续服务；过期的 `expectedRevision` → `plugin_revision_conflict` |
| 宿主回收 | 阈值设为 2：第 3 次发布前宿主 PID 变化，调用正常，不计入崩溃重启 |
| 鉴权 | 不带密钥 / 错误密钥 → 401；未配置管理密钥 → 503（即使来自本机） |
| 卸载保护 | 被（含已停用的）实例引用的版本 → `plugin_in_use`；删除实例后卸载，制品与解压目录一并删除 |
| 真实网关只读检查 | 重启本机 aih server 后：`aih plugin list` 显示 revision 0、运行时 idle；`aih plugin doctor` 健康；不带密钥访问 `/v0/plugins` 返回 401；没有插件宿主进程 |

变异检验：去掉 `server.js` 的启动恢复、把发布顺序改成先激活再提交，对应测试均失败；恢复后通过。提交前在干净 worktree（只含本次提交、不含工作区里其他会话的改动）中跑 M0、M1 与 server-lifecycle 测试，39 项通过。

## 3. 已知限制

1. **秘密配置未实现。** 原型里只存不解析的 `secretRefs` 已移除；插件只能接收普通配置，`list` 不回显配置值。秘密引用与受控解析留到后续阶段。
2. **插件私有状态未实现。** 需要宿主回调服务端的反向通道（插件 → 宿主 → 服务端存储），M1 没有。
3. **不经 `ctx.effect` 的定时器不会被回收。** 直接调用 `setInterval` 而不登记 disposer 的插件，停用后定时器仍在宿主里运行，只能靠宿主回收（阈值重启）兜底。
4. **Windows 上 aih server 停止后 `app-state.db` 句柄未关闭。** 这是服务端已有问题，与插件无关（`test/server-lifecycle.test.js` 在 Windows 上同样 `EBUSY`）。M1 测试在 Windows 上只能尽力清理临时目录。
5. **安装只支持本机文件路径。** CLI 把包的绝对路径交给同机的服务端；远程服务端的上传通道未做。
6. **调用面仍只有调试入口。** `aih plugin call` / `/v0/plugins/invoke` 用于验证；网关热路径接入在 M2。
7. **没有 Web 管理界面。** 规划把插件管理组件放在 M3。
