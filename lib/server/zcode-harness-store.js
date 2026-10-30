'use strict';

// ZCode plan 端点的 **客户端画像**：从官方客户端学习、缓存、供 relay 复用。
//
// 准入判据（2026-10-28 首轮 + 2026-10-31 矩阵复验）：
//   * 判定在 body 的 `system`：最小 body（无 system）/ 通用文案 / 追加删除块 → 3012；
//   * 头 `x-zcode-app-version` 与 body `system` 必须**同源成对**。四格矩阵（同一账号、
//     同一时刻、9s 间隔）：
//         旧 harness(42/3155/8672) + 3.16.3 → 200
//         旧 harness            + 3.17.1 → 3012
//         新 harness(35/3173/1703) + 3.16.3 → 3012
//         新 harness            + 3.17.1 → 200
//     ⇒ 上游要的是「某个客户端版本自己发的那一对」，不是「最新版本号」。
//
// 所以这里的缓存单位是 **profile = { appVersion, blocks }**：学的时候成对记，发的时候
// 成对发，绝不拿 A 版本的号配 B 版本的 harness。历史 profile 保留若干份，客户端降级/
// 升级都能直接命中；某一份被上游拒（405）就标记失效，下一次自动退到上一份。
//
// 为什么从出站请求里学、不 vendored 厂商提示词：harness 文本在 CLI bundle 里是运行时
// 拼接的（identity 行 + 各段），静态提取会与版本耦合；学习点
// `lib/runtime/zcode-request-capture.js` 装在**官方桌面端 agent 进程**里，只观察打到
// zcode-plan 端点的请求，因此来源天然可信。

const HARNESS_STORE_FILE = 'zcode-harness-system.json';
// 识别「官方 harness」只看**形状**，一个字面文案都不匹配（3.17.1 把 identity 行从
// "an interactive coding agent" 改成 "an interactive agent"，按字面匹配的学习链路
// 当天就静默失效，正是 2026-10-31 事故的直接原因）。
//   * 官方 harness：短 identity 行 + 长 harness 段 → 命中；
//   * 客户端自己的 system（codex/chat 通常是一整段长文本）→ 不命中，仍会被替换。
const HARNESS_MIN_BODY_CHARS = 500;
const HARNESS_MAX_IDENTITY_CHARS = 200;
// 保留几份历史画像：够覆盖「客户端回滚 / 灰度期两个版本并存」，又不至于无限增长。
const MAX_HARNESS_PROFILES = 5;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 缓存文件绝对路径（`<aiHomeDir>/run/zcode-harness-system.json`）。
 */
function resolveZcodeHarnessStorePath(input = {}) {
  const pathImpl = input.path || require('node:path');
  const explicit = normalizeText(input.storePath);
  if (explicit) return explicit;
  const aiHomeDir = normalizeText(input.aiHomeDir);
  if (!aiHomeDir) return '';
  return pathImpl.join(aiHomeDir, 'run', HARNESS_STORE_FILE);
}

/**
 * 判定一份 `system` 是否为官方 ZCode harness（只看形状）。命中即整份数组原样采用
 * （保留 cache_control 等字段）。
 *
 * @param {unknown} system Anthropic 请求体的 system 字段
 * @returns {Array<object>|null}
 */
function extractZcodeHarnessBlocks(system) {
  if (!Array.isArray(system) || system.length < 2) return null;
  const blocks = system
    .filter((block) => block && (typeof block === 'string' || typeof block.text === 'string'))
    .map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block));
  if (blocks.length !== system.length) return null;
  const identity = normalizeText(blocks[0].text);
  if (!identity || identity.length > HARNESS_MAX_IDENTITY_CHARS) return null;
  const bodyText = blocks.slice(1).map((block) => normalizeText(block.text)).join('\n');
  if (bodyText.length < HARNESS_MIN_BODY_CHARS) return null;
  return blocks;
}

/**
 * 从一段请求体文本里抽出 harness（学习路径的唯一实现处）。
 *
 * @param {string|Buffer} bodyText
 * @returns {Array<object>|null}
 */
function extractZcodeHarnessFromRequestBody(bodyText) {
  const text = Buffer.isBuffer(bodyText) ? bodyText.toString('utf8') : String(bodyText || '');
  if (!text.trim().startsWith('{')) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  return extractZcodeHarnessBlocks(parsed && parsed.system);
}

/** 归一化一份画像；形状不成立即 null。 */
function normalizeProfile(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const blocks = extractZcodeHarnessBlocks(entry.blocks);
  if (!blocks) return null;
  return {
    appVersion: normalizeText(entry.appVersion),
    capturedAt: normalizeText(entry.capturedAt),
    blocks
  };
}

/**
 * 读取缓存（不存在/不可解析/形状不成立 → null，调用方 fail-soft）。
 * 兼容旧格式（顶层就是一份画像）。
 *
 * @param {object} input { fs, aiHomeDir, path, storePath }
 * @returns {{blocks: Array<object>, appVersion: string, capturedAt: string, profiles: Array<object>}|null}
 */
function readZcodeHarnessSystem(input = {}) {
  const fsImpl = input.fs || require('node:fs');
  const storePath = resolveZcodeHarnessStorePath(input);
  if (!storePath) return null;
  try {
    if (!fsImpl.existsSync(storePath)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(storePath, 'utf8'));
    const listed = Array.isArray(parsed && parsed.profiles)
      ? parsed.profiles.map(normalizeProfile).filter(Boolean)
      : [];
    const current = normalizeProfile(parsed) || listed[0] || null;
    if (!current) return null;
    const profiles = listed.length ? listed : [current];
    return {
      blocks: current.blocks,
      appVersion: current.appVersion,
      capturedAt: current.capturedAt,
      profiles
    };
  } catch (_error) {
    return null;
  }
}

// 被上游拒过的画像版本（本进程内记忆）：405 之后不再优先使用，让位给上一份学到的组合。
const rejectedHarnessVersions = new Set();

/**
 * 写入一份新学到的画像（同版本同内容不重写；原子写 + 0600）。
 * 新画像置顶，历史保留 `MAX_HARNESS_PROFILES` 份。
 *
 * @returns {boolean} 是否发生写入
 */
function writeZcodeHarnessSystem(input = {}) {
  const fsImpl = input.fs || require('node:fs');
  const pathImpl = input.path || require('node:path');
  const storePath = resolveZcodeHarnessStorePath(input);
  const profile = normalizeProfile({
    blocks: input.blocks,
    appVersion: input.appVersion,
    capturedAt: new Date().toISOString()
  });
  if (!storePath || !profile) return false;
  try {
    const existing = readZcodeHarnessSystem({ fs: fsImpl, storePath });
    if (existing
      && existing.appVersion === profile.appVersion
      && JSON.stringify(existing.blocks) === JSON.stringify(profile.blocks)) {
      return false;
    }
    const profiles = [profile, ...(existing ? existing.profiles : [])]
      .filter((item, index, list) => list.findIndex((other) => other.appVersion === item.appVersion) === index)
      .slice(0, MAX_HARNESS_PROFILES);
    // 顶层仍保留最新一份：旧版本 aih 读同一个文件时行为不变（可回滚）。
    const payload = {
      appVersion: profiles[0].appVersion,
      capturedAt: profiles[0].capturedAt,
      blocks: profiles[0].blocks,
      profiles
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    fsImpl.mkdirSync(pathImpl.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmpPath, serialized, { mode: 0o600 });
    fsImpl.renameSync(tmpPath, storePath);
    // 学到新组合 = 重新开始：之前被拒的版本可能已经作废。
    rejectedHarnessVersions.clear();
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 选出本次要发的那一份画像：最新的、且没被上游拒过的。
 * 全被拒过时退回最新一份（总比不发好）。
 *
 * @param {object} input { store }
 * @returns {{blocks: Array<object>, appVersion: string, capturedAt: string}|null}
 */
function selectZcodeHarnessProfile(input = {}) {
  const store = input.store;
  if (!store) return null;
  const profiles = Array.isArray(store.profiles) && store.profiles.length
    ? store.profiles
    : [{ blocks: store.blocks, appVersion: store.appVersion, capturedAt: store.capturedAt }];
  const usable = profiles.filter((profile) => !rejectedHarnessVersions.has(profile.appVersion));
  return (usable.length ? usable : profiles)[0] || null;
}

/** 标记某份画像被上游拒绝（405）：后续请求自动让位给上一份。 */
function noteZcodeHarnessRejected(appVersion) {
  const version = normalizeText(appVersion);
  if (!version) return false;
  rejectedHarnessVersions.add(version);
  return true;
}

// 漂移自检：正常情况下（成对发送）这里永远不触发；一旦触发说明有代码把版本号和
// harness 拆开取源了，立刻在日志里暴露，而不是等上游回 3012。
const harnessDriftWarned = new Set();

/**
 * @param {object} input { harness: {blocks, appVersion}, appVersion }
 * @returns {{harnessVersion: string, appVersion: string, repeated: boolean}|null}
 */
function auditZcodeHarnessDrift(input = {}) {
  const harness = input.harness;
  const appVersion = normalizeText(input.appVersion);
  if (!harness || !Array.isArray(harness.blocks) || !appVersion) return null;
  const harnessVersion = normalizeText(harness.appVersion);
  if (!harnessVersion || harnessVersion === appVersion) return null;
  const key = harnessVersion + '->' + appVersion;
  const repeated = harnessDriftWarned.has(key);
  if (!repeated) {
    harnessDriftWarned.add(key);
    try {
      console.warn(
        '[zcode-harness] 画像版本 ' + harnessVersion + ' 与本次发送的 ' + appVersion
        + ' 不一致：上游只认成对画像，错配会直接 3012。'
      );
    } catch (_error) { /* 忽略 */ }
  }
  return { harnessVersion, appVersion, repeated };
}

module.exports = {
  HARNESS_MAX_IDENTITY_CHARS,
  HARNESS_MIN_BODY_CHARS,
  HARNESS_STORE_FILE,
  MAX_HARNESS_PROFILES,
  auditZcodeHarnessDrift,
  extractZcodeHarnessBlocks,
  extractZcodeHarnessFromRequestBody,
  noteZcodeHarnessRejected,
  readZcodeHarnessSystem,
  resolveZcodeHarnessStorePath,
  selectZcodeHarnessProfile,
  writeZcodeHarnessSystem
};
