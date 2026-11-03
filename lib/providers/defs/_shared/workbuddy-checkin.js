'use strict';

// CN 站（workbuddycn / codebuddycn）的账号活动声明：每日签到「Buddy应用」
// （描述符数据，实现见 lib/account/activity-claim/workbuddy-daily.js）。
//
// 为什么单独成文件、为什么只有这两支：
//   * 签到是 **CN 站独有**的。2026-11-01 实测国际站两支（www.workbuddy.ai /
//     www.codebuddy.ai）的 checkin-activity-status 恒返回 active:false，
//     挂上去只会得到一个永远「暂无可领」的死菜单。
//   * 接口虽然叫 WorkBuddy，但它在 copilot.tencent.com 上按 **uid** 记账，而 CN 站的
//     CodeBuddy 与 WorkBuddy 是同一个账号（同 uid、共用 workbuddy-desktop.info 凭据），
//     所以 codebuddycn 的账号用同一套请求就能领（实测 200 + active:true）。
//   * 同一 uid 若同时存在 codebuddycn / workbuddycn 两条账号记录，两边点签到的都是
//     **同一份**每日奖励：先点的领到，后点的得到「今天已经签到过了」。
//
// 签到一天一次：定时任务每小时最多触发一次，重复触发只执行一次。
module.exports = {
  supported: true,
  actions: [
    {
      id: 'daily_checkin',
      label: '签到',
      handler: 'workbuddy-daily-checkin',
      description: '每天领取一次积分（桌面端「立即领取」）',
      schedulable: true,
      scheduleDebounceMs: 60 * 60 * 1000,
      // 只读探测：先看清「活动开没开、今天领没领」，再决定领不领。
      // 复用 handler 的 dryRun 分支，不新增第二个 handler。
      supportsProbe: true,
      // 参数与 zcode 的「领臭鸡蛋」同形：空数组 = 全部账号（老任务不用迁移）。
      // 主要用途是同一 uid 同时存在于 codebuddycn / workbuddycn 两条账号记录时，
      // 只让其中一条去领，避免第二条记一次「今天已经签到过了」。
      params: [
        {
          key: 'accountRefs',
          label: '账号',
          type: 'account-refs',
          description: '留空 = 该 provider 的全部账号',
          emptyMeans: 'all',
          maxItems: 200
        }
      ]
    }
  ]
};
