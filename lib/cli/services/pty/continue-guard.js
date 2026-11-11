'use strict';

// 自动继续（往新 PTY 里写一条 `continue`）之前的**落点校验**。
//
// 背景（2026-11-11 用户实测）：换号后即使续接只是 provider 的「最近一段」兜底
// （`--continue` / codex 的 `--last`），甚至目标会话文件根本不存在，运行时也会
// 照样写 `continue`。用户看到的是**新会话里空跑一轮**：模型对着一段空上下文开始
// 干活，既浪费额度，也让人以为会话没接上。
//
// 闸门只回答一件事：这一次 `continue` 有没有可验证的落点。
//   1. 续接必须是**精确**的——拿到了具体 session id，而不是「同 cwd 最近一段」；
//   2. 该 session id 对应的会话文件必须真实存在且非空。
// 两条都成立才放行。任何一条不成立都**不写** `continue`：新会话照常打开（用户手
// 上的上下文还在），由调用方打印一条明确提示，让用户自己决定要不要重发。
//
// 纯函数 + 依赖注入：会话文件定位由调用方给（provider 各不相同），测试用假实现。

const nodeFs = require('node:fs');

// 拒绝原因 → 给用户看的一句话。措辞只描述事实，不猜「上游可能怎样」。
const REASON_MESSAGES = Object.freeze({
  no_continuation: '没有可用的续接参数',
  continuation_unavailable: '这个 provider 没有可用的续接入口',
  inexact_continuation: '只能续「最近一段」，无法确认就是同一段对话',
  missing_session_id: '续接参数里没有会话 id',
  explicit_without_session_id: '显式续接参数里没有会话 id',
  session_file_not_found: '找不到对应的会话文件',
  session_file_empty: '会话文件还是空的',
  session_file_unreadable: '会话文件读不出来'
});

function readText(value) {
  return String(value == null ? '' : value).trim();
}

function reject(reason, extra = {}) {
  return {
    ok: false,
    reason,
    message: REASON_MESSAGES[reason] || '续接目标无法验证',
    sessionId: '',
    filePath: '',
    ...extra
  };
}

/**
 * @param {object} options
 * @param {string} options.provider           目标 provider
 * @param {object|null} options.continuation  planAccountSwitch 的续接计划（含 ok/exact/sessionId/message）
 * @param {boolean} options.keepExplicit       用户自己写了续接参数（原样保留）
 * @param {string} options.explicitSessionId  显式续接参数里的会话 id（没有就是空）
 * @param {Function} options.resolveSessionFilePath (provider, { sessionId }, options) => 文件路径
 * @param {object} [options.resolveOptions]   传给定位函数的上下文（hostHomeDir / aiHomeDir）
 * @param {object} [options.fs]               便于测试注入
 * @returns {{ok: boolean, reason: string, message: string, sessionId: string, filePath: string}}
 */
function inspectContinueTarget(options = {}) {
  const provider = readText(options.provider).toLowerCase();
  const keepExplicit = options.keepExplicit === true;
  const continuation = options.continuation && typeof options.continuation === 'object'
    ? options.continuation
    : null;

  let sessionId = '';
  if (keepExplicit) {
    // 显式续接：用户自己写的 `--resume <id>` 可信；只写 `--continue` 时没有落点。
    sessionId = readText(options.explicitSessionId);
    if (!sessionId) return reject('explicit_without_session_id');
  } else {
    if (!continuation) return reject('no_continuation');
    if (continuation.ok !== true) {
      return reject('continuation_unavailable', {
        message: readText(continuation.message) || REASON_MESSAGES.continuation_unavailable
      });
    }
    // 「同 cwd 最近一段」不是同一段对话：换号后它可能续到别的会话上。
    if (continuation.exact !== true) return reject('inexact_continuation');
    sessionId = readText(continuation.sessionId);
    if (!sessionId) return reject('missing_session_id');
  }

  const resolveSessionFilePath = typeof options.resolveSessionFilePath === 'function'
    ? options.resolveSessionFilePath
    : () => '';
  let filePath = '';
  try {
    filePath = readText(resolveSessionFilePath(provider, { sessionId }, options.resolveOptions || {}));
  } catch (_error) {
    filePath = '';
  }
  if (!filePath) return reject('session_file_not_found', { sessionId });

  const fs = options.fs || nodeFs;
  let size = 0;
  try {
    const stat = fs.statSync(filePath);
    const isFile = typeof stat.isFile === 'function' ? stat.isFile() : true;
    if (!isFile) return reject('session_file_not_found', { sessionId, filePath });
    size = Number(stat.size) || 0;
  } catch (error) {
    // 文件不在和「文件在但读不出来」对用户是两件事：前者是续接目标没了，
    // 后者是会话库权限/损坏。提示要能区分，排障时才知道往哪看。
    const code = error && error.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return reject('session_file_not_found', { sessionId, filePath });
    }
    return reject('session_file_unreadable', { sessionId, filePath });
  }
  if (!(size > 0)) return reject('session_file_empty', { sessionId, filePath });

  return { ok: true, reason: 'verified', message: '', sessionId, filePath };
}

module.exports = {
  REASON_MESSAGES,
  inspectContinueTarget
};
