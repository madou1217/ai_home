'use strict';

const nodePath = require('node:path');

/**
 * 通用宿主账号观察者：把「扫描本机账号」的两个通用检测器（OAuth 投影 / API Key 槽位）接进后台轮询，
 * 让宿主上新登录的账号不用用户点按钮、也不用在 aih 里重登就自动入库。
 *
 * 与 BaseHostAccountSync 的分工：基类是「单份 JSON 文档 + 代际比较 + CAS 刷新既有账号」的骨架，
 * 给需要**持续跟随宿主续期**的 provider（codex / codebuddy 家族 / cline）用；这里只做**新增**
 * （insertOnly + respectDeletion），比不出代际就不动库，所以不需要那套比较骨架——只需要一个
 * 便宜的变更门：被观察文件的 stamp（ino/size/mtime）没变就不重扫。
 *
 * 契约与注册表其它 entry 一致：scan / start / stop / getStats。
 */
function createGenericHostAccountSync(deps = {}) {
  const fs = deps.fs;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const generic = deps.genericDetectors || require('../host-generic-detectors');
  let timer = null;
  let running = false;
  let lastStamp = '';
  let lastScan = { updated: [], skipped: [], scanned: 0 };
  const pending = new Map();

  function watchedFiles() {
    if (!hostHomeDir) return [];
    const { hostAuthArtifacts } = require('../host-auth-import');
    const { listHostApiKeyStrategies } = require('../host-api-key-scan');
    const files = [];
    for (const provider of generic.listProjectionProviders()) {
      for (const artifact of hostAuthArtifacts(provider)) files.push(nodePath.join(hostHomeDir, ...artifact.hostRelative));
    }
    for (const strategy of listHostApiKeyStrategies()) {
      for (const slot of strategy.hostApiKeySlots) files.push(nodePath.join(hostHomeDir, ...slot.path));
    }
    return [...new Set(files)].sort();
  }

  function computeStamp() {
    return watchedFiles().map((file) => {
      try {
        const stat = fs.lstatSync(file);
        return `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch (_error) {
        return `${file}:-`;
      }
    }).join('|');
  }

  /** 一轮扫描。`options.gated` 时 stamp 未变直接返回上一轮结果（后台轮询用；按需扫描不 gate）。 */
  function scan(options = {}) {
    const empty = { updated: [], skipped: [], scanned: 0 };
    if (!fs || !aiHomeDir || !hostHomeDir) return empty;
    const stamp = computeStamp();
    if (options.gated === true && stamp === lastStamp) return { ...empty, unchanged: true };
    const runOptions = { fs, aiHomeDir, hostHomeDir, readServerConfig: deps.readServerConfig };
    const results = [generic.detectHostProjectionAccounts(runOptions), generic.detectHostApiKeyAccounts(runOptions)];
    const result = { updated: [], skipped: [], scanned: 0 };
    for (const item of results) {
      if (!item || item.ok !== true) continue;
      result.scanned += item.scanned;
      result.updated.push(...item.registered);
      result.skipped.push(...item.skipped);
    }
    for (const event of result.updated) if (event.accountRef) pending.set(event.accountRef, event);
    lastStamp = stamp;
    lastScan = result;
    return result;
  }

  function start(options = {}) {
    if (timer) return;
    const tick = () => {
      if (running) return;
      running = true;
      try {
        scan({ gated: true });
        if (pending.size > 0 && typeof options.onUpdated === 'function') {
          const events = [...pending.values()];
          options.onUpdated(events);
          for (const event of events) pending.delete(event.accountRef);
        }
      } catch (_error) {
        if (typeof options.onError === 'function') options.onError('generic_host_account_sync_failed');
      } finally {
        running = false;
      }
    };
    tick();
    timer = setIntervalImpl(tick, Math.max(1000, Number(options.intervalMs) || 5000));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }

  function getStats() {
    return { scanned: lastScan.scanned, updated: lastScan.updated.length, skipped: lastScan.skipped, pending: pending.size };
  }

  return { scan, start, stop, getStats };
}

/** 覆盖的 provider（注册表 ↔ 墓碑覆盖断言用）：两个通用检测器的并集。 */
function genericHostAccountSyncProviders() {
  const generic = require('../host-generic-detectors');
  return [...new Set([...generic.listProjectionProviders(), ...generic.listApiKeyProviders()])];
}

module.exports = { createGenericHostAccountSync, genericHostAccountSyncProviders };
