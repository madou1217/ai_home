# CodeBuddy 家族：账号/凭据模型实测（逆向校验）

> 结论先行：**账号共享（同一 uid），凭据不互通（按站点签发，且落盘位置/保护方式各不相同）；但 CN 侧的凭据文件是明文 JSON 放在固定共享路径上，CLI 与 IDE/App 本来就读同一个文件。**
>
> 本文是"反向校验"记录：对一台**已同时登录 CodeBuddy CN 与 WorkBuddy** 的 macOS 机器勘察，验证 `aih` 侧 provider 建模与隔离策略是否成立，并给出 CLI 安装闭环 / 凭据共用的可行方案；历史启动探针的令牌刷新副作用见 §4.0。

## 0. 勘察范围与方法

文件勘察以只读为主；历史 CLI 启动探针曾自动刷新原生令牌，副作用见 §4.0。本次提交前仅核对源码并脱敏，不重做带凭据的探针。证据来源：

| 证据类型 | 具体位置 |
| --- | --- |
| 应用安装 | `/Applications/{CodeBuddy,CodeBuddy CN,WorkBuddy}.app` |
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

### 5.2 需要修正的部分（重要）

**`codebuddycn` 的存储策略把凭据隔离寄托在 `~/.codebuddy-cn` 上 —— 但凭据不在那里。**
真实凭据路径是平台固定的 `…/CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`，
**不随 `CODEBUDDY_CONFIG_DIR` 变化**（§4 第 2 条已实测）。后果：

- `codebuddy` / `codebuddycn` / `workbuddy` 三个 provider 的账号**会落在同一个 `.info` 文件上互相覆盖**；
- 若两个 aih 账号都指向国内站，实际只有一份有效登录态。

**可行的隔离杠杆**（CLI 原生支持，无需改 CLI）：

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

- [ ] 修正 `lib/runtime/provider-storage-policy.js`：为 `codebuddy` / `codebuddycn` / `workbuddy` 声明真实的
      `authArtifacts` 路径（`…/CodeBuddyExtension/Data/Public/auth/<id>.info`），并说明该路径**不受 `CODEBUDDY_CONFIG_DIR` 约束**。
- [ ] 启动策略注入每账号唯一的 `ACC_PRODUCT_CONFIG_V3.authentication.id`，实现凭据文件名级隔离。
- [ ] 安装器增加"优先探测 App 内嵌 CLI"分支（复用版本一致性），npm 安装作为回退。
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
