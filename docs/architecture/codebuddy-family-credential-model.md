# CodeBuddy 家族：账号/凭据模型实测（逆向校验）

> 结论先行：**账号共享（同一 uid），凭据不互通（按站点签发，且落盘位置/保护方式各不相同）；但 CN 侧的凭据文件是明文 JSON 放在固定共享路径上，CLI 与 IDE/App 本来就读同一个文件。** 国际站一侧有两个产品（CodeBuddy / WorkBuddy），它们共享 uid 但 realm 实例不同，因此仍是两份文件、两枚不能互换的 token。
>
> 本文是"反向校验"记录：对一台**已同时登录 CodeBuddy CN、WorkBuddy 与 WorkBuddy AI（国际站）** 的 macOS 机器勘察，验证 `aih` 侧 provider 建模与隔离策略是否成立，并给出 CLI 安装闭环 / 凭据共用的可行方案；历史启动探针的令牌刷新副作用见 §4.0。

## 0. 勘察范围与方法

文件勘察以只读为主；历史 CLI 启动探针曾自动刷新原生令牌，副作用见 §4.0。本次提交前仅核对源码并脱敏，不重做带凭据的探针。证据来源：

| 证据类型 | 具体位置 |
| --- | --- |
| 应用安装 | `/Applications/{CodeBuddy,CodeBuddy CN,WorkBuddy,WorkBuddy AI}.app` |
| Electron userData | `~/Library/Application Support/{CodeBuddy CN,WorkBuddy}/` |
| VS Code 派生 IDE 状态 | `~/Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb` |
| **共享凭据目录** | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info` |
| 账号快照 | `~/.workbuddy/storage/skeleton/account-snapshot.json` |
| 连接器密钥库 | `~/.workbuddy/connectors/<uid>/.credentials.v3.json` + `~/.workbuddy/app/connector-keys/*.key` |
| CLI 包（内嵌） | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/` |
| 系统钥匙串 | `security find-generic-password -s "<name>"` |
| 扩展运行日志 | `~/Library/Application Support/CodeBuddy CN/logs/<ts>/.../腾讯云代码助手.log` |

## 1. 拓扑：三个 App，一个 CLI 包，CLI 被内嵌

- 三个独立 `.app`、三个 bundle id：
  - `CodeBuddy.app` → `com.tencent.codebuddy` → 国际站 `www.codebuddy.ai`
  - `CodeBuddy CN.app` → `com.tencent.codebuddycn` → 国内站 `www.codebuddy.cn` / `copilot.tencent.com`
  - `WorkBuddy.app` → `com.tencent.workbuddy.mac` → 国内站 `www.workbuddy.cn`
- **CLI 只有一个产品**：`CodeBuddy Code`（v2.137.1），npm 包 `@tencent-ai/codebuddy-code`，`bin` 名 `codebuddy` / `cbc`。
- **`WorkBuddy.app` 内嵌了这份 CLI**：`Contents/Resources/app.asar.unpacked/cli/{bin/codebuddy,dist/codebuddy.js,dist/codebuddy-headless.js}`。
  启动脚本 `bin/codebuddy` 会按 argv/env 在 headless 与 TUI 两个 bundle 之间路由；注释明确写明宿主用
  `CODEBUDDY_FORCE_HEADLESS_BUNDLE=1` 让 sidecar 直接命中 headless bundle（宿主通过 `workbuddy-server --serve`、
  `cbc --prewarm` 起 sidecar 与预热池）。
- 同一 `cli/` 目录内并列多份产品配置：`product.json`、`product.internal.json`、`product.ioa.json`、
  `product.cloudhosted.json`、`product.selfhosted.json` —— 这就是 `CODEBUDDY_INTERNET_ENVIRONMENT` 的取值来源。

## 2. 身份层：同一个账号

| 观测点 | 值 |
| --- | --- |
| WorkBuddy 账号快照 `account-snapshot.json` | `uid=<cn-user-id>`，`nickname=<redacted-nickname>`，`type=personal` |
| CN IDE `User/globalStorage/storage.json` | `"genie.userId": "<cn-user-id>"` |
| CN IDE 扩展日志 | `[PluginSecretStorage] Session restored… uid: <cn-user-id>`、`Auth session changed: hasSession=true, uid=…` |
| CN 共享凭据文件 | `account.uid = <cn-user-id>`，`uin=<redacted-uin>`，`phoneNumber=<redacted-phone>` |

→ **CodeBuddy CN 与 WorkBuddy 是同一个账号**（同 uid、同 uin、同手机号），账号体系确实打通。
注意 `oneidAccountId` / `oneid_union_id` 均为空串：这条链路走的是 Keycloak realm，不是 OneID 直连。

**存在第二个（旧）身份**：`Tencent-Cloud.coding-copilot.info` 里的 `uid=<international-user-id>`，
`nickname=<redacted-email>`，签发域 `www.codebuddy.ai`（国际站），文件停留在 2025-09-19。
即：本机"都登录了"实际是 **CN 一套（active）+ 国际站一套旧凭据**，两者是不同账号。

## 3. 凭据层：三套互不通用的存储

### 3.1 共享凭据文件（CLI + IDE + App 同一个文件）

`/Users/model/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`

| 文件 | uid | 签发域(`auth.domain`) | mtime | 权限 |
| --- | --- | --- | --- | --- |
| `workbuddy-desktop.info` | `<cn-user-id>`（<redacted-nickname>） | `www.workbuddy.cn` | 2026-09-14 17:00 | `0600` |
| `Tencent-Cloud.coding-copilot.info` | `<international-user-id>`（<redacted-email>） | `www.codebuddy.ai` | 2025-09-19 | `0644` |

**两者都是明文 JSON**（`file` 判定 `JSON data`），结构：

```jsonc
{
  "account": { "uid": "…", "nickname": "…", "uin": "…", "type": "personal", "lastLogin": true, … },
  "auth": {
    "accessToken":  "<JWT, RS256>",   // 明文
    "refreshToken": "<JWT>",          // 明文
    "tokenType":    "Bearer",
    "expiresAt":    1789635618505,     // 2026-09-17 17:00
    "refreshExpiresAt": 1789981217505, // 2026-09-21 17:00
    "domain":       "www.workbuddy.cn",
    "sessionState": "…"
  },
  "accounts":    [ /* 1 项 */ ],
  "allAccounts": [ /* 1 项 */ ]
}
```

解密 `accessToken` 的 claims（不记录签名）：

```jsonc
{
  "iss": "https://www.workbuddy.cn/auth/realms/copilot",  // WorkBuddy/CN 站
  "sub": "<cn-user-id>",
  "preferred_username": "<redacted-phone>",
  "nickname": "<redacted-nickname>",
  "azp": "console", "aud": "account", "typ": "Bearer",
  "token_source": "enterprise_switch",
  "realm_access": { "roles": ["offline_access", "default-roles", "uma_authorization"] },
  "exp": 1789635618, "iat": 1789376418
}
```

对比国际站那份：`iss=https://www.codebuddy.ai/auth/realms/copilot`，`sub=<international-user-id>`，`alg=RS256`，refresh 用 `HS512`。
→ **realm 名相同（都叫 `copilot`）、架构一致，但 IdP 实例与 `sub` 不同 → token 不能跨站使用。**
`refreshToken.exp`（CN）→ 2026-09-21，仍是有效凭据。

### 3.2 IDE 自己的加密副本（safeStorage）

CN IDE 的 `state.vscdb` 里有 `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}`（约 29 KB），
由 VS Code `secret://` 命名空间承载，走 Electron `safeStorage`：

- 钥匙串存在 `CodeBuddy CN Safe Storage` / `CodeBuddy Safe Storage` 两项；
- **实测 `security find-generic-password -w -s "CodeBuddy CN Safe Storage"` 在非交互下直接返回 16 字节密钥**（退出码 0，无 GUI 询问）。

即 IDE 侧还有一份加密副本，但**它解密所需的密钥对同用户进程是可读的**。

### 3.3 WorkBuddy 连接器密钥库

`~/.workbuddy/connectors/<uid>/.credentials.v3.json`：

```jsonc
{ "version": 3,
  "encryption": { "scheme": "aes-256-gcm", "kdf": "hkdf-sha256",
                  "salt": "…", "userIdCheck": "…", "keyCheck": "…" },
  "mcpOAuth": { "<server>|<hash>": { "accessToken": {"iv","tag","ct"}, "refreshToken": {...} } } }
```

- 主密钥：`~/.workbuddy/app/connector-keys/<32hex>.key`（32 字节随机，`xxd` 可见）。
- 库**按 uid 分目录**，并带 `userIdCheck`；`user-state` / `agent-im-bindings.json` 同样以 uid 为键。
  → 设计上就**按账号隔离**，跨账号复用被结构性挡住。
- 注意：这里存的是 **MCP OAuth token**（如 `tanyuan-assistant`、`teacher-assistant`、`lighthouse-ops`），不是主站登录凭据。

### 3.4 站点内互不通用的结论

| 复用方向 | 结论 | 原因 |
| --- | --- | --- |
| CN 账号 ↔ 国际站账号 | ❌ | 不同 `sub`、不同 `iss`（两个 Keycloak realm） |
| WorkBuddy ↔ CodeBuddy CN | ✅ 同账号 | 同 uid（`<cn-user-id>`） |
| `workbuddy-desktop.info` ↔ `Tencent-Cloud.coding-copilot.info` | ❌ | 不同 uid + 不同签发域，token 互换必然 401 |
| `Tencent-Cloud.coding-copilot.info` ↔ `workbuddy-desktop-ai.info` | ❌ | **同 uid**（国际站两个产品同一自然人），但 realm 实例不同（`codebuddy.ai` vs `workbuddy.ai`），token 仍不能互换 |
| `workbuddy-desktop.info` ↔ `workbuddy-desktop-ai.info` | ❌ | 国内站与国际站，不同 uid + 不同 realm；文件名也不同，互不覆盖 |
| 同一文件的 token 被第三方进程读取 | ⚠️ 可以 | 明文 JSON、`0600`、同用户可读，且**无需钥匙串** |
| WorkBuddy 连接器库 ↔ 其他账号目录 | ❌ | 按 uid 分目录 + `userIdCheck` |

## 4. CLI 的凭据解析链（关键：与 IDE 共用同一文件）

来自 CLI bundle `dist/codebuddy-headless.js`：

```js
getBasePath() {           // 平台固定，与调用方无关
  switch (process.platform) {
    case 'darwin': return join(home, 'Library/Application Support', 'CodeBuddyExtension');
    …
  }
  // EXTENSION_DATA_DIR_NAME = "CodeBuddyExtension"
}
get sharedDataPath() { return join(this.basePath, 'Data', 'Public'); }

async getAuthSavePath() {
  let id = productManager.configuration.getValue()?.authentication?.id
        || await readSpilledProductAuthId()   // process.env.ACC_PRODUCT_CONFIG_PATH → 读文件 → .authentication.id
        || readEnvProductAuthId()             // process.env.ACC_PRODUCT_CONFIG_V3 / _V2 → 内联 JSON → .authentication.id
        || readBaseProductAuthId();           // CLI 根目录 product.json → .authentication.id
  return join(this.sharedDataPath, 'auth', `${id || 'auth'}.info`);
}
```

`cli/product.json` 的相关片段：

```jsonc
"authentication": {
  "id": "workbuddy-desktop",
  "type": "cli-external-link",          // ← 官方设计就是"外部链接"宿主身份
  "attributes": {
    "tokenHeader": "Authorization", "tokenType": "bearerToken",
    "usernameHeader": "X-User-Id", "usernameEncode": "URLEncode",
    "prefixPath": "/plugin",
    "internalDomain": ["copilot.tencent.com","www.codebuddy.cn","www.workbuddy.cn", …],
    "externalDomain": ["www.codebuddy.ai", …],
    "platform": "workbuddy"
  }
}
```

推论（均已在本机验证）：

1. `basePath` 硬编码 → **IDE 扩展与 CLI 的 `sharedDataPath` 完全相同**，即 `auth/workbuddy-desktop.info` 是二者共读共写的**同一个文件**。
2. **`CODEBUDDY_CONFIG_DIR` 不隔离凭据**：实测 `CODEBUDDY_CONFIG_DIR=/tmp/cbcfg` 时只生成
   `settings.json` / `sessions/` / `plugins/` / `shell-snapshots/` / `local_storage/`，**不生成 `auth/`**。
3. 该文件是**那个 `cli-external-link` 契约的落地物**：token 以 `Authorization: Bearer` 发送、uid 以 `X-User-Id` 发送、前缀 `/plugin`。
4. 凭据源是**优先级链**（`AuthenticationStorage` 的 `priority()`）：
   `ApiKeyAuthenticationStorage`（`CODEBUDDY_API_KEY` 存在时 `Heigh`）→ `FileAuthenticationStorage`（`Normal`）→
   `CliCustomTokenAuthenticationStorage` / `CustomTokenAuthenticationStorage` → `ExternalAuthenticationProvider`。
   `FileAuthenticationStorage` 还**监视该文件**（`initializeWatcher` → `reconcileExternalChange`），并有 logout marker 文件与文件锁、原子写。

### 4.0 端到端实证：CLI 独立运行 → 读共享凭据 → 刷新 → 回写

对 `WorkBuddy.app` 内嵌 CLI 直接执行（无任何 `CODEBUDDY_*` / `WORKBUDDY_*` 注入，`CODEBUDDY_CONFIG_DIR` 亦未设置）：

```bash
node "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" \
     --serve --auth none --port <p>
```

观测到的效果：

| 观测项 | 运行前 | 运行后 |
| --- | --- | --- |
| `workbuddy-desktop.info` mtime | 2026-09-14 17:00:18 | 2026-09-14 **18:12:32** |
| `accessToken.iat` / `.exp` | 17:00:18 / 09-17 17:00:18 | **18:12:32** / 09-17 18:12:32 |
| `auth.lastRefreshTime` | 17:00 | **18:12:32** |
| `sessionState` | `<session-state>` | `<session-state>`（不变） |
| `account.uid` | `<cn-user-id>` | `<cn-user-id>`（不变） |

即：**该 CLI 用共享文件里的 `refreshToken` 向 CN 认证服务换取了新的 `accessToken`，并把结果原子回写到同一文件**。
（`sessionState` 与 uid 不变 → 同一会话，未新建登录；这只是 token 轮换，与宿主 App 的行为一致。）

**结论：CLI 与 App 共用凭据不是"能不能"的问题，而是当前默认行为。**

> ⚠️ 副作用披露：上述验证导致该账号的 accessToken 发生了**正常的 token 轮换**（有效期顺延，同一 session）。
> 未创建新会话、未改动 `sessionState`、未创建新账号，未对上游发起带凭据的业务请求。


### 4.1 sidecar 凭据引导协议（宿主 → CLI 的官方通道）

headless bundle 中的 `CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET` 协议：

**宿主注入的 env（CLI 读取后会从 `process.env` 删除）：**

| env | 含义 |
| --- | --- |
| `CODEBUDDY_SIDECAR_READY_SOCKET` | 宿主侧 Unix socket，sidecar 回报就绪 |
| `CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET` | sidecar 监听、接收"静态加密引导" |
| `CODEBUDDY_SIDECAR_READY_TOKEN` | 共享校验 token |
| `CODEBUDDY_SIDECAR_READY_SESSION_ID` | 会话 id |
| `CODEBUDDY_RUNTIME_INSTANCE_ID` | 运行时实例 id |
| `WORKBUDDY_AT_REST_ENCRYPTION` | `disabled` \| `required`，静态加密模式 |

**流程：** sidecar 起 Unix server（超时 5 s、单帧上限 64 KiB）→ 宿主连上后发**一行 JSON**，
字段**必须严格等于** `bootstrap,pid,sessionId,token,version` 五个；sidecar 校验 `version===1`、
`sessionId`/`token` 匹配、**`pid === process.pid`**，再 `decodeAtRestEncryptionBootstrap(bootstrap)` →
回 `{"ok":true,"mode":…}` → 卸载 socket → `configureCredentialProtection(mode)`。
在此之前 `AuthenticationStartupGate` 会 `await waitForStartupCredentialProtection()` 阻塞鉴权初始化。

**引导载荷**（module 12723）：`{version:1, atRestSecretKey: <32 字节的标准 base64>}`；
全零 base64 是"不可用"哨兵；另有 `RSA-OAEP-256` / RSA-3072 的 "developer public key" 包裹层与
`deriveAtRestKeyId = sha256(key).hex.slice(0,16)`。
→ **宿主与 sidecar 共享静态加密密钥**，这就是官方意义上的"凭据保护/共用"通道。

## 5. 对 `aih` 现有实现的校验结论

### 5.1 成立的部分

- 国内/国际拆成两个 provider（`codebuddy` / `codebuddycn`）**方向正确**：两个 Keycloak realm、两套账号、两个下载站点。
- `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT` 作为站点开关**选对了**：bundle 里
  `ProductEnvServiceImpl.switch(env)` 正是写 `process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT`。
- 桌面侧 `ExecNames: ["Electron"]` **必要**：三个 `.app` 的 `Contents/MacOS/` 只有 `Electron`。
- `reloadsHostAuth:false`（声明式独立登录）**合理**：CLI/IDE 无稳定注入点来自动完成 OAuth。

### 5.2 需要修正的部分（已修正，见 §10 / §11）

原来的问题是：`codebuddycn` 的存储策略把凭据隔离寄托在 `~/.codebuddy-cn` 上，**但凭据不在那里**。
真实凭据路径是平台固定的 `…/CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`，
**不随 `CODEBUDDY_CONFIG_DIR` 变化**（§4 第 2 条已实测）。

修正后的结论（§10 / §11）：该目录确实是唯一真凭据入口，但"两个 aih 账号互相覆盖"这个推论**不成立**——
账号沙箱里 `HOME` 被改写到 `<runtimeDir>`，把这份 `.info` 声明成 HOME 相对的 auth artifact 后，
每个沙箱各持一份自己的副本，隔离由 HOME 隔离自动成立。真正需要显式决策的只有**宿主侧**那一份。

§5.2 当时的最后一句话（"`codebuddy` / `codebuddycn` / `workbuddy` 三个 provider 的账号会落在同一个
`.info` 文件上"）也只对了一半：三个 Provider 实际只对应**两个**文件，且文件名由**发行版**决定
（§11 实测），不是由站点决定。

**当时设想的隔离杠杆**（供参考，本轮未采用"每账号唯一 `authentication.id`"路线）：

| 目标 | 手段 |
| --- | --- |
| 每账号独立凭据文件 | 给每个账号一份产品配置，令 `authentication.id` 唯一：走 `ACC_PRODUCT_CONFIG_V3`（内联 JSON）或 `ACC_PRODUCT_CONFIG_PATH`（文件路径） |
| 会话/设置/插件隔离 | `CODEBUDDY_CONFIG_DIR=<account-sandbox>`（**已实测生效**） |
| 站点选择 | `CODEBUDDY_INTERNET_ENVIRONMENT` / `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT` = `internal` / `ioa` / … |
| API key 优先于文件凭据 | `CODEBUDDY_API_KEY`（`priority()` 为 `Heigh`，压过 `Normal` 的文件凭据）；`CODEBUDDY_API_KEY_DISABLED` 可屏蔽 |
| 宿主托管凭据 | 实现 §4.1 的 bootstrap socket 协议（较重） |

## 6. CLI 安装闭环：三条路径

1. **复用 App 内嵌 CLI（零安装，推荐先做）**
   `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`
   - 实测可独立运行：`--version` → `2.137.1`；`--serve --auth none --port <p>` 正常起 HTTP 服务，
     启动横幅显示 `Config /Users/model/.workbuddy/settings.json`（默认配置根即 `~/.workbuddy`）。
   - 版本与 App 严格一致，不需要网络、不需要 npm。
   - 代价：路径随 App 版本/安装位置变化，需运行时探测；App 卸载即失效。
2. **npm 安装官方包** `@tencent-ai/codebuddy-code` → `codebuddy` / `cbc`
   - `InstallRegion: cn` 走 `copilot.tencent.com/cli/install.sh`，国际走 `www.codebuddy.ai/cli/install.sh`；
     两者内容一致，最终都从 myqcloud COS 取包。真正自动化，可版本锁定。
3. **只做"探测 + 提示"**（当前 `codebuddy.js` 的做法）—— 最小风险，但不算闭环。

**闭环判定**：路径 1/2 都能做到"安装 → 探测可执行 → 起进程 → 复用登录态"，即闭环成立。
`--serve`（HTTP/Web UI/REST/ACP over SSE）与 `--acp`（stdin/stdout ndJsonStream）是现成的集成入口，
不需要 aih 自己驱动 TUI。

## 7. 与 App 共用凭据：可行性结论

| 方案 | 可行性 | 说明 |
| --- | --- | --- |
| 让 CLI 读 `auth/<authentication.id>.info` | ✅ **现状即可** | CLI 与 IDE/App 已共读同一文件；同用户进程可直接读写该明文 JSON |
| 给 aih 每个账号独立 `.info` | ✅ | 通过 `ACC_PRODUCT_CONFIG_V3` / `_PATH` 指定唯一 `authentication.id` |
| aih 读取 App 当前登录态 | ✅ | 读 `workbuddy-desktop.info`（明文、无需钥匙串）；或解密 IDE 的 `secret://` 副本（钥匙串项实测非交互可读） |
| aih 写入该文件令 CLI/IDE 跟随 | ⚠️ 可行但危险 | CLI 有文件 watcher 会热加载；但会**改动宿主 App 的登录态**，需显式开关与备份 |
| 用 `CodeBuddy CN` 凭据驱动国际站 | ❌ | 不同 realm，token 必然被拒 |
| aih 实现 sidecar bootstrap 宿主侧 | ⚠️ 可行，成本高 | 需实现 Unix socket 服务端 + `{version,atRestSecretKey}` 引导 + pid/token/sessionId 校验 |

**风险**：`.info` 是明文 bearer token（CN 那份 `refreshToken` 到 2026-09-21 仍有效），
任何同用户进程可读并可冒用；写操作还会改变宿主 App 的登录态。
`aih` 若接管该文件，必须：只读优先、写前备份、按账号隔离文件名、绝不把 token 落进日志或遥测。

## 8. 待办

- [x] 修正 `lib/runtime/provider-storage-policy.js`：为三个 Provider 声明真实的
      `authArtifacts` 路径（`Library/Application Support/CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`），
      并说明该路径**不受 `CODEBUDDY_CONFIG_DIR` 约束**。见 §10 / §11。
      文件名按 Provider 区分：`codebuddycn` / `workbuddycn` → `workbuddy-desktop.info`，
      `codebuddy` → `Tencent-Cloud.coding-copilot.info`，`workbuddy` → `workbuddy-desktop-ai.info`。
- [ ] 启动策略注入每账号唯一的 `ACC_PRODUCT_CONFIG_V3.authentication.id`，实现凭据文件名级隔离。
      本轮**不做**：国内侧已由 HOME 隔离 + HOME 相对投影天然实现"一账号一份"，且注入会让沙箱
      不再与 App 共用登录态，与产品目标冲突（详见 §11.3）。
- [x] 安装器增加"优先探测 App 内嵌 CLI"分支（复用版本一致性），npm 安装作为回退。见 §10。
- [x] 额度/用量探测（`quota_usage`）接入家族四员：`POST {endpoint}/billing/meter/get-user-resource-summary`，
      账户级聚合 + 明细桶，实测同地区 work/code 共用一份账户级用量。见 §14。
- [ ] 若要做真正意义的凭据共用，评估集成入口：`codebuddy --serve`（REST/ACP over SSE）优先于自实现 bootstrap。


## 9. 提交前修正（2026-09-15）

- `FilePathServiceImpl.getBasePath()` 已再次从本机内嵌 CLI 源码核对：共享凭据根取自
  `os.homedir()`。CLI 启动改为复用 `homeRedirectStrategy`，HOME/USERPROFILE 指向账号沙箱，
  `CODEBUDDY_CONFIG_DIR` 仍隔离配置；Rust/Go/npm 缓存保持共享。
- 宿主 `ACC_PRODUCT_CONFIG_*`、sidecar socket/token 与 `CODEBUDDY_API_KEY_DISABLED` 在账号边界剥离。
- 两账号子进程按真实 `os.homedir()` 读取各自的共享凭据测试文件，证明不能读到宿主或另一账号。
- 该修正完成共享路径隔离，**不表示共享 `.info` 的捕获、注册和刷新已接通**；§8 的凭据导入工作仍开放。
  旧代码中 `.credentials.json` 只作为已有投影形状保留，不能作为内嵌 CLI 的共享 OAuth 支持证据。
- UID、email 和组织 accountId 不再混为同类身份；仅冲突的用户标识才拒绝，保留 provider 种子隔离。
- 文档中的手机号、邮箱、uin、昵称和身份值均已替换为占位符；不提交原始凭据或运行时安装缓存。

## 10. 国内侧闭环（2026-09-15 实现）

约束来自产品决策：**`codebuddycn` 与 `workbuddy` 是同一个国内账号**，
闭环要自动完成、共享面最小、**不要任何开关或备份逻辑**。

### 10.1 两个缺口与两条最小改动

| 缺口 | 手段 | 落点 |
| --- | --- | --- |
| 机器上没装国内站 CLI | 复用 `WorkBuddy.app` 内嵌 CLI（零安装） | `lib/server/app-installers/codebuddy-bundle-cli.js` + `codebuddycn.js` 的 `collectCliPathEntries` |
| CLI 在沙箱里"未登录" | 把共享 `.info` 声明为两个 Provider 的 auth artifact | `lib/runtime/provider-storage-policy.js` 的 `CODEBUDDY_CN_SHARED_AUTH_PATH` |

不含开关、不含备份、不含新字段：两条改动都复用既有机制
（`collectPathEntries` 的"先探测后安装"、`authArtifacts` 的投影/捕获/回填）。

### 10.2 安装闭环

`collectCliPathEntries('codebuddycn')` 的第一项现在是

```
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin
<hostHome>/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin
```

`resolveProviderCliPath()` 在**安装之前**就会命中它（实测：
`resolveProviderCliPath('codebuddycn')` → `…/cli/bin/codebuddy`，v2.137.1），
官方脚本 / npm 计划保持为回退，没有任何交互提示。
内嵌 CLI 的 bin 目录只有 macOS 路径：WorkBuddy 没有可验证的 Windows / Linux 分发源。

搜索根由合同声明的 `workbuddy.desktopClient.macos.installPaths` 派生，
有单测锁住两者不漂移（`the bundled CLI entry stays tied to the declared WorkBuddy.app install paths`）。

**更新通道（刻意的取舍）**：内嵌件排在独立安装落点**之前**，所以桌面端存在时
`WorkBuddy.app` 就是国内站 CLI 的更新源（内嵌 CLI 版本与 App 严格一致）。
真正的理由见 §11：两个发行版的 `authentication.id` 不同，读的是**不同的凭据文件**；
让独立分发件抢先，国内站账号就会落到国际站那支 CLI 的凭据文件上，闭环静默失效。
显式跑官方安装器仍可用（落到 `~/.local/bin`），只是不会抢在内嵌件前面。

### 10.3 凭据闭环：一个文件，两个 Provider

```js
// provider-storage-policy.js
const CODEBUDDY_EXTENSION_AUTH_DIR = [
  'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'
];
const CODEBUDDY_CN_SHARED_AUTH_PATH = [...CODEBUDDY_EXTENSION_AUTH_DIR, 'workbuddy-desktop.info'];
// codebuddycn.authArtifacts = workbuddy.authArtifacts = [{ field:'credentials', path: <上>, format:'json' }]
// codebuddycn.hostAuthRoot = workbuddy.hostAuthRoot = []
```

- 路径已与本机内嵌 CLI bundle 的 `/Applications/WorkBuddy.app/.../cli/dist/codebuddy-headless.js`
  交叉验证：bundle 里写死的正是 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`。
- CLI 用 `os.homedir()` 定位它，所以声明为 **HOME 相对**路径（这也是 `hostAuthRoot: []` 的原因：
  它不属于任何 Provider 配置根）。
- **共享面只有这一个文件**：`sharedEntries` 仍为空，配置 / 会话 / 插件 / Keychain 照旧各自投影。

由此得到的行为：

| 场景 | 结果 |
| --- | --- |
| 沙箱内 CLI 是否已登录 | 是——`materializeProviderAuth` 把 `.info` 写进 `<runtimeDir>/Library/…`，正好是内嵌 CLI 读的位置 |
| 两个 aih 国内站账号会不会互相覆盖 | 不会——HOME 被隔离到各自 `<runtimeDir>`，各持一份副本（§5.2 的担心只在"不隔离 HOME"时成立） |
| 宿主那一份 | 只在用户显式同步默认账号时被写（`syncGlobalConfigToHost`），因为 `hostAuthRoot: []`，目标就是真实文件本身 |

### 10.4 回归校验

- `test/codebuddy-provider.test.js`：47 pass。覆盖共享凭据同一性、三 Provider 的
  沙箱投影 + 宿主回填段、登录沙箱 artifact 路径、内嵌 CLI 搜索根、
  搜索根与合同 `installPaths` 一致、两站点凭据文件不共用。
- `npm test`：7027 tests / 6986 pass / 0 fail / 41 skipped。
- `npm run providers:check`：通过（本轮未改 Go 合同，无 codegen 变更）。

## 11. 决定性实测：两个发行版 → 两个凭据文件（2026-09-15）

§5.2/§10 都只是"共享同一个文件"的推断。本轮把两个发行版都拆开核对，结论如下。

### 11.1 取证

| 发行版 | 来源 | `product.json` 的 `authentication.id` |
| --- | --- | --- |
| 独立分发 | `@tencent-ai/codebuddy-code@2.151.0`（npm tarball） | `Tencent-Cloud.coding-copilot` |
| 独立分发（国内站） | `https://copilot.tencent.com/cli/install.sh` → COS `codebuddy-code_Darwin_arm64.tar.gz` @2.151.0，单文件二进制 | `Tencent-Cloud.coding-copilot`（**不带站点差异**） |
| WorkBuddy 国内站内嵌 | `/Applications/WorkBuddy.app/…/cli/product.json` | `workbuddy-desktop` |
| WorkBuddy AI 国际站内嵌 | `/Applications/WorkBuddy AI.app/…/cli/product.json` | `workbuddy-desktop-ai` |

- 国内站 `install.sh` 从 myqcloud COS 取的与 npm 是**同一份 runtime**；其内嵌
  `authentication` 块只有 `Tencent-Cloud.coding-copilot` 一个（在 120MB 编译产物里
  逐字节定位确认，`internalDomain` 覆盖 `copilot.tencent.com` / `www.codebuddy.cn` /
  `www.workbuddy.cn`）。`product.internal.json` / `product.ioa.json` **没有**
  `authentication` 键，因此不会覆盖它。
- 三个 `.info` 文件的实际归属（只取非敏感字段 + JWT `iss`）：

| 文件 | 写入方（host id） | `iss` | 归属站点 | 账号 uid |
| --- | --- | --- | --- | --- |
| `Tencent-Cloud.coding-copilot.info` | `Tencent-Cloud.coding-copilot` | `https://www.codebuddy.ai/auth/realms/copilot` | 国际站 CodeBuddy | `409f887f-…0475` |
| `workbuddy-desktop-ai.info` | `workbuddy-desktop-ai` | `https://www.workbuddy.ai/auth/realms/copilot` | 国际站 WorkBuddy | `409f887f-…0475` |
| `workbuddy-desktop.info` | `workbuddy-desktop` | `https://www.workbuddy.cn/auth/realms/copilot` | 国内站 | `e3f89e5f-…a1e0` |

**读法**（这份文档最容易搞错的一处）：

- 国内站那份的 uid 与国际站两份**不同** → 国内与国际确实是两套账号体系。
- 国际站两份**共享同一个 uid**（`409f887f-…`），但 **realm 实例不同**
  （`www.codebuddy.ai` vs `www.workbuddy.ai`）、文件名也不同 → 同一自然人在国际站
  CodeBuddy 与 WorkBuddy 是同一个账号，token 却仍不能互换。
- **真正的站点判别依据是 token 的 `iss`（realm），不是文件名**：文件名只说明
  "哪个发行版写的"，而 `Tencent-Cloud.coding-copilot` 这个 host id 国内站独立分发件
  也会用（见 §11.2 第 1 条），所以那份文件**站点不可归因**。

### 11.2 结论与落地

1. **`authentication.id` 是"发行版"属性，不是"站点"属性**。所以
   `Tencent-Cloud.coding-copilot.info` 是**站点不可归因**的：国内站独立分发件也会写它。
   站点只能从 token 的 realm 判断。
2. **`codebuddy`（国际站）改为声明 `Tencent-Cloud.coding-copilot.info`**。
   依据：国际站 CLI（独立分发件）与 `CodeBuddy.app` IDE 的 `authentication.id` 就是它，
   且本机该文件的 realm 正是 `www.codebuddy.ai`。原来的
   `~/.codebuddy/.credentials.json` 是**两个发行版都不写的文件**（实测），等于从未生效。
3. **`workbuddy`（国际站）声明 `workbuddy-desktop-ai.info`，`workbuddycn`（国内站）声明
   `workbuddy-desktop.info`**。两个站点文件名不同（`-ai` 后缀），所以天然不会互相覆盖；
   各自的 `nativeRoot` 也不同（`.workbuddy-ai` vs `.workbuddy`）。
4. **两个国内站 Provider（`codebuddycn` / `workbuddycn`）仍只声明 `workbuddy-desktop.info`**，
   并**刻意不声明**那份站点不可归因的文件：把国际站 token 静默导进国内站账号，比
   "判不出宿主来源、让账号在沙箱里自己登录"更糟。单测把这条边界钉住
   （`no two sites in the family share a credential file`）。
5. 四个 Provider 的 `hostAuthRoot` 统一为 `[]`（凭据都相对宿主 HOME）。

### 11.3 独立发行件捕获缺口已闭合（2026-09-16）

本节旧版记录的“只装独立发行件时国内账号无法捕获”已由 `29795c88` 修复。
保留 §11.2 的 primary artifact 声明，同时由 `codebuddy-credential-source.js`
发现独立发行件的 `Tencent-Cloud.coding-copilot.info`。文件名本身不证明站点；
必须核验 token realm、subject、account.uid 与 auth.domain，才能用于对应国内 Provider。

同一身份的不同发行件凭据按 token 自身时间更新；不同用户或国际授权域不混用。
物化、原生 App 反向同步和重登都有明确校验，未注入每账号唯一 authentication.id，
也没有迁移/复制共享会话历史。`test/codebuddy-credential-source.test.js` 覆盖
standalone-only、跨地区拒绝、新旧凭据竞争、两种发行件读写及不同用户保护。

## 12. 国内/国际站点在产品族上的合并（2026-09-15 实现）

### 12.1 为什么不能"合并成一个 Provider"

§11 的实测决定了这条边界：国内站与国际站**账号体系不互通**（两份凭据、不同 uid、
不同 realm），同一个自然人两边是两个账号。因此：

- **身份轴必须留在具体 Provider 上**：`accountRef`、默认账号、存储投影、切换目标
  全部按真实 Provider 分派，绝不能因为"菜单合并了"就混在一起。
- 但**展示轴应该按产品收敛**：用户视角里 Qoder / CodeBuddy / WorkBuddy 各是**一个**
  产品，菜单里出现两个平级入口（`Qoder` 与 `Qodercn`）是错的。

结论：在合同里加**产品族（family）**与**站点（site）**两个字段，一处声明、四处投影，
所有列表只做**展示聚合**，不碰身份。

### 12.2 合同变更

SchemaVersion `1` → `2`（`core/providers/model.go`）：

- 新增 `family: string`、`site: 'global' | 'cn'`；单站产品由 `withDefaultSite()`
  自动补 `family == id`、`site == 'global'`，双站产品显式调用 `family(...)`。
- 新增 `workbuddycn`（国内站），`workbuddy` **回归纯国际站**
  （`WorkBuddy AI.app` / `com.workbuddy.workbuddy-ai` / `~/.workbuddy-ai`）。
- 校验层拒绝重复的 `(family, site)`，防止"一个产品的同一站点出现两次"。
- 这次**没有**重命名既有 Provider：`workbuddy` / `codebuddy` / `qoder` 名字不变，
  只把语义钉成"无后缀 = 国际站"，因此**存量账号零迁移风险**。

站点归属（共 15 个 Provider）：

| family | 国际站 | 国内站 |
| --- | --- | --- |
| `qoder` | `qoder` | `qodercn` |
| `codebuddy` | `codebuddy` | `codebuddycn` |
| `workbuddy` | `workbuddy` | `workbuddycn` |
| 其余（codex / gemini / claude / agy / opencode / grok / kimi / kiro / zcode） | 自身 | — |

### 12.3 展示聚合的落点

| 位置 | 文件 | 做法 |
| --- | --- | --- |
| 账号页 tab / 统计 | `web/src/pages/Accounts.tsx` | tab 轴从 Provider 换成**产品族**，站点降为行内标记 |
| 添加账号下拉 | `web/src/features/accounts/AddAccountModal.tsx` | 多站点产品用 `Select.OptGroup`，站点是组内二级选项 |
| 模型页 Provider 下拉 | `web/src/pages/Models.tsx` | 复用 `buildProviderSelectOptions()` |
| 聊天账号菜单 | `web/src/components/chat/composer/` | `buildComposerAccountGroups` 按族分组，账号行带站点 |
| 终端文本名 / 各处列表 | `web/src/providers/catalog.ts` | `providerNames` 取 `getProviderMenuLabel()`（多站点带"· 国际站"/"· 国内站"） |
| 桌面托盘 | `lib/server/desktop-menu-model.js` + `src-tauri/src/tray.rs` | 按族合并子菜单，站点作为行内前缀 |

刻意**不**合并的两处（有注释说明）：

- `Segmented` 控件（Models 的 Provider 筛选、ModelUsage 的 Provider 筛选）没有分组
  能力，保持"每个 Provider 一个 chip"，靠站点后缀区分——筛选轴必须留在真实 Provider
  上，因为同族两个站点的模型清单、用量结算都不同。

### 12.4 托盘协议：附加字段，版本不动

托盘快照仍是 `version: 1`。新增的 `family` / `familyLabel` / `site` / `siteLabel` /
`multiSite` 是**纯附加字段**：

- 新托盘按 `family` 合并同族条目，行内加站点前缀，子菜单标题用族名。
- **旧托盘忽略这些字段**，看到的就是今天的行为（同族两个子菜单、按 Provider 切换，
  结果仍然正确）；`family` 缺省时 Rust 侧回退为 Provider 自身 id。

这样避免了"改了协议就让旧托盘弹版本不兼容"的静默降级。

### 12.5 验证

- `npm run providers:generate` / `providers:check`：通过（4 份投影一致）。
- `go test ./core/providers ./cmd/provider-manifest`：通过（含 `(family, site)` 唯一性）。
- `cargo test --bin ai-home tray::`：8 pass（含"同族两站点合并成一个入口且切换目标
  仍是各自 Provider"、"旧 Server 无 family 时行为不变"）。
- `node --test test/desktop-menu-model.test.js`：13 pass。
- web `npm run build`（含 tsc）+ ESLint：通过。

## 13. 会话打通：同地区 work/code 共用一份历史（2026-09-15 实现）

§12 解决的是"菜单上按产品族合并"，本节的诉求不同，是**数据面**的：

1. 同一地区的 WorkBuddy 与 CodeBuddy **共用一份会话历史**；
2. **切换选中账号不改变可见历史**；
3. 这些会话能**进入 aih 的会话目录并可续聊**（复用既有目录 + relay）。

### 13.1 根因：同地区两个产品跑的是同一套 runtime

§1 已经证实 WorkBuddy.app / WorkBuddy AI.app 内嵌的就是 CodeBuddy Code，落盘形态与
Claude Code 同构：

```
<configDir>/projects/<sanitized-cwd>/<sessionId>.jsonl
<configDir>/projects/<sanitized-cwd>/<sessionId>.meta.json      # 旁挂元数据
<configDir>/projects/<sanitized-cwd>/<sessionId>.file-rollback.ndjson
```

因此"打通"不是把两份数据合并，而是**承认它们本来就是一份**：只要把同一地区的数据根
一起读即可。站点目录口径：

| 站点 | 合并的数据根 | 说明 |
| --- | --- | --- |
| 国内站 `cn` | `.workbuddy` + `.codebuddy-cn` | WorkBuddy.app 与 CodeBuddy CN |
| 国际站 `global` | `.workbuddy-ai` + `.codebuddy` | WorkBuddy AI.app 与 CodeBuddy |

四个 Provider 的读取顺序（只影响优先级，不影响结果集）：

```js
const CODEBUDDY_SESSION_ROOTS_BY_PROVIDER = Object.freeze({
  codebuddy:    Object.freeze(['.codebuddy', '.workbuddy-ai']),
  workbuddy:    Object.freeze(['.workbuddy-ai', '.codebuddy']),
  codebuddycn:  Object.freeze(['.codebuddy-cn', '.workbuddy']),
  workbuddycn:  Object.freeze(['.workbuddy', '.codebuddy-cn'])
});
```

于是**从哪个 Provider 进入都一样**：`codebuddycn` 与 `workbuddycn` 读到的是同一批
会话，`codebuddy` 与 `workbuddy` 也是——这正是"打通"的可观测定义。

### 13.2 新增适配器：`lib/sessions/session-reader-codebuddy.js`

| 导出 | 职责 |
| --- | --- |
| `readCodebuddyProjects(provider, options)` | 合并本地区全部数据根的项目/会话，同一 `projectDirName` 下按 sessionId 合并（取 mtime 更新的那条） |
| `readCodebuddySessionMessages(provider, sessionId, projectDirName, options)` | 把 ACP/CodeBuddy JSONL 渲染成 aih 统一的 `{role, content, timestamp, model?}` |
| `resolveCodebuddySessionPath(provider, sessionId, projectDirName, options)` | 按地区根逐个探测会话文件；**跨 Provider 也能定位**（会话由 work 产生、从 code 入口续聊） |
| `resolveCodebuddyProjectsRoots` / `resolveCodebuddyConfigDirNames` | 目录口径（唯一真值来源） |
| `stripCodebuddySystemReminder` | 剥掉每轮注入的 `<system-reminder data-role="user-context">` 前导块 |

ACP/CodeBuddy 私有记录形态与 Claude 的 `{type:'user'|'assistant', message}` **不同**，
映射关系：

| 原生 `type` | 字段 | 渲染成 |
| --- | --- | --- |
| `message` (role=user) | `content=[{type:'input_text',text}]` | user 气泡（先剥 system-reminder） |
| `message` (role=assistant) | `content=[{type:'output_text',text}]` | 合并进当前 assistant 气泡 |
| `ai-title` | `aiTitle` / `sessionId` / `cwd` | 会话标题真值（缺失时退回首条用户消息 → 项目目录名） |
| `reasoning` | `rawContent=[{type:'reasoning_text',text}]`、`providerData.model` | `:::thinking … :::` |
| `function_call` | `name` / `arguments` / `callId` | `:::tool{name="…"} … :::` |
| `function_call_result` | `callId` / `status` / `output` | `:::tool-result … :::`（按 callId 归位，截断到 32k） |
| `file-history-snapshot` | `cwd` | 项目路径兜底 |

`timestamp` 是**毫秒**（Claude 是 ISO 字符串），统一转成 ISO 输出。
`.meta.json` / `.file-rollback.ndjson` 是旁挂元数据，**不**当会话消息读。

边界：适配器**不读账号沙箱**（`auth-projections/<provider>/<accountRef>`）。沙箱里的
`projects` 只是指向宿主地区存储的软链接（见 §13.4），读宿主地区根就是读全部。

### 13.3 合同变更：新增能力 + polling

| Provider | `capabilities` 变化 | `sessionSync` 变化 |
| --- | --- | --- |
| `codebuddy` | `+ session_history` | `unavailable → polling` |
| `codebuddycn` | `+ session_history` | `unavailable → polling` |
| `workbuddy` | `+ session_history` | `unavailable → polling` |
| `workbuddycn` | `+ session_history` | `unavailable → polling` |

四个都**刻意不声明 `account_session_store`**：会话读的是宿主**地区**目录而不是账号
沙箱，声明它会和"切账号不影响历史"的诉求直接矛盾。事件清单保持为空（无官方 hook），
不会产生空轮询。

`session_history` 是能力驱动的：`SESSION_FILE_CAPABLE_PROVIDERS`、
`DEFAULT_HOST_PROJECT_PROVIDERS`、`CACHEABLE_SESSION_MESSAGE_PROVIDERS` 均由其派生
（后者另行显式加入家族四员，因为单 JSONL 文件的 size/mtime 就是有效新鲜度键）。

### 13.4 切换账号不影响历史：`projects` 是指向地区存储的软链接，且**绝不搬迁**

```js
// lib/runtime/provider-storage-policy.js —— 家族四员
sharedEntries: Object.freeze(['projects'])   // 账号投影里 projects ⇒ 宿主地区存储的软链接
```

`projects` 属于**产品而非账号**：同一台机器上同地区 WorkBuddy 与 CodeBuddy 写的是
同一份会话。aih 让每个账号投影里的 `<configDir>/projects` 成为一条指向宿主**地区存储**
的**软链接**——一份物理数据，账号只是入口。aih 展示的会话由
`lib/sessions/session-reader-codebuddy.js` 直接读**宿主地区根**得到，因此换个账号选中，
看到的列表完全一致。

**关键：投影里已有的会话既不被复制、也不被移动。** 通用链路对非 opencode Provider 的逻辑
是"检测到什么条目就共享什么"（`shareAllDetectedEntries`），并且建链前会调
`mergeEntryIntoStore`（**move**，跨设备时退化为 copy + unlink）把投影内容搬进宿主。
对 CodeBuddy 家族这会**搬走**账号投影里的真实会话——正是被否决的 copy/迁移策略。
`lib/cli/services/session-store.js` 因此为家族四员引入
`SESSION_STORE_PRODUCT_LEVEL_PROVIDERS`，走两条收紧规则：

1. **共享面严格等于声明的 `sharedEntries`**（不再"检测到什么就共享什么"，也不吃
   `isLikelySessionName` 启发式）。否则 `history.jsonl` / `shell-snapshots` 这类名字
   会被顺带链接进宿主。实现上 `shareAllDetectedEntries` 对该集合取反，
   检测循环对它们只认 allowlist 命中项。
2. **绝不迁移**：投影里的 `projects` 是**空目录**时才安全丢弃并建链；里面**已有真实
   会话文件**则如实返回 `unresolved`，让上层 fail-closed——aih 不复制、不移动、不覆盖，
   由人决定。这条与 `zcode-shared-session-store.js` 的"投影残留就地删除、绝不复制/移动"
   同口径。

`precreatedDirectories` 因此为四员都补上 `projects`：链接需要宿主那一份先存在，
否则首个进程会把 `projects` 建在一次性投影里，之后就只剩 fail-closed。

**WorkBuddy 隔离缺陷（同轮修掉）**：`workbuddy` / `workbuddycn` 此前
`privateArtifacts` 为空，上面第 1 条的"检测到什么就共享什么"会把
`settings.json` / `.mcp.json` / `sessions` 一并链接进宿主目录——后果是同一台机器上
**所有** WorkBuddy 账号共用一份配置与会话索引。现补齐三项私有声明，与
`codebuddy` / `codebuddycn` 对称，共享面收敛为只剩 `projects`。

### 13.5 可续聊：relay 只给自带 CLI 的两个站点

| Provider | 是否可被 aih 启动/续聊 | 原因 |
| --- | --- | --- |
| `codebuddy` / `codebuddycn` | ✅ | 有真实 CLI（`@tencent-ai/codebuddy-code`，随 WorkBuddy.app 分发） |
| `workbuddy` / `workbuddycn` | ❌（仅可读、可列目录） | desktop-only，没有可安装的独立 CLI |

`OFFICIAL_NATIVE_SESSION_PROVIDERS` 因此只加 `codebuddy` / `codebuddycn`。命令构造
与 qoder 同构（`lib/server/native-session-chat-command.js`）：

- 续聊 headless：`--print --output-format stream-json --resume <sessionId> <prompt>`
- 续聊交互：`--resume <sessionId> [prompt]`
- 新建：`--print --output-format stream-json --session-id <uuid> <prompt>`

桌面端两个 Provider 仍可**列进会话目录**（`session_history`），只是不声明可自行启动，
避免"声称支持却起不来"。

### 13.6 展示层去重

请求同一地区的两个 Provider（如 `[codebuddycn, workbuddycn]`）会各读到同一份地区
存储，直接拼接会让每个会话出现两次。`lib/server/webui-project-cache.js` 的
`buildProjectsSnapshot` 现在按**会话 id** 在项目内去重，胜出的是先到的那个
（`codebuddy` → `codebuddycn` → `workbuddy` → `workbuddycn`），即该地区里**自带 CLI**
的那个 Provider——"看得见"与"续得上"同时成立。

### 13.7 验证

- `node --test test/session-reader-codebuddy.test.js`：8 pass。覆盖：国内站两数据根
  合并、国际站不串味、同地区两入口结果相同、切账号结果不变、跨 Provider 定位会话文件、
  ACP→消息形态（thinking / tool / system-reminder 剥离）、标题回退、快照去重。
- `node --test test/codebuddy-shared-session-store.test.js`：7 pass。覆盖"不复制/不迁移"
  语义：共享条目严格为 `['projects']`、四员 `settings.json`/`.mcp.json`/`sessions` 保持
  私有、全新投影只**建链**（`migrated:0, linked:1`）、幂等、**投影里已有真实会话时报
  `unresolved` 且两侧存储都原封不动**、空残留目录丢弃后建链、两个账号的链接解析到同一
  物理存储。
- `node --test test/codebuddy-provider.test.js`：48 pass（含共享条目 `['projects']`）。
- 实机烟测：`~/.workbuddy`（32 项目 / 34 会话）与 `~/.workbuddy-ai`（2 / 3）经适配器
  读出后，cn 侧两 Provider 结果一致、global 侧同理。

### 13.8 已知限制（未做）

- WorkBuddy 桌面端的"新建会话"仍需在桌面端发起；aih 只负责读取与（codebuddy 侧）续聊。

> 额度/用量探测（`quota_usage`）**已闭环**，见 §14；原 §8 待办"同地区 work/code 共用一份
> 用量的实测结论"已由该节的实测取代。

## 14. 额度探测闭环：`quota_usage` 对家族四员打开（2026-09-15 实现）

§13 解决的是**历史**（会话）；本节解决同一家族的**用量**。目标是"闭环"——四支 Provider
都声明 `quota_usage`，用真实桌面端/CLI 同款接口读到真实余额，展示层不需要为家族单开分支。

### 14.1 端点：桌面端/官网同款计费接口

| 项 | 值 |
| --- | --- |
| 方法 / 路径 | `POST {endpoint}/billing/meter/get-user-resource-summary` |
| Body | `{}`（无参） |
| 鉴权 | `Authorization: Bearer <auth.accessToken>` |
| 身份头 | `X-User-Id: <account.uid>`、`X-Domain: <auth.domain>` |
| 语言 | `Accept-Language: zh` / `en`（决定 `PackageName` 语言） |
| UA | **必须真实客户端 UA**（见坑 2） |

发行版级 `endpoint`（`lib/account/codebuddy-billing.js` 的 `CODEBUDDY_FAMILY_BILLING_ENDPOINTS`）：

| Provider | endpoint | 共享凭据文件（HOME 相对） |
| --- | --- | --- |
| `codebuddy` | `https://www.codebuddy.ai` | `…/Tencent-Cloud.coding-copilot.info` |
| `workbuddy` | `https://www.workbuddy.ai` | `…/workbuddy-desktop-ai.info` |
| `codebuddycn` | `https://copilot.tencent.com` | `…/workbuddy-desktop.info` |
| `workbuddycn` | `https://copilot.tencent.com` | `…/workbuddy-desktop.info` |

凭据路径与 §3.1 / §10.3 的 `authArtifact` **同源**（`CODEBUDDY_FAMILY_AUTH_PATHS` 直接复用
`provider-storage-policy` 的 `CODEBUDDY_*_SHARED_AUTH_PATH`），所以"读会话用的那份凭据"和
"读余额用的那份凭据"永远是同一个文件，不会出现两套口径。

### 14.2 两个实测坑（错了就是静默 403 / 404）

1. **路径不带 `/v2` 前缀。** 老接口 `get-user-resource` 走 `/v2`；`#97550` 引入的三个新接口
   （`get-user-resource-summary` / `paid-packages` / `free-packages`）在网关里注册的是**无前缀**
   路径。带 `/v2` → `404 Route Not Found`。
2. **国内站网关拦脚本 UA。** `copilot.tencent.com` 对脚本默认 UA（`Python-urllib/3.x`、
   `undici`、`curl/…`）返回 `HTTP 403` + `{"code":10085,"msg":"请求不合法"}`。这不是鉴权失败，
   是 WAF 拦脚本形态；换成任意真实客户端 UA 即 `200`。探测固定带
   `User-Agent: CodeBuddy/1.0 (ai-home)`（`CODEBUDDY_PROBE_USER_AGENT`）。UA 本身不参与鉴权。

排查顺序也因此固定为：先确认无 `/v2`，再确认带 UA，最后才怀疑 token。

### 14.3 响应与聚合语义

响应形状 `{code:0,msg:'OK',data}`：

```
data.Packages[] = { PackageCode, CycleTotalCapacity, CycleRemainCapacity,
                    CycleUsedCapacity, CycleFrozenCapacity, CapacityUnit }
data.SubscriptionPackageCode, data.IsPaidUser, data.IsProtectedPriceUser, data.ProTrialStatus?
```

四个 Capacity 字段都是**字符串**（可能带小数），`CapacityUnit` 实测为 `credit(s)`。

- **积分是可跨包通用的**，所以权威值是**账户级聚合**：`probe()` 产出的 `entries[0]` 是一条
  `type:'credits'` 的聚合项（`sum(remain)/sum(total)`），供"账号还剩多少%"使用。
- 每个 `PackageCode` 另发一条 `category:'detail'` 明细项，供展示层列桶。
- `lib/account/usage-remaining.js` 的 `getUsageRemainingPctValues` **跳过 `category:'detail'`**
  （与 kimi 跳过 `category:'gift'` 同理）：一个已用尽的赠送包不应把账户级剩余率拖到 0%。
- `remainingPct` 只在**能算出来**时才有值：有 `CycleRemainCapacity` 用 `remain/total`；没有
  remain 但有 `CycleUsedCapacity` 用 `(total-used)/total`；两者都缺 → `null`（未知），
  **不回退成 100%**——把"字段缺失"显示成"满格"会掩盖真实状态，也会让聚合虚高。
- 家族**没有"重置时间"概念**（按 cycle 结算但不暴露 cycle 边界），因此 `resetIn` / `resetAtMs`
  恒为空，不臆造。

商品码 → 桶名按**前缀**匹配（尾缀是随机短串，`TCACA_code_007_nzdH5h4Nl0`），未登记回退
`code_<NNN>`；`SubscriptionPackageCode` → 档位名只对有 `CODEBUDDY_PAID_PLAN_LABELS` 的付费码
生效，体验/试用包（`IsPaidUser:false`）刻意不标档位，避免展示成 "Pro" 误导。

### 14.4 落点文件

| 文件 | 职责 |
| --- | --- |
| `lib/account/codebuddy-billing.js`（新） | endpoint / 凭据路径 / 商品码与档位码表 + 解析器 |
| `lib/cli/services/usage/codebuddy-quota-probe.js`（新） | 读共享凭据 → POST → `Packages[]` → `entries[]` |
| `lib/account/usage-remaining.js` | 登记 `codebuddy_credit_balance` 快照型 + `USAGE_SOURCE_CODEBUDDY` 来源；extractor 跳过 detail |
| `lib/account/derived-state.js` | `codebuddy_credit_balance` 计入额度派生状态 |
| `lib/cli/services/usage/cache.js`、`lib/server/accounts.js` | 家族 `cliName` 走 trusted-snapshot 校验分支 |
| `lib/cli/services/usage/snapshot.js` | 家族分派：`refreshCodebuddyUsageSnapshotAsync` |
| `web/src/components/account/UsageSnapshotCell.tsx` | 家族展示分支：聚合行「账户额度」+ 每包明细行 |
| `web/src/components/account/usage-snapshot-format.ts` | `buildCodebuddyCreditRows()`：entries → 展示行（纯函数，可单测） |
| `web/src/types/index.ts` | `AccountUsageSnapshot` 联合类型加 `codebuddy_credit_balance` |
| `core/providers/builtins.go` + 三份生成物 | 四员 `Capabilities` 增补 `CapabilityQuotaUsage` |

### 14.5 展示层：为什么必须显式加分支

`UsageSnapshotCell` 是**按 provider/kind 显式分支**的（codex/claude/kimi 一支、zcode、agy、
gemini 各一支），最后落到通用兜底——兜底只渲染 `record.remainingPct` 这**一条账号级进度条**。
家族若不加入分支，账号级数值仍会显示（兜底能读到 `remainingPct`），但 §14.3 特意产出的
**每包明细永远看不到**，等于白算。因此新增一支：聚合行标「账户额度」，明细行用商品桶名
（`activity` / `proTrialMon` / `freeMon`），hover 显示「总/剩余/已用」（`unitType=credits`）。

行构造抽到 `buildCodebuddyCreditRows()`（纯函数），因为 Web 侧测试只覆盖纯 helper、不渲染
组件（`node:test`，无 DOM renderer）。三条语义在该函数里固定：

- 聚合行（`category !== 'detail'`）标「账户额度」并**保持入参顺序**（聚合永远是第一行）——
  聚合是全量口径，排到明细后面会误导。
- 明细用尽（`0%`）**要显示**：那正是"这个包用完了"这件事本身。
- `remainingPct` 非有限值的行**丢弃**（不渲染成 0%），与 §14.3 "未知不伪装成满格"同源。
- 行携带原始 `entry`，供 tooltip 读 `resetIn`/`resetAtMs`/units——**不能用
  `entries[index]` 回查**，因为过滤后下标会错位。

家族**没有 token 刷新链路**（与 zcode/kimi 不同）：`accessToken` 由桌面端/CLI 自己维护，
过期的正确处置是重新登录，所以探测**不做**任何续期尝试，`401/403` 一律如实上报。

**消费链路（快照产出之后谁在读）**：`lib/server/webui-account-live.js` 与
`lib/server/management.js` 都按账号自己的 `provider` 调
`readTrustedUsageSnapshot(deps, provider, accountRef)`——家族四支就是靠这个入口拿到
`codebuddy_credit_balance` 的，两条路径都**没有** provider 白名单，所以无需额外登记。
（`accounts.js` 内部的 `loadCodex/Agy/Kimi/ZcodeServerAccounts` 走的是各自硬编码的
cliName，家族没有对应 loader，因此不经过它们。）

**账号从哪来（与运行时账号池无关）**：家族四支在 **Node runtime pool** 里**没有槽位**——
`lib/server/accounts.js` 的 `loadServerRuntimeAccounts()` 只枚举 11 个 provider
（codex/gemini/claude/agy/opencode/qoder/qodercn/grok/kimi/kiro/zcode），实测（注册家族账号后
调用它）返回的 pool 里四支全部缺失。**但这不影响账号可见性**：WebUI/托盘的账号列表由
`webui-account-live.js` 的 `buildFastAccountsSnapshot()` 产出，它按 `SUPPORTED_SERVER_PROVIDERS`
（= 合同全量 provider）逐支调 `listAccountCredentialRecords()` 读 **DB 凭据记录**，
runtime pool 只用于**补充**运行态（`runtimeAccountMap` 查不到就是 `null`）。
所以家族账号照常列出，只是运行态落在既有的"未知不伪装"分支——与
"这些 provider 没有 aih 托管的运行时"一致。**已加回归测试钉住**（见 §14.6）：一旦有人把枚举
改成以 pool 为准，四支就会静默消失。

### 14.6 验证

- `node --test test/codebuddy-quota-probe.test.js`：21 pass。覆盖：端点/路径解析（确认无 `/v2`）、
  商品码与档位映射、聚合 + 明细产出、**已用尽明细包不把账户级拖到 0%**、Capacity 字段部分缺失
  时取 `null` 而非 100%、共享凭据读取、e2e（stub fetch，断言 endpoint 与三个头）、api-key 账号
  空操作、缺凭据报错、非家族 Provider 拒绝、国内站 WAF 403、200 但业务错误、egress/代理透传、
  传输失败、trusted 校验存活。
- `node --test test/server.accounts.test.js`：**server 侧闸门**（`readTrustedUsageSnapshot`）——
  四支各自都被放行、**明细包用尽时账号级仍是 16.67%**、家族 cliName 配别人的 kind/source 被拒、
  非家族 cliName 读同一份合法快照返回 `null`（校验按 cliName 分派，不靠"形状对了"放行）。
- `node --test test/codebuddy-provider.test.js` + `test/provider-catalog.test.js`：声明
  `quota_usage`，`listProvidersByCapability('quotaUsage')` 含家族四员。
- `bun test web/src`（524 pass）：`UsageSnapshotCell.test.ts` 里 4 条
  `buildCodebuddyCreditRows` 用例——聚合行标「账户额度」且保持首位、明细用尽 `0%` 仍显示、
  非有限值行被丢弃、行携带原始 `entry` 供 tooltip（`总 600 / 剩余 100 credits` / `已用 500`）。
  另跑 `tsc --noEmit` 并 `comm` 对比改动前后错误列表：家族新 kind 未进
  `AccountUsageSnapshot` 联合类型会新增 2 条错误（TS2367/TS2339），补齐后回到基线 101 条、
  **无新增**；`cd web && npm run build` 通过。
- `node --test test/webui-account-live.test.js`：**账号可见性**——先断言运行时账号池里
  确实没有家族槽位，再断言四支仍全部出现在 `readAccountsFastSnapshot` 的账号快照里
  （列表按 provider 读 DB 凭据记录，与 pool 无关）；防止将来把枚举改成以 pool 为准。
- **实机（穿到 server 闸门）**：用本机真实 `.info` 凭据跑真实端点，再把快照落盘后经
  `readTrustedUsageSnapshot` 读回，三支的账户级剩余率**前后一致**——
  `workbuddy` 16.67%（100/600 credits）、`codebuddy` 16.67%（100/600）、`workbuddycn` 约 68%
  （≈1400/2056，随真实用量浮动），快照 `schemaVersion=2`。**聚合值没有被用尽的明细包拖低**：
  `proTrialMon` 为 `0/500`，而账户级仍是 `100/600 = 16.67%`，正是 §14.3 的语义。国际站两支
  （`workbuddy` / `codebuddy`）在同一账号下读到**完全一致的余额**，再次印证 §13.1 的
  "同地区两个产品跑同一套 runtime、共用一份账户级用量"。

### 14.7 展示面全覆盖核查（含 CLI；三处"疑似缺口"实测为非缺口）

§14.5 只说了 **WebUI** 一个展示面。为确认闭环，把家族快照能到达的**所有**消费方都过了一遍；
结论是**其余展示面已由既有的"数值兜底"覆盖，无需加家族分支**。记录如下，避免后人再去"修"
一个本来正常的地方：

| 展示面 | 路径 | 家族表现 | 是否需要加分支 |
| --- | --- | --- | --- |
| WebUI 账号页 | `UsageSnapshotCell.tsx` + `usage-snapshot-format.ts` | 聚合行 + 明细桶（§14.5） | **需要**（已加） |
| 交互式终端标题 | `pty/usage-status-runtime.js` → `formatUsageRemainingShort` | `[o:<id>:17%]` | **不需要**：窗口格式化返回空后**回落到 `buildUsageStatusFromCache` 的数值**（实测 `getUsageRemainingPctValues` = `[16.67]`），不是 `?` |
| CLI 账号列表 `aih <p> ls` | `profile/list.js:246` | `[Remaining: 16.7%]` | **不需要**：`formatUsageLabel` 返回空后，调用方在 `list.js:247` 用索引态 `remainingPct` 兜底 |
| 调度 / 模型-账号索引 | `model-account-index.js`、`model-capability-index.js` → `getUsageRemainingPctValues` | 账户级 16.67% | **不需要**（走 §14.3 的聚合值） |

**为什么 CLI 不需要家族分支**：`window-format.js` 的 `WINDOW_CAPABLE_KINDS` 只有
codex/claude/kimi，家族（以及**已上线的 zcode**）都返回空——这是**有意且有测试**的行为
（`test/usage.window-format.test.js`："non-windowed kinds yield nothing here"）。语义窗口
（5h / 7days）对**按 credits 计费的额度桶**本就不适用：家族 entry 没有 `window` 字段，
即使把 kind 加进 `WINDOW_CAPABLE_KINDS` 也会被 `filter(entry => entry.window)` 滤光，
**加了等于白加**。契约是"格式化器只认时间窗，非时间窗 kind 由调用方自行兜底"，而两个调用方
（终端标题、`ls`）都**确实**有数值兜底。

**另两处"看起来像缺口"实则不是**：

- `lib/server/provider-usage-policies.js` 的策略注册表只登记了 **5/15** 个 provider
  （codex/gemini/agy/claude/kimi）——家族**和** zcode/grok/qoder/opencode/kiro 等一样缺席。
  未登记时 `resolve()` 返回 `FALLBACK_USAGE_POLICY`（`status:'not_applicable'`），
  而 `isUsageDecisionSchedulable` 只在 `exhausted` 时返回 false，故兜底是"**保持可调度**"。
  这对家族**安全**（额度耗尽由上游 429 + 账号 runtime 态兜底），且**不是家族特有问题**——
  是这张表本身的既存覆盖度问题，单独给家族补会与另外 9 支不一致，故**不改**，仅记录。
- `web/src/pages/AccountsGoPreview.tsx` 的用量分支同样没有家族——但该页**只在
  `npm run go-preview:web`（`AIH_GO_ACCOUNTS_PREVIEW=1`）的隔离进程里加载**，且按
  `docs/functional-matrix.md` ACC-003 / WEB-048 的既定边界**刻意**把 quota 投影为
  `unknown`（"没有证据时不伪造健康/可调度"）。家族不进 Go Preview 是**设计**，不是缺口。

**详细输出后续已补齐（`29795c88`）**：`presenter.js:formatUsageSnapshotLines`
将 CodeBuddy 家族交给 `credit-format.js`，按账户聚合与每包明细输出额度和剩余比例，
缺字段明确为 unknown。`test/usage.credit-format.test.js` 钉住该行为；未知 kind 仍保留
原有 JSON 诊断输出，不通过扩大时间窗格式化器来伪造非时间窗语义。

2026-09-18 的历史评审核对、明确保留的产品边界和验证结果见
[账号身份生产验收](account-identity-production-acceptance-2026-09-18.md)。

