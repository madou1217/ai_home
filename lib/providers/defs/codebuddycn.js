'use strict';

// codebuddycn 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：CodeBuddy 家族共享探针（HTTP + 桌面端凭据兼容）。
//
// 账号活动：每日签到。CN 站的两支是**同一个账号**（同 uid，共用
// workbuddy-desktop.info 这一份凭据），签到接口在 copilot.tencent.com 上按 uid 记账，
// 所以 codebuddycn 的账号直接用 WorkBuddy 的签到接口就能领（2026-11-01 实测 200）。
const createCodebuddyFamilyDescriptor = require('./_shared/codebuddy-family');
const workbuddyCheckin = require('./_shared/workbuddy-checkin');

module.exports = createCodebuddyFamilyDescriptor('codebuddycn', { activity: workbuddyCheckin });
