# 远程账号备份（SSH 策略）

> 目标：账号池不再只存在于一台机器上。新增账号、凭据刷新、启停变化后，
> aih server 自动把**变化的部分**推到一台或多台 SSH 机器；AWS 到期、机器丢失时，
> 用 `aih backup restore` 在任意一台新机器上恢复。

## 1. 边界

- 备份内容是 **aih 原生账号记录**（provider / accountRef / cliAccountId / status / env / nativeAuth），
  与 `aih export` 完全同一份格式，因此远端文件也可以直接 `aih import`。
- 凭据是**明文**（与 `aih export` 一致）。SSH 只保证传输加密，远端落盘由文件权限
  （0600）保护；不要把备份目录放到公开可读的位置。
- 配置文件不存 SSH 密码：只存私钥路径或密码的**环境变量名**。
- 备份是单向的（本机 → 远端）。恢复是显式命令，不会自动把远端内容写回本机。

## 2. 本机布局

```text
<aiHomeDir>/backup/config.json    # 目标与自动备份参数（0600）
<aiHomeDir>/backup/state.json     # 每个目标最近一次结果（0600）
```

`config.json`：

```json
{
  "version": 1,
  "enabled": true,
  "intervalMinutes": 360,
  "debounceSeconds": 30,
  "targets": [
    {
      "id": "aws-backup",
      "strategy": "ssh",
      "enabled": true,
      "host": "203.0.113.10",
      "port": 22,
      "username": "ubuntu",
      "identityFile": "~/.ssh/backup.pem",
      "remoteDir": "~/.aih-backup",
      "passwordEnv": "",
      "hostKeyFingerprint": ""
    }
  ]
}
```

- 第一次成功连接会把主机指纹（sha256 hex）写回 `hostKeyFingerprint`（TOFU）；
  之后指纹不匹配会直接失败，避免连到被替换的机器。
- `passwordEnv` 指向环境变量名，密码本身不落盘。优先使用私钥。
- `remoteDir` 支持 `~`、绝对路径和相对路径（相对路径按远端 home 解析）。

## 3. 远端布局与增量

```text
<remoteDir>/manifest.json
<remoteDir>/accounts/<provider>/<accountRef>.json
```

- 每个账号一个文件，内容是单账号的原生导入文档：
  `{ "kind": "aih-accounts", "version": 1, "accounts": [record] }`。
- `manifest.json` 记录每个账号的内容哈希（sha256）、provider、字节数和 revision。
- **增量判断只看内容哈希**：新增账号 → 只上传新文件；凭据/启用状态变化 → 只上传该账号；
  内容没变 → 不上传。
- 本地删除的账号不会删除远端文件，只在清单里打 `deleted: true`（tombstone）。
  恢复时 tombstone 不参与导入；历史文件仍可手工找回。
- 写入顺序：先写账号文件，最后写清单。中途失败时远端清单仍指向旧内容，
  不会出现「清单说有、文件没传完」。
- 清单没有时间戳，内容不变时字节完全一致，不会每次备份都产生新清单。

## 4. 自动触发

由 `aih server` 进程内的 `remote-backup-scheduler` 执行：

| 触发 | 行为 |
| --- | --- |
| `account.lifecycle.changed`（新增 / 导入 / 同身份换凭据 / 删除 / 启停） | 去抖 `debounceSeconds` 后立即备份所有启用目标（不受 interval 限制） |
| token 刷新等运行态变化 | 不单独触发；由周期 tick 按 `intervalMinutes` 补一轮（内容没变时零上传） |
| 周期 tick（每分钟检查） | 某个目标距上次成功超过 `intervalMinutes`，补一轮 |
| 失败重试 | 失败后至少等 5 分钟再重试，避免目标不可达时刷屏 |

单飞：一轮没跑完时再次触发只记一个 pending，跑完补一次，绝不并发写同一目标。
没有配置目标时调度器直接跳过，不产生 I/O。

## 5. CLI

```bash
# 添加目标（可加多台）
aih backup add ubuntu@203.0.113.10 --name aws --key ~/.ssh/backup.pem

# 验证连通性（只读远端清单）
aih backup test aws

# 立即备份；默认只传变化的账号，--full 强制全量
aih backup run aws

# 查看状态；--remote 会连远端读清单
aih backup status --remote

# 暂停 / 启用 / 删除目标
aih backup disable aws
aih backup enable aws
aih backup remove aws

# 自动备份参数
aih backup config --interval 360 --debounce 30 --enabled on

# 从远端恢复（同身份更新、新身份新增；--dry-run 只演练）
aih backup restore aws --dry-run
aih backup restore aws
```

`aih backup` 不带子命令时打印用法和当前目标状态。

## 6. 新增策略（例如 WebDAV）

1. 在 `lib/account/backup/strategies/` 新增一个工厂，返回
   `{ connect, readFile, writeFile, statFile?, close }`；
2. 在 `strategies/index.js` 的 `BACKUP_STRATEGIES` 注册；
3. 配置层 `SUPPORTED_STRATEGIES` 增加同名值。

服务编排、增量清单、CLI、调度器都不需要改。策略只需要实现相对路径的读写，
远端目录解析和清单格式由服务层统一。

## 7. 安全与运维

- `config.json` / `state.json` / 账号文件都是 0600。
- SSH 连接使用 `ssh2`，主机指纹首次记录后校验；私钥路径支持 `~`。
- 错误信息只回错误码/短消息，不打印私钥、密码或 token。
- 远端目录建议放在用户 home 下并限制权限；不要用 `/tmp` 或 Web 可访问目录。
- 备份文件包含明文凭据；如果目标机器不是完全可信，后续可以在策略层加 age/密码加密，
  但恢复端也需要对应密钥。

## 8. 验收

- `test/remote-account-backup.test.js`：
  - 首次全量、第二次零上传、新增账号只上传新文件；
  - 凭据变化只上传该账号；
  - 删除产生 tombstone 且恢复时跳过；
  - 恢复把账号导入空 home，ref / CLI 编号保留；
  - 配置 0600、非法目标拒绝、多目标失败隔离。
- `test/backup-router.test.js`：`aih backup add/list/remove/config` 的解析与输出。
- `test/ssh-backup-strategy.test.js`：假 ssh2 客户端验证路径解析、临时文件 + rename、
  `~` 展开和主机指纹校验。
