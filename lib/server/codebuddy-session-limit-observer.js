'use strict';

// CodeBuddy 家族原生会话里的 429 恢复时刻 → 账号 (账号, 模型) 冷却。
//
// 为什么需要：`aih codebuddy <id>` 的会话直连上游、不经网关，网关的失败分类从来看不到它。
// 跑一段时间后上游回「429 usage exceeds frequency limit … your usage will reset at
// 2026-10-31 14:57:00 UTC+8」（业务码 6004），CLI 把它原样写进会话 jsonl 的 assistant 消息
// （providerData.error.status=429）。这里增量读这些文件，把恢复时刻交给统一分类器 → 门禁：
// 网关后续选号会避开该 (账号, 模型) 直到恢复时刻，账号页也能看到冷却到期时间。
//
// 口径：
//   * 只认 providerData.error.status===429 且正文带「reset at」且该时刻还没过 —— 历史里的旧报错
//     不会给账号加冷却；
//   * 模型取同一文件里该报错之前最近一条带 providerData.model 的记录；拿不到模型就不记
//     （没有模型时门禁会退回账号级冷却，范围过大，宁可不记）；
//   * 归属复用用量扫描的 codebuddy 归属（原生 user_id ↔ 账号凭据 uid、写入日志），归属不唯一
//     就不记；
//   * 冷却取 max 写入，重复观察同一条报错是幂等的，因此偏移只放内存，重启后从头再读一遍。

const nodePath = require('node:path');
const { discoverCodebuddyUsageFiles } = require('../usage/codebuddy-model-usage-scanner');
const { createCodebuddyUsageOwnership } = require('../usage/codebuddy-usage-ownership');
const { __private: scannerPrivate } = require('../usage/model-usage-scanner');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../sessions/session-reader-codebuddy');
const { parseResetAtTimestampMs } = require('./retry-hints');

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const MIN_POLL_INTERVAL_MS = 15 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function timestampMs(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/** 一行 jsonl → 429 观察 / 模型线索 / null。 */
function readSessionLimitLine(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const data = entry.providerData && typeof entry.providerData === 'object' ? entry.providerData : {};
  const model = normalizeText(data.model);
  const error = data.error && typeof data.error === 'object' ? data.error : null;
  if (!error || Number(error.status) !== 429) return model ? { model } : null;
  const message = normalizeText(error.message);
  const resetAtMs = parseResetAtTimestampMs(message);
  if (!resetAtMs) return null;
  return {
    limit: {
      id: normalizeText(entry.id),
      message,
      code: error.code,
      resetAtMs,
      atMs: timestampMs(entry.timestamp)
    }
  };
}

function createCodebuddySessionLimitObserver(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || nodePath;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const hostHomeDir = normalizeText(options.hostHomeDir);
  const state = options.state || null;
  const gate = options.accountRuntimeGate || null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const readJsonlFromOffset = options.readJsonlFromOffset || scannerPrivate.readJsonlFromOffset;
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const enabled = Boolean(aiHomeDir && hostHomeDir && state && gate && typeof gate.observeFailure === 'function');
  // 归属模块按 store 对象缓存写入日志；给它一个稳定的键即可。
  const ownershipCacheKey = {};
  const files = new Map(); // filePath → { offset, model }
  let timer = null;

  function findPoolAccount(provider, accountRef) {
    const list = state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
    return list.find((account) => normalizeText(account && account.accountRef) === accountRef) || null;
  }

  function tick() {
    const summary = { files: 0, observed: 0, applied: 0, unattributed: 0 };
    if (!enabled) return summary;
    const pending = [];
    const discovered = discoverCodebuddyUsageFiles({
      fs: fsImpl, path: pathImpl, hostHomeDir, providers: CODEBUDDY_FAMILY_PROVIDERS
    });
    for (const file of discovered) {
      let size = 0;
      try { size = fsImpl.statSync(file.filePath).size; } catch (_error) { continue; }
      const cursor = files.get(file.filePath) || { offset: 0, model: '' };
      if (size < cursor.offset) { cursor.offset = 0; cursor.model = ''; }
      if (size === cursor.offset) { files.set(file.filePath, cursor); continue; }
      summary.files += 1;
      const read = readJsonlFromOffset(fsImpl, file.filePath, cursor.offset, (line) => {
        let entry;
        try { entry = JSON.parse(line); } catch (_error) { return; }
        const parsed = readSessionLimitLine(entry);
        if (!parsed) return;
        if (parsed.model) { cursor.model = parsed.model; return; }
        summary.observed += 1;
        // 已过恢复时刻的旧报错没有冷却意义（常见于首轮从头读历史）。
        if (parsed.limit.resetAtMs <= now() || !cursor.model) return;
        pending.push({ file, model: cursor.model, ...parsed.limit });
      });
      cursor.offset = read.hadTrailingLine ? read.trailingLineStart : read.offset;
      files.set(file.filePath, cursor);
    }
    if (!pending.length) return summary;

    const ownership = createCodebuddyUsageOwnership({
      fs: fsImpl, path: pathImpl, store: ownershipCacheKey, aiHomeDir, readJsonlFromOffset
    });
    for (const item of pending) {
      const owner = ownership.resolve(item.file, item.atMs, null, null, item.id);
      const accountRef = normalizeText(owner && owner.accountRef);
      const provider = normalizeText(owner && owner.provider) || item.file.provider;
      const account = accountRef ? findPoolAccount(provider, accountRef) : null;
      if (!account) { summary.unattributed += 1; continue; }
      const result = gate.observeFailure({
        account,
        provider,
        model: item.model,
        statusCode: 429,
        detail: item.message,
        body: { error: { code: item.code, message: item.message } },
        source: 'codebuddy.session.limit',
        nowMs: now()
      });
      if (result && result.applied) summary.applied += 1;
    }
    return summary;
  }

  function start() {
    if (timer || !enabled) return false;
    try { tick(); } catch (_error) { /* 首轮失败不阻止定时器启动 */ }
    timer = setInterval(() => {
      try { tick(); } catch (_error) { /* 只影响冷却提示，下一轮重试 */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { start, stop, tick };
}

module.exports = {
  createCodebuddySessionLimitObserver,
  readSessionLimitLine
};
