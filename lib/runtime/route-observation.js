'use strict';

// 网关模式的**路由观测**：回答「这个会话的请求当前落到了哪个账号 / 哪个模型」。
//
// 为什么需要单独一条通道：`aih claude` / `aih codex` 不带账号时，请求由本地
// server 按池调度（会话亲和 + 加权随机 + 冷却回退），**每个回合可能落到不同账号**。
// 这个事实只有服务端知道——CLI 进程手里只有网关地址与 client key，看不到选号结果。
//
// 于是按「服务端落盘、CLI 读回」解耦：
//
//   服务端  每次成功选号后写一条 `{ accountRef, model, at }` 到会话条目
//           （`<aiHomeDir>/run/route-observation/<sessionKey>.json`，只含寻址元数据，
//           **绝不写凭据**）
//   CLI     按自己的会话键轮询读回，供标题的 route 帧使用
//
// 会话键用**tmux 会话名**（`aihSessionName`）：它在本机唯一、跨回合稳定，且 CLI 与
// 服务端都能从请求头拿到（`x-session-id`，见 lib/server/session-key.js 的候选表）。
//
// 读侧一律 fail-soft：文件缺失、损坏、过期、键为空都返回 null（标题少一帧，不报错）。

const fsBase = require('node:fs');
const pathBase = require('node:path');

const ROUTE_OBSERVATION_DIR = ['run', 'route-observation'];
// 观测值的保质期：超过它说明这个会话已经很久没请求了，旧账号名不该继续挂在标题上。
const ROUTE_OBSERVATION_TTL_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// 会话键进文件名：只留安全字符，其余换成 `-`，避免路径穿越与非法文件名。
function sanitizeSessionKeyForFile(sessionKey) {
  const raw = normalizeText(sessionKey);
  if (!raw) return '';
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return safe || '';
}

function buildRouteObservationPath(aiHomeDir, sessionKey, pathImpl = pathBase) {
  const dir = normalizeText(aiHomeDir);
  const safe = sanitizeSessionKeyForFile(sessionKey);
  if (!dir || !safe) return '';
  return pathImpl.join(dir, ...ROUTE_OBSERVATION_DIR, `${safe}.json`);
}

function normalizeRouteObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const accountRef = normalizeText(value.accountRef);
  const accountId = normalizeText(value.accountId);
  const model = normalizeText(value.model);
  if (!accountRef && !accountId && !model) return null;
  const at = Number(value.at) || 0;
  return { accountRef, accountId, model, at };
}

// 读侧：CLI 进程按自己的会话键取回最近一次选号结果。fail-soft。
function readRouteObservation(input = {}) {
  const fs = input.fs || fsBase;
  const pathImpl = input.path || pathBase;
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const ttlMs = Math.max(0, Number(input.ttlMs) || ROUTE_OBSERVATION_TTL_MS);
  const filePath = buildRouteObservationPath(input.aiHomeDir, input.sessionKey, pathImpl);
  if (!filePath) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8')));
  } catch (_error) {
    return null;
  }
  const observation = normalizeRouteObservation(parsed);
  if (!observation) return null;
  if (observation.at > 0 && ttlMs > 0 && now() - observation.at > ttlMs) return null;
  return observation;
}

// 写侧：服务端在成功选号后落盘。**只写寻址元数据**（账号引用 / 显示序号 / 模型 / 时间），
// 绝不写凭据——这个目录会被 CLI 进程与诊断工具读到。
function writeRouteObservation(input = {}) {
  const fs = input.fs || fsBase;
  const pathImpl = input.path || pathBase;
  const filePath = buildRouteObservationPath(input.aiHomeDir, input.sessionKey, pathImpl);
  if (!filePath) return false;
  const observation = normalizeRouteObservation({
    accountRef: input.accountRef,
    accountId: input.accountId,
    model: input.model,
    at: Number(input.at) || Date.now()
  });
  if (!observation) return false;
  try {
    fs.mkdirSync(pathImpl.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(observation), { mode: 0o600 });
    return true;
  } catch (_error) {
    return false;
  }
}

function clearRouteObservation(input = {}) {
  const fs = input.fs || fsBase;
  const pathImpl = input.path || pathBase;
  const filePath = buildRouteObservationPath(input.aiHomeDir, input.sessionKey, pathImpl);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  ROUTE_OBSERVATION_DIR,
  ROUTE_OBSERVATION_TTL_MS,
  sanitizeSessionKeyForFile,
  buildRouteObservationPath,
  normalizeRouteObservation,
  readRouteObservation,
  writeRouteObservation,
  clearRouteObservation
};
