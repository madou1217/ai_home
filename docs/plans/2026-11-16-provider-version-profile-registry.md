# Provider 版本画像注册表（Go 主实现）

日期：2026-11-16
状态：需求与设计，待实现
范围：跨 Provider 的版本/参数画像管理；首批落地 ZCode，其他 Provider 按同一合同接入

## 1. 为什么需要

Provider 的“版本号”不是展示字段，而是一组**请求合同**的键：

- ZCode：`app_version` 同时门控 `billing/preview`（旧版本静默返回 `plans:[]`）与套餐模型；请求体还要求 harness 与版本**同源成对**，只抬版本不换 harness 会 3012。
- 其他 Provider 也有同类差异：升级前后请求头、端点、字段集合、能力声明都可能变化。

现状问题：

1. 同一 Provider 的版本事实分散在 `run/zcode-app-version.json`、`run/zcode-harness.json`、活动链路缓存，可能互相矛盾。
2. 模型目录、额度、领取、relay 各读各的版本，出现“目录用新版、relay 用旧版”。
3. 上游出新版本时没有统一发现与提示，只会表现为空目录、空 plans 或 3012，无法区分“真没有”与“版本不够”。

## 2. 目标

1. 每个 Provider 只有**一个**生效版本画像（Profile），所有通道共用。
2. 版本与参数（harness/headers/endpoints/feature gates/deprecated fields）**原子绑定**。
3. 支持同一 Provider 的多个 Profile 关联不同版本区间，允许并存与灰度。
4. 发现新版本时给用户明确升级提示；不允许静默降级或只改版本号。
5. 合同 Provider 无关；ZCode 作为第一个实现，其他 Provider 后续注册即可。

非目标：

- 不自动升级/安装 Provider 桌面客户端。
- 不改变现有模型路由、账号池、额度策略。
- 不引入 WebUI 轮询（沿用挂载/聚焦/SSE/手动刷新）。

## 3. 核心模型

### 3.1 ProviderVersionProfile

```go
type ProfileID string

type VersionState string // ok | update_recommended | update_required | unsupported_version

type VersionProfile struct {
    ID          ProfileID
    ProviderID  string
    Range       string   // semver 区间，如 ">=3.17.0 <3.19.0"
    Channel     string   // electron-cli / stable / production
    Source      string   // installed | cache | online | seed | registry
    VerifiedAt  time.Time

    // 请求合同
    HarnessRef   string            // 指向 harness 模板/块集合的稳定引用
    Headers      map[string]string // 版本相关头（不含账号密钥）
    Endpoints    map[string]string // balance/preview/claim/models/relay
    FeatureGates map[string]bool   // previewGated、modelCapabilities 等

    // 废弃字段：仍随该 Profile 发送，但标记并计时
    DeprecatedFields []DeprecatedField

    Status ProfileStatus // active | deprecated | retired
}

type DeprecatedField struct {
    Path       string    // 请求体/头路径
    Reason     string
    RemoveAfter time.Time
}
```

要求：

- `Range` 支持多个 Profile 覆盖不同版本段；同一版本只允许一个 active Profile。
- `HarnessRef` 与 `Headers` 必须随版本一起切换；禁止单独修改版本头。
- `DeprecatedFields` 在该 Profile 生命周期内继续发送，但必须出现在状态 API 与日志中；Profile 退休后不再发送。

### 3.2 Registry

```go
type Registry interface {
    Match(providerID, version, channel string) (VersionProfile, bool)
    Latest(providerID string) (VersionProfile, bool)
    List(providerID string) []VersionProfile
    Register(profile VersionProfile) error
}
```

- 内置注册优先，远程 manifest 只用于“发现新版本/提示”，默认不自动激活。
- 匹配顺序：精确版本 → 版本区间 → last-known-good。
- 无匹配：保留当前 Profile 继续服务，状态置 `unsupported_version`，禁止静默 fallback 到 seed。

### 3.3 解析与持久化

- 新增统一解析器：`internal/adapters/<provider>/versionprofile`（ZCode 首批）。
- 解析优先级：已安装客户端 → 宿主缓存 → 官方发布页/接口 → seed。
- 缓存文件建议：`<aiHomeDir>/run/provider-profiles/<provider>.json`，含 profile、source、fetchedAt、验证证据摘要（不含凭据）。
- 兼容读取旧文件：
  - `run/zcode-app-version.json`
  - `run/zcode-harness.json`
  首次解析成功后写新文件，旧文件只读不再写。

## 4. 运行时行为

所有通道必须注入同一个 `ResolvedProfile`：

| 通道 | 使用字段 |
| --- | --- |
| relay（zcoderelay） | HarnessRef、Headers、Endpoints、版本头 |
| 模型目录 | 版本查询参数、FeatureGates、Endpoints |
| 额度/usage | 版本查询参数、Headers |
| 活动领取 | 版本查询参数、Endpoints、FeatureGates |
| WebUI 状态 | 全量只读快照 |

状态机：

- `ok`：当前 Profile 与最新版本一致或仍被上游接受。
- `update_recommended`：上游有更新，当前仍可用。
- `update_required`：上游已按版本门槛拒绝（空 plans、空目录、3012、明确的版本错误）。
- `unsupported_version`：最新版本没有匹配 Profile；保持 last-known-good，提示升级 aih/安装新版 Provider。

关键规则：

1. 空结果先行复核：preview/plans 为空、模型目录为空时，先重新解析版本，再判定“真的没有”。
2. 版本与 harness 原子替换：写缓存使用临时文件 + rename；任何一步失败保留旧 Profile。
3. 禁止跨大版本静默降级；降级必须显式状态。

## 5. API 与用户提示

新增只读接口（管理面，沿用现有鉴权）：

```
GET /v1/management/webui/providers/{provider}/version-profile
POST /v1/management/webui/providers/{provider}/version-profile/refresh
```

返回：

```json
{
  "provider": "zcode",
  "current": {"version": "3.16.3", "profileId": "zcode-316", "source": "cache"},
  "latest": {"version": "3.18.2", "source": "online"},
  "state": "update_recommended",
  "requiredFor": ["preview", "models"],
  "deprecatedFields": [{"path": "body.foo", "removeAfter": "2026-12-31"}],
  "checkedAt": 1794826000000
}
```

WebUI：

- 账号页/Provider 状态行内展示紧凑状态：`ZCode 3.16.3 → 3.18.2 可升级`，附“刷新画像”。
- 不使用大块 Alert、不使用左侧彩条（遵守仓库 UI 约束）。
- 数据刷新只走挂载/聚焦/手动或 SSE，不新增轮询。

活动结果：

- 领取/探测失败结果新增 `versionState` 与 `versionHint`；
- `plans:[]` 且状态为 `update_required` 时，状态码用 `version_gated`，不再写成 `nothing_claimable`。

## 6. ZCode 首批落地清单

1. 新建 `internal/adapters/zcode/versionprofile`：解析 installed → cache → 安装页 → seed；产出 Profile（含 harness 引用）。
2. 替换现有读取点：
   - `internal/adapters/zcode/modelcatalog`
   - `internal/adapters/zcode/usage`
   - `internal/adapters/accountactivity`（ZCode 分支）
   - `internal/host/aihserver/zcode_host_facts.go`（relay）
3. 注册表内置首批 Profile：3.16.x、3.17.x、3.18.x；harness 按版本段绑定。
4. 新增状态 API 与 WebUI 状态行。
5. 旧缓存兼容与写迁移。

## 7. 其他 Provider 接入

- 合同不变：`versionprofile.Resolver` + `Registry`。
- 先接有明确版本门控的 Provider（codex client_version、kiro、qoder、codebuddy 家族），再接无版本差异的 Provider（仅注册单一 default Profile）。
- 每个 Provider 的 Profile 注册放在各自的 adapter 包，不写进公共装配函数。

## 8. 验收（真机，不新增测试文件）

1. ZCode 3.16.3 + 旧 harness：preview 空 → 状态必须为 `update_required` 并提示 3.18.2，而不是“无可领”。
2. ZCode 3.18.2 + 对应 harness：目录/额度请求版本参数为 3.18.2，relay 头与 harness 同版本。
3. 只改版本头、不换 harness 的构造请求：必须被拒绝/回退，不能发到上游。
4. 版本缓存写入中断：保留旧 Profile，服务不中断。
5. WebUI 状态行显示 current/latest/state；刷新动作生效；无轮询请求。
6. 废弃字段：Profile active 时仍发送并在状态 API 可见；Profile retired 后不再发送。

## 9. 风险与约束

- 上游版本门槛是**假阴性**，不能只靠 HTTP 状态判断；必须以“结果为空 + 版本复查”组合判定。
- 远程 manifest 不可信：只提示，不自动切换 Profile。
- 迁移期间会出现新旧缓存并存，必须保证只写一处、只读兼容。
- 与并行会话的文件边界：实现时避开 `codexresponsesws`、`terminalsession`、peer adapters。
