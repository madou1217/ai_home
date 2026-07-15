'use strict';

// webUI native run 的磁盘清单（tmux 化 run 的收养依据）。
//
// 每个 run 一个 JSON（<aiHomeDir>/run/webui-runs/<runId>.json）+ 一个输出日志
// （<aiHomeDir>/logs/webui-runs/<runId>.log）。server 重启后据清单收养仍在 tmux 里跑的 run：重新注册进
// run registry（/chat/runs 可见、可 abort/回写输入），tail 日志到完成再走统一收尾。
// 只存寻址元数据（provider/account/sessionId/tmux socket/日志路径），绝不存凭据——
// 与 lib/runtime/persistent-session-registry.js（CLI 会话的重启存活）同一模式，但
// 独立目录：CLI restore 引擎会按它自己的语义重建会话，webUI run 混进去会被错误恢复。

const nodeFs = require('node:fs');
const path = require('node:path');
const { isAccountRef } = require('../account/public-account-ref');
const { resolveAihLogPath, resolveAihRunPath } = require('../runtime/aih-storage-layout');

function manifestDir(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  if (!root) return '';
  return resolveAihRunPath(root, 'webui-runs');
}

function isSafeRunId(runId) {
  return /^[A-Za-z0-9-]{6,80}$/.test(String(runId || ''));
}

function manifestPath(aiHomeDir, runId) {
  const dir = manifestDir(aiHomeDir);
  if (!dir || !isSafeRunId(runId)) return '';
  return path.join(dir, `${runId}.json`);
}

function runLogPath(aiHomeDir, runId) {
  return isSafeRunId(runId)
    ? resolveAihLogPath(aiHomeDir, 'webui-runs', `${runId}.log`)
    : '';
}

function normalizeManifest(raw = {}) {
  const gateway = raw.gateway === true;
  return {
    runId: String(raw.runId || '').trim(),
    provider: String(raw.provider || '').trim().toLowerCase(),
    ...(gateway
      ? { gateway: true }
      : { accountRef: String(raw.accountRef || '').trim() }),
    sessionId: String(raw.sessionId || '').trim(),
    projectDirName: String(raw.projectDirName || '').trim(),
    projectPath: String(raw.projectPath || '').trim(),
    model: String(raw.model || '').trim(),
    interactionMode: String(raw.interactionMode || 'default').trim() || 'default',
    socket: String(raw.socket || '').trim(),
    tmuxSession: String(raw.tmuxSession || 'run').trim() || 'run',
    logPath: String(raw.logPath || '').trim(),
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0
  };
}

function isUsableManifest(entry) {
  const hasRuntimeTarget = entry && (entry.gateway === true || isAccountRef(entry.accountRef));
  return Boolean(hasRuntimeTarget && entry.runId && entry.provider && entry.socket && entry.logPath);
}

function writeRunManifest(aiHomeDir, rawEntry = {}, options = {}) {
  const fs = options.fs || nodeFs;
  const entry = normalizeManifest(rawEntry);
  const filePath = manifestPath(aiHomeDir, entry.runId);
  if (!filePath || !isUsableManifest(entry)) return null;
  entry.updatedAt = Number(options.now) || Date.now();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    return entry;
  } catch (_error) {
    return null;
  }
}

function readRunManifest(aiHomeDir, runId, options = {}) {
  const fs = options.fs || nodeFs;
  const filePath = manifestPath(aiHomeDir, runId);
  if (!filePath) return null;
  try {
    const entry = normalizeManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return isUsableManifest(entry) ? entry : null;
  } catch (_error) {
    return null;
  }
}

// 合并更新（如 session-created 后回填 sessionId）。
function updateRunManifest(aiHomeDir, runId, patch = {}, options = {}) {
  const existing = readRunManifest(aiHomeDir, runId, options);
  if (!existing) return null;
  return writeRunManifest(aiHomeDir, { ...existing, ...patch, runId: existing.runId }, options);
}

function removeRunManifest(aiHomeDir, runId, options = {}) {
  const fs = options.fs || nodeFs;
  const filePath = manifestPath(aiHomeDir, runId);
  if (!filePath) return;
  for (const target of [filePath, options.keepLog ? '' : runLogPath(aiHomeDir, runId)]) {
    if (!target) continue;
    try { fs.unlinkSync(target); } catch (_error) { /* 不存在即视为已清理 */ }
  }
}

function listRunManifests(aiHomeDir, options = {}) {
  const fs = options.fs || nodeFs;
  const dir = manifestDir(aiHomeDir);
  if (!dir) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (_error) {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const entry = normalizeManifest(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (isUsableManifest(entry)) entries.push(entry);
    } catch (_error) { /* 坏条目跳过 */ }
  }
  return entries;
}

module.exports = {
  manifestDir,
  manifestPath,
  runLogPath,
  normalizeManifest,
  writeRunManifest,
  readRunManifest,
  updateRunManifest,
  removeRunManifest,
  listRunManifests
};
