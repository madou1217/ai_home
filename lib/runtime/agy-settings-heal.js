'use strict';

// agy（Antigravity CLI）设置文件里的默认模型自愈。
//
// 事实（2026-10-15 本机实测）：`settings.json` 的 `model` 字段会**过期** —— 7 个账号投影与宿主
// 都停在 `Gemini 3.5 Flash (High)`，而 CLI 当前只认 6 个显示名（见 agy-model-names.js）。
// 直接跑 `agy`（不经 aih 传 --model）时会拿这个过期默认去请求 → 上游
// `RESOURCE_EXHAUSTED (429)`（agy 包装成「AI credits balance is too low」）。
//
// 这里在启动准备阶段把它修成当前有效名：幂等、失败静默（best effort）、原文件先备份。
// 只改 `model` 一个字段，其它键原样保留。

const { listAgyCliModelNames, resolveAgyCliModelName } = require('./agy-model-names');

const DEFAULT_SETTINGS_RELATIVE = Object.freeze(['.gemini', 'antigravity-cli', 'settings.json']);

function readJson(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/**
 * 修一个 agy settings 文件里的默认模型。
 *
 * @param {object} input
 * @param {object} input.fs   fs 实现（注入，便于测试）
 * @param {string} input.settingsPath  要修的文件（通常是投影里的 settings.json）
 * @param {string} [input.preferredModel]  想写的模型（id 或显示名）；缺省用 CLI 首个有效名
 * @returns {{status: string, from?: string, to?: string, reason?: string}}
 */
function healAgySettingsModel(input = {}) {
  const fsImpl = input.fs;
  const settingsPath = String(input.settingsPath || '').trim();
  if (!fsImpl || !settingsPath) return { status: 'skipped', reason: 'settings_path_unavailable' };
  const settings = readJson(fsImpl, settingsPath);
  if (!settings || typeof settings !== 'object') return { status: 'skipped', reason: 'settings_unreadable' };
  const current = String(settings.model || '').trim();
  if (resolveAgyCliModelName(current)) return { status: 'ok', from: current, to: current };
  const preferred = resolveAgyCliModelName(input.preferredModel) || listAgyCliModelNames()[0] || '';
  if (!preferred) return { status: 'skipped', reason: 'no_known_model_name' };
  try {
    const backupPath = `${settingsPath}.aih-model-heal.bak`;
    if (!fsImpl.existsSync(backupPath)) fsImpl.copyFileSync(settingsPath, backupPath);
    fsImpl.writeFileSync(settingsPath, `${JSON.stringify({ ...settings, model: preferred }, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { status: 'failed', reason: String((error && error.message) || error || 'write_failed') };
  }
  return { status: 'healed', from: current, to: preferred };
}

module.exports = {
  DEFAULT_SETTINGS_RELATIVE,
  healAgySettingsModel
};
