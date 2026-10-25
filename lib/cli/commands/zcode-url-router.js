'use strict';

// `aih zcode-url <url>` —— URL 协议处理器的入口，**转发兜底**的实现。
//
// macOS 在浏览器跳转 `zcode://…` 时调用 aih 的协议处理器 app，把 URL 作为参数
// 传进来。本命令判定这个回调属于谁：
//
//   * **aih 自己的登录任务**（state 与某个在途 job 的 oauthState 匹配）
//     → 交给 aih 的登录流程收尾（写凭据、注册账号）。
//   * **其它**（桌面端发起的授权，或 state 对不上）
//     → 原样 `open -b dev.zcode.app <url>` 转交给 ZCode Desktop。
//
// 这个兜底是「aih 接管 zcode: 协议」这一方案能成立的前提：没有它，接管会把
// 桌面端的回调抢走、弄坏桌面端登录。
//
// 与在途任务的匹配通过 aih server 的 HTTP 接口完成（server 是任务的唯一持有者；
// 协议处理器是**独立短命进程**，不共享内存）。server 不可达时一律转发给桌面端 ——
// 宁可让桌面端处理，也不吞掉用户的授权。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');
const { forwardToZcodeDesktop, ZCODE_URL_SCHEME } = require('../../runtime/url-scheme-handler');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从 zcode:// URL 里取 state（判定归属的唯一依据）。 */
function readStateFromUrl(url) {
  try {
    return normalizeString(new URL(String(url || '')).searchParams.get('state'));
  } catch (_error) {
    return '';
  }
}

/**
 * 问 aih server：这个 state 是不是某个在途登录任务的？
 * 是则把回调交给该任务（server 侧完成 token 交换与账号注册）。
 *
 * @returns {Promise<'handled'|'not_mine'|'server_unavailable'>}
 */
async function deliverToAuthJob(options = {}) {
  const request = options.request;
  const url = normalizeString(options.url);
  const state = readStateFromUrl(url);
  if (!request || !state) return 'not_mine';
  const base = normalizeString(options.serverBaseUrl);
  if (!base) return 'server_unavailable';
  const managementKey = normalizeString(options.managementKey);
  try {
    const response = await request(`${base}/v0/webui/accounts/zcode/url-callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(managementKey ? { authorization: `Bearer ${managementKey}` } : {})
      },
      body: JSON.stringify({ url, state })
    });
    if (!response || response.ok === false) {
      // 404 = server 在跑但没有匹配的任务 → 不是我们的；其它错误按不可达处理。
      return Number(response && response.status) === 404 ? 'not_mine' : 'server_unavailable';
    }
    const payload = await response.json().catch(() => null);
    return payload && payload.handled ? 'handled' : 'not_mine';
  } catch (_error) {
    return 'server_unavailable';
  }
}

/**
 * 处理一次 URL 回调。
 * @returns {Promise<{action: string, state: string}>}
 */
async function handleZcodeUrl(url, deps = {}) {
  const target = normalizeString(url);
  const state = readStateFromUrl(target);
  if (!target || !target.toLowerCase().startsWith(`${ZCODE_URL_SCHEME}://`)) {
    return { action: 'ignored_not_zcode_url', state: '' };
  }
  const delivered = await deliverToAuthJob({
    url: target,
    request: deps.request,
    serverBaseUrl: deps.serverBaseUrl,
    managementKey: deps.managementKey
  });
  if (delivered === 'handled') return { action: 'handled_by_aih', state };
  // 不是 aih 的任务（或 server 不可达）：转发给桌面端，绝不吞掉授权。
  const forwarded = forwardToZcodeDesktop(target, { open: deps.open });
  return { action: forwarded ? 'forwarded_to_desktop' : 'forward_failed', state };
}

function runZcodeUrlCommand(args = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const url = normalizeString(args[0]);
  if (!url) {
    consoleImpl.error('[aih] 用法: aih zcode-url <zcode://...>');
    return 1;
  }
  // 协议处理器是短命进程：拿到结果前不能让事件循环空转（进程会被系统回收）。
  return handleZcodeUrl(url, deps)
    .then((result) => {
      if (result.action === 'handled_by_aih') {
        consoleImpl.log(`  ✅ 已交给 aih 登录任务处理（state=${result.state.slice(0, 12)}…）`);
      } else if (result.action === 'forwarded_to_desktop') {
        consoleImpl.log('  → 非 aih 的授权，已转发给 ZCode Desktop');
      } else if (result.action === 'forward_failed') {
        consoleImpl.error('[aih] 转发给 ZCode Desktop 失败（它可能未安装）');
      }
      return 0;
    })
    .catch((error) => {
      consoleImpl.error(`[aih] 处理回调失败: ${(error && error.message) || error}`);
      return 1;
    });
}

module.exports = {
  readStateFromUrl,
  deliverToAuthJob,
  handleZcodeUrl,
  runZcodeUrlCommand
};
