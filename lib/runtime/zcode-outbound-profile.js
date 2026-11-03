'use strict';

// **非桌面通道**（`aih zcode -p` 的 app-server / headless CLI）的出站画像整形。
//
// 背景：桌面通道的 plan 请求由 relay 整形（见 upstream-endpoints-transport-general.js），
// 但 `-p` 走的是 CLI 自己的 agent 进程，请求由 CLI 直接发出 —— 它自报的
// `x-zcode-app-version` 是 **CLI bundle 版本**（0.17.1），body 里是**它自己那版**的
// system。两者虽然「成对」，但这一对没被上游放行过，于是稳定 3012。
//
// 做法：在 CLI 子进程里预加载本文件，把 plan 请求换成缓存里的**画像**（appVersion +
// harness 一起换），其余请求逐字节不动。和 relay 共用同一份画像缓存，因此「学一次、
// 两条通道都受益」，升级时也只跟着画像走。
//
// 安装方式：`node --require <本文件> <cli> app-server --stdio`，画像路径走环境变量
// `AIH_ZCODE_HARNESS_STORE`（不写进 argv，避免路径含空格时的转义问题）。

const { readZcodeHarnessSystem, selectZcodeHarnessProfile } = require('../server/zcode-harness-store');

const PROFILE_ENV = 'AIH_ZCODE_HARNESS_STORE';
const PLAN_PATH_HINT = '/zcode-plan/';
const VERSION_HEADER = 'x-zcode-app-version';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function loadProfile(storePath) {
  try {
    const store = readZcodeHarnessSystem({ storePath });
    return selectZcodeHarnessProfile({ store });
  } catch (_error) {
    return null;
  }
}

/** 按 Headers / 普通对象 / 数组三种形态写同一个头（大小写不敏感）。 */
function setHeader(headers, name, value) {
  const target = String(name || '').toLowerCase();
  if (!target || !value) return headers;
  if (!headers) return { [target]: value };
  if (typeof headers.set === 'function' && typeof headers.get === 'function') {
    headers.set(target, value);
    return headers;
  }
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 1) {
      const pair = headers[index];
      if (Array.isArray(pair) && String(pair[0] || '').toLowerCase() === target) {
        pair[1] = value;
        return headers;
      }
    }
    headers.push([target, value]);
    return headers;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      headers[key] = value;
      return headers;
    }
  }
  headers[target] = value;
  return headers;
}

function readHeader(headers, name) {
  const target = String(name || '').toLowerCase();
  if (!headers) return '';
  if (typeof headers.get === 'function') return normalizeText(headers.get(target));
  if (Array.isArray(headers)) {
    const hit = headers.find((pair) => Array.isArray(pair) && String(pair[0] || '').toLowerCase() === target);
    return hit ? normalizeText(hit[1]) : '';
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return normalizeText(headers[key]);
  }
  return '';
}

/** 把 body 的 system 换成画像里的 harness；不可解析时原样返回 null（调用方透传）。 */
function applyProfileToBody(bodyText, profile) {
  if (typeof bodyText !== 'string' || !bodyText.trim().startsWith('{')) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const current = Array.isArray(parsed.system) ? JSON.stringify(parsed.system) : '';
  if (current === JSON.stringify(profile.blocks)) return null;
  parsed.system = profile.blocks;
  return JSON.stringify(parsed);
}

/**
 * 安装出站画像整形（幂等、fail-soft：任何异常都不改变请求）。
 *
 * @param {object} options { storePath, globalObj }
 * @returns {boolean} 是否已安装
 */
function installZcodeOutboundProfile(options = {}) {
  const globalObj = options.globalObj || globalThis;
  const storePath = normalizeText(options.storePath);
  if (!storePath) return false;
  const original = globalObj.fetch;
  if (typeof original !== 'function') return false;
  if (original.__aihZcodeOutboundProfile === true) return true;
  const wrapped = function aihZcodeProfileFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : normalizeText(input && input.url);
      if (!url.includes(PLAN_PATH_HINT)) return original.call(this, input, init);
      const profile = loadProfile(storePath);
      if (!profile || !Array.isArray(profile.blocks) || !profile.blocks.length) {
        return original.call(this, input, init);
      }
      const nextInit = init && typeof init === 'object' ? { ...init } : {};
      const headers = setHeader(nextInit.headers || (input && input.headers) || {}, VERSION_HEADER, profile.appVersion);
      // UA 的版本段跟着画像走：头说 3.17.1、UA 说 0.17.1 是不自洽的画像。
      const userAgent = readHeader(headers, 'user-agent');
      if (profile.appVersion && /^ZCode\//i.test(userAgent)) {
        setHeader(headers, 'user-agent', userAgent.replace(/^ZCode\/[^\s]+/i, 'ZCode/' + profile.appVersion));
      }
      nextInit.headers = headers;
      const rewritten = applyProfileToBody(nextInit.body, profile);
      if (rewritten) nextInit.body = rewritten;
      const nextInput = typeof input === 'string' ? input : input;
      return original.call(this, nextInput, nextInit);
    } catch (_error) {
      return original.call(this, input, init);
    }
  };
  wrapped.__aihZcodeOutboundProfile = true;
  globalObj.fetch = wrapped;
  return true;
}

// `--require` 预加载时自动安装（画像路径由启动方通过环境变量给出）。
if (process.env && normalizeText(process.env[PROFILE_ENV])) {
  try {
    installZcodeOutboundProfile({ storePath: process.env[PROFILE_ENV] });
  } catch (_error) { /* 纯旁路：安装失败不影响 CLI */ }
}

module.exports = {
  PROFILE_ENV,
  applyProfileToBody,
  installZcodeOutboundProfile,
  loadProfile,
  setHeader
};
