'use strict';

// kiro 每轮结果 → 账号结果桶（健康统计）。`aih kiro <id>` 直连 AWS、不经网关，因此 Go / Node
// 的 attempt 记账都看不到它；kiro-cli 每轮在 messages.jsonl 写一条 usage_summary
// （status=success/…，2026-10-19 实测 2.32），这是该账号唯一可观测的结果证据。
//
// 口径（与 Go FailureKind 闭集对齐）：success → success；error/failed → unclassified；
// 其它（取消、未知）不记。归属：事件时间点落在唯一的注册表作用域内才归属（同用量扫描）。
// 增量：每个文件记住已读字节偏移（进程内），重启后从头读一遍，靠游标去重。

const nodePath = require('node:path');
const { createNativeSessionOutcomePoller } = require('./native-session-outcome-poller');
const {
  createKiroSessionLineParser,
  createKiroUsageOwnership,
  discoverKiroSessionFiles,
  readKiroSessionMeta
} = require('../usage/kiro-session-usage');
const { __private: scannerPrivate } = require('../usage/model-usage-scanner');

const STORE_KEY = 'kiro-session-outcomes';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function createKiroTurnCollector(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || nodePath;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const hostHomeDir = normalizeText(options.hostHomeDir);
  const readJsonlFromOffset = options.readJsonlFromOffset || scannerPrivate.readJsonlFromOffset;
  const offsets = new Map();

  return function collect() {
    if (!aiHomeDir || !hostHomeDir) return [];
    const ownership = createKiroUsageOwnership({ fs: fsImpl, aiHomeDir, registry: options.registry });
    const observations = [];
    for (const filePath of discoverKiroSessionFiles({ fs: fsImpl, path: pathImpl, hostHomeDir })) {
      let size = 0;
      try {
        size = fsImpl.statSync(filePath).size;
      } catch (_error) {
        continue;
      }
      const from = offsets.get(filePath) || 0;
      if (from >= size) continue;
      const meta = readKiroSessionMeta(fsImpl, pathImpl, filePath);
      const parser = createKiroSessionLineParser({ model: meta.model });
      const fileObservations = [];
      const read = readJsonlFromOffset(fsImpl, filePath, from, (line, lineOffset) => {
        const event = parser.parse(line, lineOffset);
        if (!event || event.kind !== 'turn') return;
        fileObservations.push({
          key: event.eventKey,
          marker: event.status || '1',
          outcome: event.outcome,
          atMs: event.timestampMs,
          accountRef: event.outcome
            ? normalizeText(ownership.resolve({ sessionId: meta.sessionId, cwd: meta.cwd, atMs: event.timestampMs }).accountRef)
            : ''
        });
      });
      observations.push(...fileObservations);
      // 有未归属的观察时不推进偏移：下一轮重读，等归属可判定（模板也不推进游标）。
      const blocked = fileObservations.some((item) => item.outcome && !item.accountRef);
      if (!blocked) offsets.set(filePath, read.hadTrailingLine ? read.trailingLineStart : read.offset);
    }
    return observations;
  };
}

function createKiroSessionOutcomePoller(options = {}) {
  return createNativeSessionOutcomePoller({
    fs: options.fs,
    aiHomeDir: options.aiHomeDir,
    nodeAccountOutcomes: options.nodeAccountOutcomes,
    intervalMs: options.intervalMs,
    storeKey: normalizeText(options.storeKey) || STORE_KEY,
    readJsonValue: options.readJsonValue,
    writeJsonValue: options.writeJsonValue,
    collect: createKiroTurnCollector(options)
  });
}

module.exports = {
  createKiroSessionOutcomePoller,
  createKiroTurnCollector
};
