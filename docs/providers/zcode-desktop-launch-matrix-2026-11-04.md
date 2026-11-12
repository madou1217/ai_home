# ZCode 桌面端逐账号启动矩阵（2026-11-04 00:30–00:36）

环境：macOS / ZCode 3.17.2（shadow `462e2867`）/ aih server 运行中。

测试方法：对每个账号调用 WebUI 的 `POST /v0/webui/accounts/zcode/<accountRef>/open-app`
（`kind=desktop, action=open`），并在打开前后各做一次监听：

- 服务端：`server.log` 行数、启动响应；
- 进程：`ps` 中的应用名 `ZCode-<sha256(accountRef)[0:8]>` 与子进程；
- 应用日志：`<projection>/.zcode/v2/logs/<date>.log` 的 `provider/model`、`providerCount`、
  `login JWT expired` 等行；
- 凭据：投影 `credentials.json` 的 `user_info` 形状与 mtime；
- 窗口：`CGWindowList` 取窗口 id，`screencapture -l` 截该账号窗口（避免被终端遮挡）。

## 证据目录

本目录即 `docs/providers/evidence/zcode-desktop-2026-11-04/`：每个账号一份 `acct<N>.txt`（打开前后快照）
与窗口截图 `aih-desktop-acct<N>.png`。

## 结果矩阵

| # | 账号 | accountRef | 启动结果 | 关键证据 | 截图 |
|---|---|---|---|---|---|
| 1 | MeaDeo | `acct_d88d90081d3166703839` | ✅ 已登录 | `provider/model 就绪`（GLM-5.3），`providerCount=10` | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct1.png` |
| 6 | 旅行者1630 | `acct_91aa805bdd051b40fa47` | ✅ 已登录 | `provider/model 就绪`（GLM-5.3-Flash），`providerCount=10` | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct6.png` |
| 10 | Deo Mea | `acct_6738589ebe0cc8aa9712` | ✅ 已登录 | `provider/model 就绪`（GLM-5.3-Flash），`providerCount=10` | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct10.png` |
| 11 | Deo | `acct_bc54735cad8feedcfd58` | ✅ 已登录 | `provider/model 就绪`（GLM-5.3-Flash），`providerCount=10` | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct11.png` |
| 12 | yfadmgkl | `acct_5997549c49c82339fac3` | ✅ 已登录 | `account provider config 已交付`，`providerCount=10` | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct12.png` |
| 5 | 旅行者0378 | `acct_a09b9df43a58fda49f66` | ⛔ 启动前拦截 | `409 account_auth_invalid`（不创建窗口） | — |
| 7 | 旅行者1636 | `acct_ae47a462f23b773eceba` | ⛔ 启动前拦截 | `409 account_auth_invalid`（不创建窗口） | — |
| 8 | 旅行者2115 | `acct_9fe1dc026eaec225df33` | ⛔ 启动前拦截 | `409 account_auth_invalid`（不创建窗口） | — |
| 4 | （未登录） | `acct_9c4ef724b3695d6e3ffd` | ➖ Welcome 页 | `providerCount=0` + 「请先登录或配置 API Key」 | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct4.png` |
| 9 | （未登录） | `acct_cf38e720d4aeb8a7934c` | ➖ Welcome 页 | `providerCount=0` + 「请先登录或配置 API Key」 | `docs/providers/evidence/zcode-desktop-2026-11-04/aih-desktop-acct9.png` |

原始逐账号日志：同目录下 `acct{1,5,6,7,8,10,11,12,4,9}.txt`。

## 过期账号的判定（不是持久化回归）

#5/#7/#8 的 `oauth:zai:access_token` 都是 8 月的 1 小时登录 JWT：

| 账号 | iat | exp |
|---|---|---|
| #5 | 2026-08-18T18:09:22Z | 2026-08-18T19:09:22Z |
| #7 | 2026-08-23T02:15:03Z | 2026-08-23T03:15:03Z |
| #8 | 2026-08-17T01:31:23Z | 2026-08-17T02:31:23Z |

- 三者都没有 `oauth:<region>:refresh_token`；zcode OAuth 不发放 refresh token（见
  `lib/account/zcode-credential.js` 的注释），过期只能重新登录。
- 当前登录写入器会在落盘前换取**业务 token**（无 `exp`）；#6/#10 的 token 是数字 sub、
  无 exp，#1 是 2026-11-03 新登录的同类 token —— 证明新链路不再产出 4 小时凭据。
- 不存在覆盖路径：投影→DB 的 `insertAccountNativeAuthIfMissing` 是 `ON CONFLICT DO NOTHING`；
  `repairZcodeProjectionCredentialProfile` 只改 `user_info`；桌面端清的是投影文件，DB 仍在。

结论：**8 月遗留凭据自然过期，不是 aih 写坏或覆盖**。重新登录后即可打开；新 token 为长期业务 token。

## 守卫：打开前判定会话是否注定失效

`isZcodeDesktopSessionExpired()`（`lib/account/zcode-credential.js:161`）在满足
「带 exp 的 JWT 已过期」且「无 refresh_token」时判定失效；账号记录因此发布
`runtimeStatus=auth_invalid`、`runtimeReason=zcode_access_token_expired`，并阻塞调度；
`open-app` 返回 `409 account_auth_invalid`，不再打开一个必然弹「Your session has expired」的窗口。

实测（2026-11-04）：

```
#5 open-app -> HTTP 409 {"ok":false,"error":"account_auth_invalid"}
#10 open-app -> HTTP 200 status=launched（窗口正常，providerCount=10）
```

回归测试：`test/zcode-desktop-session-expiry.test.js`（过期/未过期/业务 token/有 refresh token/
bigmodel 区域/API Key 六种输入）；相关 46 个测试通过。


## 重新验证（登录之后）

登录/重新登录 #5/#7/#8（以及首次登录 #4/#9）之后，直接运行：

```bash
HOME=/Users/model node scripts/zcode-desktop-launch-matrix.js
```

脚本会逐账号 close → open → 等进程 → 读应用日志 → 关闭，输出 PASS/FAIL 表；
任一账号打不开时退出码为 1，可直接用于回归。

本次运行（2026-11-04 00:45）结果：

```
PASS  yfadmgkl        acct_5997549c49c82339fac3  http=200  pc=10
PASS  Deo Mea         acct_6738589ebe0cc8aa9712  http=200  pc=10
PASS  旅行者1630       acct_91aa805bdd051b40fa47  http=200  pc=10
FAIL  旅行者2115       acct_9fe1dc026eaec225df33  http=409  account_auth_invalid
FAIL  旅行者0378       acct_a09b9df43a58fda49f66  http=409  account_auth_invalid
FAIL  旅行者1636       acct_ae47a462f23b773eceba  http=409  account_auth_invalid
PASS  Deo             acct_bc54735cad8feedcfd58  http=200  pc=10
PASS  MeaDeo          acct_d88d90081d3166703839  http=200  pc=10

5/8 通过
```

说明：脚本覆盖 API 里的 8 个已配置 zcode 账号；#4/#9 尚未配置，不在 API 账号列表里，
打开只会到 Welcome 页（证据见 `aih-desktop-acct4.png` / `aih-desktop-acct9.png`）。


### 不开窗口的预检

```bash
HOME=/Users/model node scripts/zcode-desktop-launch-matrix.js --dry-run
```

只读账号记录里的 `runtimeStatus/runtimeReason`，不启动任何窗口；当前输出：

```
CAN_OPEN  yfadmgkl / Deo Mea / 旅行者1630 / Deo / MeaDeo
REAUTH_REQUIRED  旅行者2115 / 旅行者0378 / 旅行者1636  reason=zcode_access_token_expired
5/8 通过
```


## 如何为过期/未登录账号完成登录

WebUI：账号 → ZCode → 对应账号的「重新登录」（#4/#9 用「登录」），完成浏览器授权后
再运行矩阵脚本。

命令行等价操作（逐个账号，避免多个 OAuth flow 互相顶掉）：

```bash
# 1) 发起 reauth（accountRef 换成目标账号）
curl -s -X POST -H "Authorization: Bearer $AIH_MANAGEMENT_KEY" \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:9527/v0/webui/accounts/zcode/<accountRef>/reauth
# 2) 轮询 job，拿 authorizationUrl 打开完成授权
curl -s -H "Authorization: Bearer $AIH_MANAGEMENT_KEY" \
  http://127.0.0.1:9527/v0/webui/accounts/add/jobs/<jobId>
# 3) 授权完成后复验
HOME=/Users/model node scripts/zcode-desktop-launch-matrix.js
```

注意：授权 URL 有时效（约 5 分钟）；若目标账号与实际登录身份不一致，aih 会保留目标账号
不被覆盖，并把新身份登记为实际登录的账号。

