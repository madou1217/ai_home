'use strict';

// 活动动作的**倒排索引**（provider 描述符 → 动作清单）。
//
// 单独成文件是为了打断循环依赖：执行器（index.js）与参数选项解析（options.js）
// 都要查「这个 provider 有哪些动作」，而选项解析又被执行器复用。把只依赖
// `lib/providers` 的纯查询放在这里，两个消费者都向下依赖它。
//
// 这里没有 provider 名单：能查到什么完全由描述符的 `activity` 能力决定。

const { getProviderCapability, listProviders } = require('../../providers');
const { describeActivityParams } = require('./params');

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function readActivityCapability(provider) {
  const capability = getProviderCapability(normalizeText(provider).toLowerCase(), 'activity');
  if (!capability || capability.supported !== true) return null;
  return capability;
}

/** 倒排索引：声明了 activity 能力（且 supported）的 provider。 */
function listActivityProviders() {
  return listProviders('activity').filter((provider) => Boolean(readActivityCapability(provider)));
}

/**
 * 给 UI / CLI 展示的动作清单（不含 handler —— 那是宿主实现细节）。
 *
 * `includeParams` 默认 false：账号快照会为每个账号下发一份动作清单，把参数 schema
 * 也塞进去纯属重复；只有计划任务目录（一个 provider 一份）才需要。
 */
function listActivityActions(provider, options = {}) {
  const capability = readActivityCapability(provider);
  if (!capability) return [];
  const includeParams = options.includeParams === true;
  return capability.actions.map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description || '',
    // 是否**对外提供定时调度**（计划任务菜单据此列出可选事件）+ 该动作的防抖窗口。
    // 声明来自 provider 描述符（见 lib/providers/contract.js），这里只透传、不判断。
    schedulable: action.schedulable === true,
    ...(Number(action.scheduleDebounceMs) > 0 ? { scheduleDebounceMs: Number(action.scheduleDebounceMs) } : {}),
    ...(action.supportsProbe === true ? { supportsProbe: true } : {}),
    ...(includeParams ? { params: describeActivityParams(action) } : {})
  }));
}

function getActivityAction(provider, actionId) {
  const capability = readActivityCapability(provider);
  if (!capability) return null;
  const wanted = normalizeText(actionId).toLowerCase();
  if (!wanted) return capability.actions[0] || null;
  return capability.actions.find((action) => action.id === wanted) || null;
}

module.exports = {
  readActivityCapability,
  listActivityProviders,
  listActivityActions,
  getActivityAction
};
