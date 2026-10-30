'use strict';

// Kiro CLI 原生会话探测（每轮结束有显式的 usage_summary 记录）。
//
// 会话布局（2026-10 实测 kiro-cli 2.32，宿主共享、不按账号隔离）：
//   ~/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/session.json    { modelId, workspacePaths, createdAt }
//   ~/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/messages.jsonl  追加写，每行 { id, timestamp, payload }
//
// 回合边界：
//   * payload.type='usage_summary' 是**每轮结束时**追加的收尾记录 → 权威结束（decisive）；
//   * 其余行（assistant / tool_call / session_metadata）是回合内的产出 → 文件 mtime 很新
//     只证明「在跑」（positive），静默不判死（长工具调用可能不写行）。
//
// 归属：与用量采集共用注册表作用域（cwd + 会话开始时刻唯一命中）。

const path = require('path');
const {
  createKiroUsageOwnership,
  discoverKiroSessionFiles,
  readKiroSessionMeta
} = require('../../../usage/kiro-session-usage');

const PROBE_ID = 'kiro-session-store';
const INDEX_CACHE_KEY = 'kiro-session-index';
const TAIL_BYTES = 16 * 1024;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readSessionIndex(context) {
  if (context.cache) {
    const cached = context.cache.get(INDEX_CACHE_KEY);
    if (cached) return cached;
  }
  const { fs, hostHomeDir } = context;
  const records = [];
  if (hostHomeDir) {
    for (const messagesPath of discoverKiroSessionFiles({ fs, path, hostHomeDir })) {
      let stat = null;
      try {
        stat = fs.statSync(messagesPath);
      } catch (_error) {
        continue;
      }
      const meta = readKiroSessionMeta(fs, path, messagesPath);
      records.push({
        messagesPath,
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        startedAtMs: meta.startedAtMs,
        mtimeMs: Number(stat.mtimeMs) || 0
      });
    }
  }
  if (context.cache) context.cache.set(INDEX_CACHE_KEY, records);
  return records;
}

function resolveOwnership(context) {
  if (context.cache) {
    const cached = context.cache.get('kiro-ownership');
    if (cached) return cached;
  }
  const ownership = createKiroUsageOwnership({
    fs: context.fs,
    aiHomeDir: context.aiHomeDir
  });
  if (context.cache) context.cache.set('kiro-ownership', ownership);
  return ownership;
}

/** 读文件尾部最后一条可解析 JSON 行（最后一行可能只写了一半）。 */
function readLastJsonLine(fs, filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = Number(fs.fstatSync(fd).size) || 0;
    if (size <= 0) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // 从尾部往前找第一条完整 JSON；起点被截断的首行直接跳过。
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (index === 0 && start > 0) continue;
      try {
        return JSON.parse(line);
      } catch (_error) {
        continue;
      }
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_error) { /* best effort */ }
    }
  }
}

module.exports = {
  id: PROBE_ID,
  label: 'Kiro 会话流（usage_summary = 每轮结束）',
  priority: 20,
  claims: (harnessId) => harnessId === 'kiro',
  probe(context) {
    if (!context.hostHomeDir || !context.accountRef) return null;
    const ownership = resolveOwnership(context);
    const owned = readSessionIndex(context)
      .filter((record) => {
        const resolved = ownership.resolve({
          cwd: record.cwd,
          startedAtMs: record.startedAtMs
        });
        return normalizeText(resolved && resolved.accountRef) === context.accountRef;
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const record = owned[0];
    if (!record) return null;

    const last = readLastJsonLine(context.fs, record.messagesPath);
    const lastPayload = last && last.payload && typeof last.payload === 'object' ? last.payload : null;
    if (lastPayload && normalizeText(lastPayload.type).toLowerCase() === 'usage_summary') {
      return {
        turn: false,
        authority: 'turn',
        decisive: true,
        lastActivityAt: toTimestampMs(last.timestamp) || record.mtimeMs,
        source: PROBE_ID,
        detail: { sessionId: record.sessionId, status: normalizeText(lastPayload.status) }
      };
    }

    const active = record.mtimeMs > 0 && context.nowMs - record.mtimeMs <= context.turnActiveWindowMs;
    return {
      turn: active,
      authority: active ? 'positive' : 'none',
      decisive: false,
      lastActivityAt: record.mtimeMs,
      source: PROBE_ID,
      detail: { sessionId: record.sessionId, status: '' }
    };
  }
};
