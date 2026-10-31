# ZCode「领臭鸡蛋」协议与失败归因（2026-10-30 抓包取证）

> 结论先行：**领取（写）接口只有一条**；**「哪里能领」的发现通道有两条**，桌面端用的是营销投放，
> WebUI 当时只用了 billing/preview —— 而 preview 当天对全部账号都不返回 data。这是「桌面端能领、
> WebUI 领不到」的根因。

## 1. 接口清单

| 用途 | 方法 / 路径 | 桌面端实现 | 唯一性证据 |
|---|---|---|---|
| **领取（写）** | `POST /api/v1/zcode-plan/billing/claim`，body `{"plan_id":"…"}` | `claimManualPlan(plan)` | 整个 app.asar（373 MB）里 `billing/claim` 只出现 **1 次** |
| 发现 A：套餐预览 | `GET /api/v1/zcode-plan/billing/preview?app_version=&platform=` | `getManualClaimPlanPreviews()` | `billing/preview` 只出现 1 次 |
| 发现 B：营销投放（banner/弹窗 + 领取按钮） | `GET /api/v1/marketing/touch?seq=N` | `createMarketingTouchService().query()` | `marketing/touch` 出现 2 次（URL 构造 + 服务） |
| 状态 / 额度 | `GET /api/v1/zcode-plan/billing/balance` | 余额与套餐（`plans[]` + `balances[]`） | 与上同源 |
| 验证码配置 | `GET /api/v1/client/configs` | `getRequestVerificationConfig()` | — |
| 投放动作回执 | `POST /api/v1/marketing/touch/action` | `{campaign_id, action_type}`，取值为 `confirm` / `cancel` | 不是领取 |

**不是本功能的端点（旧结论纠偏）**：`/api/v1/remote/ws2` 与 `/api/v1/remote/notification/status`
属于 **Web 远程控制**（`relayWsUrl` / `protocol_version + event_transport`），与领取横幅无关。
之前把「桌面端常驻 WS 推送 = 活动推送」当成结论是错的，本报告以 asar 逐字实现为准。

不存在其它写通道：`plan/claim`、`claim-plan`、`start-plan/claim`、`incentive` 在 bundle 中命中 0 次；
`rewards` 的 28 次命中是 `rewardsWebview.cjs` 页面与导航字面量，不是接口。

## 2. 桌面端实现（app.asar 逐字切片，3.17.1）

字节偏移可直接复核：`dd if=app.asar bs=1 skip=<offset> count=<n>`。

### 2.1 预览：缺 `data` 是**错误**，不是「没有活动」

```js
// @312516834
async getManualClaimPlanPreviews() {
  let t = (await this.credentialService.load('zcodejwttoken'))?.trim(),
      n = new URL(wr(process.env, '/api/v1/zcode-plan/billing/preview'));
  n.searchParams.set('app_version', En);
  n.searchParams.set('platform', tD());
  let r = await tc(this.apiClient, n, { method:'GET', headers: t ? {Authorization:`Bearer ${t}`} : void 0, timeoutMs: 15e3 });
  if (r.code !== void 0 && r.code !== 0) throw new Error(r.msg?.trim() || 'manual_claim_preview_failed');
  if (!r.data) throw new Error(r.msg?.trim() || 'manual_claim_preview_missing_data');   // ← @312517170
  let o = r.data, s = aX(o.server_time), a = (o.plans ?? []).flatMap(...);
  return { ...(s === void 0 ? {} : {serverTime: s}), plans: a };
}
```

即：`code:0` 但无 `data` → **抛错（可重试）**；`data.plans` 为空数组才是「暂无可领」。

### 2.2 领取：一个 POST，验证码头是「有就带」

```js
// @312518129
async claimManualPlan(t) {
  let n = (await this.credentialService.load('zcodejwttoken'))?.trim();
  if (!n) return { success:false, code:401, message:'' };
  let r = await tc(this.apiClient, new URL(wr(process.env, '/api/v1/zcode-plan/billing/claim')), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${n}`,
      'Content-Type': 'application/json',
      ...WW(t),                              // = requestVerificationClaimHeaders(@311033319)
      'X-ZCode-App-Version': En,
      'X-Platform': tD()
    },
    body: JSON.stringify({ plan_id: t.planId }),
    timeoutMs: 15e3
  });
  // 成功判据：code === 0 && r.data.plan
}
```

`WW` 即：

```js
function M7(t) {   // @311033319
  return {
    'X-Aliyun-Captcha-Verify-Param': t.captchaVerifyParam,
    ...(t.captchaRegion ? {'X-Aliyun-Captcha-Verify-Region': t.captchaRegion} : {})
  };
}
```

### 2.3 领取前的「verifying」阶段（桌面端为什么点一下就好）

```js
// @360569463
async function WOt(e, t, n) {            // e=service, t=signal, n=onPhase
  n();                                   // → 界面进入 'verifying'
  let r = await e.getRequestVerificationConfig();          // /client/configs
  let i = await NOt(e, { source:'send_preflight', signal:t });  // 无痕验证参数
  if (i?.trim()) return { captchaVerifyParam: i, ...(r?.region ? {captchaRegion: r.region} : {}) };
}
```

`NOt`（@360564601）在 **渲染进程** 里跑阿里云无痕验证；`UOt` 在窗口可见性变化时**预热**，
所以用户点「领取」时参数已在手，点击 → verifying → submitting 一气呵成。

注意这里的**门槛在客户端**：`WOt` 拿不到参数就返回 `undefined`，调用方直接
`{status:'cancelled'}`（不领）。也就是说桌面端自己要求验证码成功，**但上游并不校验** ——
实测带正确 `plan_id` 的 claim 不带该头同样成功（见 §5）。所以「必须先解出验证码」
是客户端策略，不是服务端约束。

### 2.4 横幅来自营销投放，`plan_id` 也由它下发

```js
// @311265511：投放按钮动作的 schema
action = discriminatedUnion('type', [
  { type:'close' },
  { type:'open_url', args:{ url } },
  { type:'claim_zcode_plan', args:{ plan_id } },   // ← 「领取」按钮
  { type:'navigate', args:{ page } },
  { type:'copy_text', args:{ text } }
]);
// 投放：{ resource_position:'banner'|'popup', campaign_id, priority, banner|popup }
// 响应：{ code:0, data:{ server_time, language, deliveries:[…] } }
```

点击时（@360606916 附近）：

```js
let t = await WOt(n.codingPlanSubscriptionService, s, () => l('verifying'));
if (!t) return { status:'cancelled', message: … };
l('submitting');
let r = await n.codingPlanSubscriptionService.claimManualPlan({ planId: e.args.plan_id, ...t });
```

**关键**：桌面端领取用的 `plan_id` 来自 **marketing/touch 的 delivery**，不是 preview。
所以 preview 返回空不影响桌面端领取 —— 只要横幅投放到了。

## 3. 抓包现场（真实日志，/tmp/zcap/cap10.out）

桌面端启动后（3.17.1，沙箱 HOME）：

- 20:26:34 `GET /billing/balance?app_version=3.17.1` → 200，`plans:[zcode-v3-start-plan-0817]`（该账号当时**没有**新套餐）
- 20:36:49 `GET /api/v1/marketing/touch?seq=1` → **15s 超时**（`marketing-touch.query FAIL (15011.3ms)`）
- 20:37:34 `seq=2` → 同样 15s 超时；`seq=3` / `seq=4` 同样超时

这解释了「等一会这个账号没有弹窗」：**横幅不是本地算出来的，是 marketing/touch 投放的**；
投放请求超时 → 没有 banner → 没有领取入口。

**点击那一次补上了**（§3.2）：点击落在横幅外层 `<button>` 上 → host 进程
`coding-plan-subscription.claimManualPlan` 198.8ms 返回 OK → 紧接的 balance 里出现
`zcode-v3-start-plan-1030-wk` `status:active`。**没录到的只剩 HTTP 报文本身** ——
claim 的 `fetch` 在 host 进程里，主进程钩子看不见；§3.2 末尾写清了为什么这条隧道走不通，
报文形状以 §2.2 的逐字切片为准。

**关于「点了两次才成功」**：点击处理链有三个非成功出口 ——
`verifying` 阶段被取消 → `{status:'cancelled'}`；验证码解算抛错 → `{status:'failure'}`；
已进入 `submitting` 后请求异常 → `{status:'uncertain'}`（文案「结果不确定」）。
第一次点击若停在 `verifying`（预热未就绪 / 交互式验证弹出）或 `uncertain`，
用户再点一次才会走完整条链 —— 与「点两次成功」的现场一致。这是推断，不是抓包结论。

### 3.1 claim / preview 的 wire 报文（非破坏性复放）

桌面端点击的那一次没录到，但**端点契约可以在线上验证**：用同一账号的 jwt、同一套客户端头，
直接打两个端点，其中 claim 用一个**必然不存在**的 `plan_id`（不存在的套餐无法被领取，
账号状态零变化）。原始报文：`/tmp/zcap/wire-claim.json`。

```http
GET /api/v1/zcode-plan/billing/preview?app_version=3.20.0&platform=darwin-arm64
Authorization: Bearer <zcodejwttoken>   (+ X-Device-Mid / X-Platform / X-ZCode-App-Version …)

200 {"code":0,"msg":"","logid":"2026103014302742e2e5d7733001edb114"}
```

**没有 `data` 字段** —— 这就是旧代码拿到的那份响应，它被判成了「暂无可领」。

```http
POST /api/v1/zcode-plan/billing/claim
Content-Type: application/json
Authorization: Bearer <zcodejwttoken>
（**没有任何 X-Aliyun-Captcha-* 头**）

{"plan_id":"zcode-v3-start-plan-0000-does-not-exist"}

200 {"code":1001,"msg":"target not found",
     "data":{"server_time":1793370627,"message":"This plan does not exist or is no longer available."},
     "logid":"20261030143027713bb5e1f8ae60ba306f"}
```

三条结论（都是线上事实，不是读代码推的）：

1. claim 端点接受**不带验证码**的请求并直接进入 plan 查找（返回 1001，而不是 3007）。
   旧注释「服务端先校验验证码、再校验 plan_id」被推翻 —— 验证码不是 claim 的服务端前置。
2. 错误信封形状确认：HTTP 200 + `code/msg/data.message`（客户端必须按业务码判错）。
3. preview 的原始 body 就是 `{"code":0,"msg":"","logid":…}`，`data` 整个缺席 ——
   与桌面端 `if(!r.data) throw manual_claim_preview_missing_data` 的判断依据一致。

方法论注意（为什么之前的 MITM 代理无效）：`marketing/touch` 与 `billing/*` 都在
**host 进程**里发（日志前缀 `[zcode-host] [rpc:call]`），渲染层 `fetch`/`XMLHttpRequest` 钩子
和页面级 CDP `Network` 都看不到；host 进程的 axios 不读 `HTTPS_PROXY`，所以只能靠
`--inspect` 注入主进程（`http/https.request`/`tls.connect`）或读 host 日志。

### 3.2 桌面端「点一下领取」的完整链路（2026-10-30 22:40:46 实录）

**点击落点不是 SVG，是包住 iframe 的 button。** 渲染层实测结构：

```html
<div class="relative w-full">
  <button aria-label="Open" data-testid="cloud-dialog-interactive-hero" class="block h-24 w-full ...">
    <span class="pointer-events-none block size-full overflow-hidden" inert>
      <iframe src="http://127.0.0.1:64812/<uuid>/index.html"
              class="pointer-events-none size-full border-0 bg-transparent"
              data-hero-type="interactive_bundle" data-instance-id="cloud-hero-1" data-status="ready">
```

- iframe 在页面坐标 (17, 647)、234×94，且 `pointer-events:none` —— 横幅里的 `Claim` 永远收不到鼠标事件；
- 真正的点击入口是外层 `<button>`，onClick 为 `()=>{e.clickBanner().catch(()=>J.warn('[marketing-touch] action failed'))}`；
- `banner.js` 只处理 `destroy` / `ready` 两条消息，没有任何 click 逻辑 —— 所以对 SVG 派发 `MouseEvent` 什么都不会发生（先试了两次：`Input.dispatchMouseEvent` 打在 (199,73)、以及在 `g#claim-indicator` 上合成 `PointerEvent`/`MouseEvent`，host 日志零 RPC）。

**在页面坐标 (216, 720) 派发一次真实 `Input.dispatchMouseEvent`（mousePressed + mouseReleased）后，host 日志逐条（点击时刻 ≈ 22:40:45.4）：**

```
22:40:46.771 [zcode-host] [rpc:call] coding-plan-subscription.claimManualPlan OK (198.8ms)
22:40:46.856 [zcode-host] [rpc:call] marketing-touch.report OK (83.3ms)
22:40:46.973 [zcode-host] [rpc:call] marketing-touch.query OK (162.7ms)
22:40:46.987 [coding-plan-availability] billing/balance 请求完成
   plans:[{plan_id:'zcode-v3-start-plan-1030-wk', name:'ZCODE WEEKEND BUILD',
           status:'active', starts_at:1793371246, ends_at:1793581200}]
```

点击前 balance 里只有 `zcode-v3-start-plan-0817`；点击后多出 `zcode-v3-start-plan-1030-wk` 且
`status:active`、`starts_at` 正好是点击那一秒。**领取成功，且立即生效**（这份投放没有「待生效」窗口）。

由此确定的三件事：

1. **桌面端确实每次都解验证码**，而且解得很快 —— 点击瞬间的验证码事件（同一个 `cap11.out`）：

```
22:40:45.497 captcha-diagnostics attempt.start  source:'send_preflight'  stage:'start'
22:40:45.497 attempt.stage trigger_delay → instance_wait → verification
22:40:46.572 sdk.callback  stage:'sdk_init'  lastSdkEvent:'success'  accepted:true   ← 1.07s 解完
22:40:46.573 attempt.end
22:40:46.771 claimManualPlan OK (198.8ms)
```

   也就是说：**点击 → verifying（真实渲染进程里 1.07s 解完）→ submitting（198.8ms 的 POST）**，
   与 §2.3 的 `WOt` 完全一致（`source:'send_preflight'` 正是它的标签）。
   验证码是**客户端自己加的门槛**，桌面端在真浏览器里 1 秒就过；WebUI 用 headless Chrome 同步解，
   解不出来就整体失败 —— 这就是「桌面能领、WebUI 领不到」的直接差别。
2. 领取成功后立刻 `marketing-touch.report`（回传点击）+ `marketing-touch.query`（刷新投放）——
   这就是「领完横幅消失」的机制。
3. `plan_id` 全程来自横幅按钮的 `action.args.plan_id`，与 `billing/preview` 无关（§2.4）。

**HTTP 报文本身仍然没有录到（如实记录 + 为什么这条路走不通）**：claim 的 `fetch` 发生在 host 进程
（`out/host/index.js` 的 `NodeApiClient.request` → `fetch`）。

| 尝试 | 结果 |
|---|---|
| 主进程 `--inspect` 注入 `http/https.request` / `tls.connect` | 只看到主进程自己的请求，claim 不在其中 |
| `NODE_OPTIONS=--require` 注入 host | 被 Electron 丢弃（marker 文件无输出） |
| `utilityProcess` 的 `execArgv` 加 `--inspect` | host 随窗口创建，钩子来不及挂 |
| `ZCODE_BASE_URL=https://127.0.0.1:8902` + 本地 HTTPS 代理 | 主进程与 host 的 GET 都改道成功（48 条，含 `marketing/touch`、`billing/balance`），但 Chromium 网络服务被代理打断：`Network service crashed` → 渲染进程 `exit_code 1` → 窗口关闭 |

所以 claim 报文的形状以 §2.2 的逐字切片为准（URL / 头 / body 全部来自 app.asar 原文），
端点行为以 §3.1 的线上复放为准。两者与 §3.2 的 RPC 时间线互相对齐：一个 POST、无验证码、198ms 返回。

## 4. WebUI 侧实测（只读 GET）

### 4.1 全量三通道矩阵（2026-10-30 15:05Z 复测，app_version 3.20.0）

| 账号 | balance | preview | marketing/touch | 判定 |
|---|---|---|---|---|
| acct_91aa805b… | `plans:[zcode-v3-start-plan-1030-wk active]`，`balances:1` | 200 `{code:0}` **无 data** | 0 条投放 | **已领到且已生效** |
| acct_ae47a462… | 同上 | 200 `{code:0}` **无 data** | 0 条投放 | **已领到且已生效** |
| acct_9fe1dc… | `plans:[] balances:0` → 领取后 `…1030-wk active`，`balances:1` | 200 `{code:0}` **无 data** | **1 条 banner，claimable `zcode-v3-start-plan-1030-wk`** → 领取后 0 条 | 原来真没领到，**已用修复后的代码领到** |
| acct_a09b9d… | 同上 | 200 `{code:0}` **无 data** | 同上 | 同上 |
| acct_6738589e… / acct_bc54735c… / acct_d88d9008… | — | — | — | 本机 shell 解不出 JWT（见 4.3） |

这张表就是「其他账号为什么还是没领到」的答案：

- 两个账号**已经领到了**（balance 里 plan `active` + 一个额度桶），只是旧 WebUI 的列表里看不出来；
- 两个账号**真的没领到**，而它们的领取入口只存在于投放通道 —— preview 是空的，
  旧代码在这里判「暂无可领」，永远不会发出 claim（桌面端横幅照样有「领取」按钮）；
  这两条已用修复后的路径（§6 的投放发现通道）实领成功：
  `status: claimed`、`discovery: marketing_touch`、`claimed:[zcode-v3-start-plan-1030-wk]`，
  随后 balance 变成 `…1030-wk/active` + `balances:1`，投放也随之撤下（deliveries 0）；
- 剩下三个账号的判定必须在 WebUI 进程里做：凭据解密只在那个进程里有密钥（4.3）。

注意 `balances` 的口径：早前（14:30Z）采集时 91aa805b / ae47a462 是 `balances:0`（已领取、未生效），
现在变成 `1` —— 生效时间到点后额度桶才出现，这正好是 §6「未生效套餐」要展示的那段窗口。

### 4.2 preview 的空返回与参数无关

`/tmp/zcap/preview-matrix.json`（同一账号逐格实测）：

| app_version | darwin-arm64 | win32-x64 |
|---|---|---|
| 3.16.3 | 200 `{code:0}` 无 data | 200 `{code:0}` 无 data |
| 3.17.1 | 200 `{code:0}` 无 data | 200 `{code:0}` 无 data |
| 3.18.0 | 200 `{code:0}` 无 data | 200 `{code:0}` 无 data |
| 3.20.0 | 200 `{code:0}` 无 data | 200 `{code:0}` 无 data |

带 / 不带 `X-Device-Mid` 也一致（两次都是 `{"code":0,"msg":""}`）。所以「WebUI 看不到活动」
不是版本门槛或设备头的问题，而是**这条通道当天就是空的** —— 真正有内容的是投放通道。

### 4.3 三个账号在本机 shell 里解不出 JWT

`acct_6738589e` / `acct_bc54735c` / `acct_d88d9008` 的 `zcodejwttoken` 是 `enc:v1:` 密文，
解密密钥由 `ZCODE_CREDENTIAL_SECRET` 或 `zcode-credential-fallback:<platform>:<homedir>:<username>` 派生。
本采集进程跑在 **HOME 被投影到沙箱**的环境里（`HOME=<aiHome>/run/auth-projections/...`），
派生出的密钥与加密时不同，解密返回空。**这是采集环境的限制，不是账号故障**：
WebUI/服务端进程用真实 homedir，同一份凭据可正常解密（桌面端 20:26 的 balance 日志即证明
acct_6738589e 凭据可用）。

## 5. 归因

WebUI 领取失败是两条独立缺陷叠加：

1. **发现通道被判成「没有活动」**（旧 `lib/account/activity-claim/zcode-plan.js:211-217`）：
   `preview.json.data?.plans ?? []` → 空 → `status = 'nothing_claimable'`。
   上游回 `{code:0}` 无 data 时，WebUI 直接结论「暂无可领」，**从不发 claim**，
   定时任务同样静默跳过整个活动窗口。
2. **验证码被当成前置条件**（旧 `:235-259`）：每次领取先拉起本机 Chrome 解阿里云无痕验证，
   解算失败即整体失败（`zcode_captcha_solve_failed`）。而上游**不校验**：
   带正确 `plan_id` 的 claim 不带任何 `X-Aliyun-Captcha-*` 头直接成功
   （2026-10-30 早些时候用真实账号复现，未留原始报文；§3.1 的 1001 结果是同向的线上证据 ——
   没有验证码头也照样进了 plan 查找）。

桌面端没有第一个问题：横幅走 marketing/touch（preview 为空无所谓），`plan_id` 由投放下发。
第二个问题上，桌面端**同样每次点击都解验证码**（§3.2 实录：`attempt.start` → `sdk.callback success`
1.07s → 才发 claim），区别在于它在**真实浏览器渲染进程**里解、且 `prewarm` 会提前把 SDK 实例
暖起来（`elapsedMs: 183159` 的那次预热），所以 1 秒就能拿到参数；WebUI 把这一步做成了
**同步硬前置**（headless Chrome 解不出来直接 `zcode_captcha_solve_failed`），既慢又脆。
换句话说：桌面端能领，不是因为它跳过了验证码，而是因为它解得动；WebUI 领不到，是因为把
一个「客户端自选动作」变成了「不成功就不领」的开关。

## 6. 修复对照

| 缺陷 | 修复 | commit |
|---|---|---|
| preview 缺 data 判成 nothing_claimable | 返回 `zcode_preview_missing_data`（可重试），与桌面端 `manual_claim_preview_missing_data` 同义 | `96acc06e` |
| 验证码前置 | 改为「先裸领；只有上游回 3007 才解一次并重试一次」，解不出来按 3007 如实报错 | `96acc06e` |
| 已领取但未生效的套餐在 WebUI 不可见 | 额度探针产出结构化结论快照（`planGroups` + `account.planNames` + `pendingEffectiveAtMs`），界面显示「套餐未生效 · 10-30 23:00 起可用」 | `96acc06e` |
| 只有 preview 一条发现通道，preview 恒空就永远「暂无可领」 | 补 marketing/touch 发现通道：preview 空/缺 data 时回落取投放里的 `claim_zcode_plan` plan_id | 本次 |

发现通道的实现（`lib/account/activity-claim/zcode-plan.js`）：

- `GET /api/v1/marketing/touch?seq=0`，请求头与 preview 同源（`Authorization` / `X-ZCode-App-Version` /
  `X-Device-Mid` / `X-Client-Language`）；
- 解析 `data.deliveries[]`，按 `resource_position` 去重（banner 只取第一条），
  只认 `buttons[].action.type === 'claim_zcode_plan'`，取 `action.args.plan_id`；
- `result.discovery` 记录本次 plan_id 来自 `preview` 还是 `marketing_touch`，
  `result.marketingTouch` 记录投放条数 / 可领数 / 错误，便于排障；
- preview 缺 data **且**投放也为空时，仍按 `zcode_preview_missing_data` 报错（可重试），
  不会被误判成「活动没开」。

线上只读验证（2026-10-30 15:00Z，dryRun 只发 GET，不产生 claim）：

| 账号 | preview | 投放 | 结论 |
|---|---|---|---|
| acct_9fe1dc… | `{code:0}` 无 data | 1 条 banner，`claimable=1` | `zcode-v3-start-plan-1030-wk` 可领 —— 旧代码在这里判「暂无可领」 |
| acct_a09b9d… | `{code:0}` 无 data | 1 条 banner，`claimable=1` | 同上 |
| acct_91aa805b… | `{code:0}` 无 data | 0 条 | 已领过（投放已撤） |
| acct_ae47a462… | `{code:0}` 无 data | 0 条 | 已领过 |

**端到端演练**（同一账号 `acct_9fe1dc…`，把 claim 的 `plan_id` 改写成必然不存在的值，账号状态零变化）：

```
discovery=marketing_touch  deliveries=1  claimable=1  plans=[zcode-v3-start-plan-1030-wk]
POST /billing/claim → { code:1001, msg:"target not found" }
```

返回 1001 而不是 401 / 3007，说明鉴权头、版本/平台头都被接受、验证码不是前置，
请求确实带着投放下发的 plan_id 走到了服务端的套餐查找 —— 旧代码在这个账号上根本没发出过这个请求。

仍未做（记录在案，不影响领取）：投放的 `POST /api/v1/marketing/touch/action` 回执（`confirm`）没有回发，
只影响投放侧统计。

## 7. 附录：本次只读采集的原始结论

`/tmp/zcap/preview-evidence.json`（本机临时产物，非仓库文件）摘要：

```json
[
  {"accountRef":"acct_91aa805b…","preview":{"http":200,"code":0,"hasData":false},
   "balance":{"http":200,"code":0,"hasData":true,
     "plans":[{"plan_id":"zcode-v3-start-plan-1030-wk","name":"ZCODE WEEKEND BUILD","status":"active"}],"balances":0}},
  {"accountRef":"acct_ae47a462…","preview":{"http":200,"code":0,"hasData":false},
   "balance":{"http":200,"code":0,"hasData":true,
     "plans":[{"plan_id":"zcode-v3-start-plan-1030-wk","name":"ZCODE WEEKEND BUILD","status":"active"}],"balances":0}},
  {"accountRef":"acct_9fe1dc…","preview":{"http":200,"code":0,"hasData":false},
   "balance":{"http":200,"code":0,"hasData":true,"plans":[],"balances":0}},
  {"accountRef":"acct_a09b9d…","preview":{"http":200,"code":0,"hasData":false},
   "balance":{"http":200,"code":0,"hasData":true,"plans":[],"balances":0}},
  {"accountRef":"acct_6738589e…","error":"jwt_missing（采集环境 HOME 被投影，见 §4 说明）"}
]
```

`/tmp/zcap/wire-claim.json`（同样本机临时产物）保存了 §3.1 两次请求的完整报文：
请求头清单（含 `hasCaptchaHeader: false`）、请求体、状态码与响应原文。
`/tmp/zcap/preview-matrix.json` 是 §4 那张「版本 × 平台」矩阵的原始结果。

抓包日志同理：`/tmp/zcap/cap10.out` 为桌面端主进程 hook 输出，`marketing-touch.query`
的 4 次超时记录见 §3；`/tmp/zcap/cap11.out` 是 §3.2 点击实录的 host 日志（第 1490 行起）；
`/tmp/zcap/logs/claim-proxy2.jsonl` 是 §3.2 那张「尝试表」最后一行（`ZCODE_BASE_URL` 改道）的原始记录。
它们都是临时文件，重跑桌面端后需重新采集。

## 8. 复核命令

```bash
A=/Users/model/Applications/ZCode.app/Contents/Resources/app.asar
for s in 'billing/claim' 'billing/preview' 'marketing/touch' 'claim_zcode_plan' 'remote/ws2'; do
  printf '%-22s %s\n' "$s" "$(LC_ALL=C grep -ac -- "$s" $A)"
done

dd if=$A bs=1 skip=312516834 count=2600 2>/dev/null | tr -d '\000'   # preview + claim 逐字实现
dd if=$A bs=1 skip=311265511 count=900  2>/dev/null | tr -d '\000'   # 投放按钮 schema

grep -an 'marketing-touch.query\|billing/balance' /tmp/zcap/cap10.out | head
node /tmp/zcap/collect-preview-evidence.js   # preview/balance 只读对照（需本机账号凭据）
node /tmp/zcap/wire-claim.js                 # §3.1 的 wire 复放（claim 用不存在的 plan_id，零状态变更）
node /tmp/zcap/preview-matrix.js             # §4 的版本 × 平台矩阵（只读 GET）
```

## 9. plan 族与「类型」分类（2026-10-31 补充）

「ZCODE WEEKEND BUILD」与「ZCode Start Plan」**不是两个接口或两种活动**，而是同一产品族
`zcode-v3-start-plan-*` 的**不同实例**：

| plan_id | name | 归属 |
|---|---|---|
| `zcode-v3-start-plan-1030-wk` | `ZCODE WEEKEND BUILD` | 周末活动（`-wk` 后缀） |
| `zcode-v3-start-plan-0817` | （早期试用套餐） | Start Plan 基线 |

判据只能落在 **plan_id** 上：服务端返回的字段只有 `plan_id / name / priority / status /
starts_at / ends_at / entitlements`，**没有 type**；而营销投放通道（§2.4）**只下发 plan_id、
没有 name**。所以分类规则写成 `planIdSuffix: '-wk'` 优先、`planIdPrefix:
'zcode-v3-start-plan'` 兜底，按声明顺序**首个命中**，一个 plan 只归一个类型 ——
否则前缀规则会把周末套餐也算进 Start Plan，「这次领的是哪一种」就失去意义。

规则是描述符数据（`lib/providers/defs/zcode.js` 的 `activity.actions[0].kinds`），求值器在
`lib/account/activity-claim/plans.js`；领取按 `params.planKind` 过滤候选，命中不到时返回
`status: nothing_claimable` + `reason: plan_kind_unavailable:<kind>` —— 这是**结论不是故障**，
定时任务不该因为活动换代而报警。

