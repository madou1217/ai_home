'use strict';

// 「AI 翻译」页面的默认值与开关的领域持久化层。
//
// 语义：source / target / model 三项都可以各自设定默认值，页面与全局悬浮窗共用同一份
// 设置（悬浮窗是「随时唤起的翻译」，如果它不跟随页面默认值，用户每次都要重选一次语言）。
//
// 存储沿用 account:* / config:* 的命名惯例，落在 app_kv 的单条记录上：
//   webui:translation-settings {
//     source: 'auto' | 语言代码,
//     target: 语言代码,
//     model: 模型 id（空 = 未显式设置，由前端按模型目录兜底）,
//     provider: 模型所属 provider（空 = 让网关按模型 id 路由）,
//     updatedAt: 毫秒时间戳
//   }
//
// 为什么不给每个会话存历史：翻译是无状态的一次性动作，设置只需记住「上次用的那套」，
// 存历史会让「默认值」语义变模糊。

const { readJsonValue, writeJsonValue } = require('../server/app-state-store');
const {
  AUTO_LANGUAGE,
  normalizeLanguageCode,
  isSupportedLanguage
} = require('../server/translation-language');

const TRANSLATION_SETTINGS_KEY = 'webui:translation-settings';
const DEFAULT_TRANSLATION_TARGET = 'zh-Hans';
// 模型 id 的长度上限只为挡住明显的坏值（整段 JSON、路径），不猜测真实命名的形状。
const MAX_MODEL_ID_LENGTH = 200;

function normalizeModelId(value) {
  const model = String(value || '').trim();
  return model.length > MAX_MODEL_ID_LENGTH ? model.slice(0, MAX_MODEL_ID_LENGTH) : model;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/**
 * 归一化一份设置。非法值一律回落默认，不抛错：设置是「偏好」，
 * 一条坏记录不该让翻译页直接不可用（与 server config 的严格校验不同）。
 */
function normalizeTranslationSettings(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceCode = normalizeLanguageCode(input.source);
  const targetCode = normalizeLanguageCode(input.target);
  const updatedAt = Number(input.updatedAt);
  return {
    source: sourceCode === AUTO_LANGUAGE || isSupportedLanguage(sourceCode)
      ? sourceCode
      : AUTO_LANGUAGE,
    target: isSupportedLanguage(targetCode) ? targetCode : DEFAULT_TRANSLATION_TARGET,
    model: normalizeModelId(input.model),
    provider: normalizeProvider(input.provider),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0
  };
}

function defaultTranslationSettings() {
  return normalizeTranslationSettings(null);
}

function readTranslationSettings(fs, aiHomeDir, deps = {}) {
  const stored = readJsonValue(fs, aiHomeDir, TRANSLATION_SETTINGS_KEY, { strict: true, ...deps });
  if (stored === null) return null;
  return normalizeTranslationSettings(stored);
}

function writeTranslationSettings(fs, aiHomeDir, patch = {}, deps = {}) {
  const current = readTranslationSettings(fs, aiHomeDir, deps);
  const next = normalizeTranslationSettings({
    ...(current || defaultTranslationSettings()),
    ...patch,
    updatedAt: Date.now()
  });
  const written = writeJsonValue(fs, aiHomeDir, TRANSLATION_SETTINGS_KEY, next, deps);
  if (!written) throw new Error('translation_settings_write_failed');
  return next;
}

module.exports = {
  TRANSLATION_SETTINGS_KEY,
  DEFAULT_TRANSLATION_TARGET,
  MAX_MODEL_ID_LENGTH,
  defaultTranslationSettings,
  normalizeTranslationSettings,
  readTranslationSettings,
  writeTranslationSettings
};
