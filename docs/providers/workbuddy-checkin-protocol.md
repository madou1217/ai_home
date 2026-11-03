# WorkBuddy 每日签到协议（2026-11-01 app.asar 逆向 + 真机验证）

> 结论先行：**签到只有两条接口**（读状态 / 领一次），桌面端用 `/v2` 前缀、云端仓用无前缀，
> 网关两者都收；**不需要** Turing 风控 token 也能领到；业务码 1001 = 今天已领过（不是失败）。
> 实现：`lib/account/activity-claim/workbuddy-daily.js`，能力声明在
> `lib/providers/defs/_shared/workbuddy-checkin.js`。

## 1. 接口清单

| 用途 | 方法 / 路径 | 桌面端实现 | 说明 |
|---|---|---|---|
| 活动状态（读） | `POST {base}/v2/billing/meter/checkin-activity-status`，body `{}` | `AuthService.getCheckinStatus` / `CloudAccountRepo.checkinStatus` | 同时回答「活动在不在」「今天领没领」「能领多少」 |
| 领取（写） | `POST {base}/v2/billing/meter/daily-checkin`，body `{}` | `AuthService.claimDailyCheckin` / `CloudAccountRepo.checkin` | 一天一次，幂等（重复 → 1001） |
| 旧状态接口 | `POST {billingPrefix}/billing/meter/checkin-status` | `BackendProvider.getCheckinStatus` | 返回 `daily_credit: 0`（活动口径），已由 activity-status 取代 |

`base` 与家族其它接口同源（`lib/account/codebuddy-billing.js`）：
`www.workbuddy.ai`（国际站）/ `copilot.tencent.com`（国内站）。

**前缀分叉**（两个仓库类的 `billingPrefix`）：`CloudAccountRepo` 是 `''`、`DesktopAccountRepo`
是 `'/v2'`。实测（2026-11-01，两个站点各打一遍）**两种前缀都返回 200**，因此按桌面端取 `/v2`。

## 2. 桌面端实现（app.asar 逐字切片，v1.0.0，181,957,326 B）

字节偏移可直接复核：`dd if=app.asar bs=1 skip=<offset> count=<n>`。

### 2.1 请求头（决定 401/403 的部分）

```js
// @4152859  AuthService.buildHeadersWithTuringToken
async buildHeadersWithTuringToken(e) {
  let t = this.buildHeaders(e),
      n = await this.getTuringDeviceTokenResult();
  return n.token ? t[wo] = n.token : n.error && (t[To] = n.error), t;
}
buildHeaders(e) {
  let { auth: t, account: n } = e,
      r = { Accept:'application/json', Authorization:`Bearer ${t.accessToken}`,
            'Content-Type':'application/json', 'X-User-Id': n.uid ?? '' };
  n.enterpriseId && (r['X-Enterprise-Id'] = n.enterpriseId, r['X-Tenant-Id'] = n.enterpriseId);
  t.domain && (r['X-Domain'] = t.domain);
  return r;
}
```

* `wo` = `X-Device-Token`、`To` = `X-Device-Token-Error`（Turing 风控 SDK 的设备令牌）。
  **实测不带也能领**：2026-11-01 用只有 Bearer + X-User-Id + X-Domain + UA 的请求领到 100 Credits。
  因此 aih 不实现 Turing SDK —— 拿不到设备令牌时硬造一个只会把请求弄脏。
* `X-Enterprise-Id` / `X-Tenant-Id` 只在企业账号出现；aih 从凭据文件的
  `account.enterpriseId` 透传（本机两个账号都是 personal，该分支未在真机命中）。
* **User-Agent 必须像真实客户端**：国内站网关对脚本 UA 返回 403
  `{"code":10085,"msg":"请求不合法"}`（与余额接口同一个 WAF）。实测
  `CodeBuddy/1.0 (ai-home)` / `WorkBuddy/1.0.0` / 完整桌面 UA 三种都是 200。

### 2.2 判读：状态与领取

```js
// @2983394  DesktopAccountRepo.getCheckinRequestHeaders
async getCheckinRequestHeaders() {
  let e = await this.providers.getTuringDeviceTokenResult?.();
  if (e?.token) return { 'X-Device-Token': e.token };
  if (e?.error) return { 'X-Device-Token-Error': e.error };
}
// @2983515  CloudAccountRepo.postCheckin —— body 恒为 {}
async postCheckin(e) { let t = await this.getCheckinRequestHeaders();
  return t ? this.deps.context.http.post(e, {}, { headers: t }) : this.deps.context.http.post(e, {}); }

// @2988987  CloudAccountRepo.checkinStatus → 蛇形字段原样搬成驼峰
// @2989038  CloudAccountRepo.checkin → code !== 0 时按 mapCheckinStatus 归类

// @4150019  AuthService.claimDailyCheckin —— 成功时取 **信封里的 data**
let t = await this.http.post(`${n}/v2/billing/meter/daily-checkin`, {}, { headers: await this.buildHeadersWithTuringToken(e) });
return t.status === 200 && t.data?.code === 0 && t.data.data ? t.data.data : { code: t.data?.code ?? -1, ... };

// @2982442  业务码
function mapCheckinStatus(e) {
  switch (e) {
    case 1001: return m.AlreadyClaimed;
    case 1002: return m.NotEligible;
    case 1003: return m.EventEnded;
    default:   return m.UnknownBizError;
  }
}
```

⚠️ `CloudAccountRepo.checkin()` 读的是 `e.credit`（信封顶层），而成功响应把 `credit` 放在
`e.data` 里 —— 那是桌面端自己的 bug，UI 上会显示 +0。aih 以 `data` 为准。

## 3. 真机响应（2026-11-01，脱敏）

```jsonc
// checkin-activity-status（国内站，活动进行中）
{ "code": 0, "msg": "OK", "data": {
  "active": true, "today_checked_in": false, "streak_days": 5, "daily_credit": 100,
  "today_credit": 100, "is_streak_day": false, "total_credits": 500,
  "checkin_dates": ["2026-10-31","2026-10-29","2026-10-08","2026-10-07","2026-10-06"],
  "week_checkin_days": 2, "week_progress": [false,false,false,true,false,true,false],
  "start_time": "2026-09-30 00:00:00", "end_time": "2026-12-31 23:59:59",
  "theme_name": "Buddy加油站", "season": 10, "activity_name": "Buddy应用",
  "claim_button_text": "立即领取",
  "action_button": { "show": true, "text": "体验Buddy应用", "action": "workbuddy://home?openBuddySwitcher=true" }
} }
// 国际站同一接口：active=false，daily_credit=0（该账号没有开放活动）
```

领取后复检：`today_checked_in=true`、`streak_days 5→6`、`total_credits 500→600`、
`checkin_dates` 多出当天 —— 证明 `data.credit` 就是本次到账积分。

## 4. aih 的实现与安全边界

* **先读后写**：任何一次领取前都先打 `checkin-activity-status`；`active=false` → `nothing_claimable`，
  `today_checked_in=true` → `already_claimed`，两种情况**都不发领取请求**（领取消耗当天唯一机会）。
* **幂等**：业务码 1001 映射成 `already_claimed`（正常结束），定时任务一天跑多次不会把任务染红。
* **fail-closed**：凭据缺失 / 401 / 未知业务码都是 `error` + 机器码，不猜结论。
* **出口一致**：与额度探针共用 `resolveClaimEgressOptions`，账号绑了代理就走代理，绝不静默直连。
* 只读探测（WebUI 的「探测」按钮）复用同一个 handler 的 `dryRun` 分支，不发写请求。

## 5. 复现

```bash
aih claim codebuddycn workbuddycn --dry-run    # 只读：活动在不在、今天领没领
aih claim codebuddycn --account <acct_ref>     # 真领（一天一次，幂等）
```

定时：计划任务事件 `activity:<provider>:daily_checkin`（`schedulable: true`，防抖 1 小时）。

## 6. 挂载面：只有 CN 站；codebuddycn 账号直接可用（2026-11-01 实测）

对 13 个家族账号逐个打 `POST /v2/billing/meter/checkin-activity-status`（只读）：

| 站点 | provider | 账号数 | `active` | 结论 |
|---|---|---|---|---|
| www.codebuddy.ai | `codebuddy` | 6 | 全 `false` | 国际站**没有**签到活动 |
| www.workbuddy.ai | `workbuddy` | 2 | 全 `false` | 同上 |
| www.codebuddy.cn | `codebuddycn` | 4 | 全 `true` | 可领 |
| www.workbuddy.cn | `workbuddycn` | 1 | `true` | 可领 |

→ 描述符只给 **CN 两支**挂 `activity`；国际站挂上去只会得到一个永远「暂无可领」的菜单。

**codebuddycn 的账号能直接用这套接口**：签到在 `copilot.tencent.com` 上按 **uid** 记账，
而 CN 站的 CodeBuddy 与 WorkBuddy 是同一个账号（同 uid、共用 `workbuddy-desktop.info`
这一份凭据，见 `codebuddy-family-credential-model.md` §2）。实测：

```
codebuddycn acct_9dc0…（uid e3f89e5f…） → active:true, today_checked_in:true,  streak:6, total:600
workbuddycn acct_cfa2…（uid e3f89e5f…） → active:true, today_checked_in:true,  streak:6, total:600   ← 同一份账
codebuddycn acct_0764…（uid 23ddaff9…） → active:true, today_checked_in:false, streak:0, total:0
codebuddycn acct_0ccf…（uid 393b0689…） → active:true, today_checked_in:false, streak:0, total:0
codebuddycn acct_a356…（uid 1fd6693b…） → active:true, today_checked_in:false, streak:0, total:0
```

注意同一 uid 在 `codebuddycn` / `workbuddycn` 各有一条账号记录时，两边点的是**同一份**
每日奖励：先点的领到，后点的得到「今天已经签到过了」（1001），不会重复发币。
