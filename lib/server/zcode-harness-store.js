'use strict';

// ZCode plan 端点的 **harness 系统提示**：从官方客户端学习、缓存、供 relay 复用。
//
// 为什么需要（2026-10-28 真机取证，见 docs 无关的提交说明）：
//   * `POST {origin}/api/v1/zcode-plan/anthropic/v1/messages` 的准入判据**在 body**：
//     同一份头 + 同一账号，
//       - 最小 body（无 system）                     → HTTP 405 {"code":3012,"msg":"request has been
//         blocked due to unusual activity."}
//       - 最小 body + 官方 system 两块（42B + 3155B）→ **200**
//       - 官方 system 追加/删块/换通用文案            → 3012
//       - 官方 system + 非官方 tools                 → **200**（tools 不参与判定）
//     ⇒ system 必须带官方 harness（identity 行 + harness 段；实测前 1577 字节即已足够过门）。
//   * 这份文本在 CLI bundle 里是**运行时拼接**（`iua()` = identity 行 + d0o + okn()…），
//     静态提取会与客户端版本耦合；因此这里**从官方客户端自己的出站请求里学习**并缓存
//     ——不把厂商提示词 vendored 进仓库，客户端升级后重新学习即可自愈。
//
// 学习点：`lib/runtime/zcode-request-capture.js` 在 agent 进程里观察出站 fetch（用户用
// 官方桌面端跑一次即学到）。消费点：relay 的 zcode plan 请求（见 zcode-harness-request.js）。

const HARNESS_STORE_FILE = 'zcode-harness-system.json';
const HARNESS_IDENTITY_MARKER = 'You are ZCode, an interactive coding agent';

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
 * 判定一份 `system` 是否为官方 ZCode harness（identity 行是稳定锚点）。
 * 命中即整份数组原样采用（保留 cache_control 等字段）。
 *
 * @param {unknown} system Anthropic 请求体的 system 字段
 * @returns {Array<object>|null}
 */
function extractZcodeHarnessBlocks(system) {
  if (!Array.isArray(system) || system.length === 0) return null;
  const first = system[0];
  const firstText = typeof first === 'string' ? first : normalizeText(first && first.text);
  if (!firstText.startsWith(HARNESS_IDENTITY_MARKER)) return null;
  return system
    .filter((block) => block && (typeof block === 'string' || typeof block.text === 'string'))
    .map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block));
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

/**
 * 读取缓存的 harness（不存在/不可解析/缺 identity 锚点 → null，调用方 fail-soft）。
 *
 * @param {object} input { fs, aiHomeDir, path }
 * @returns {{blocks: Array<object>, appVersion: string, capturedAt: string}|null}
 */
function readZcodeHarnessSystem(input = {}) {
  const fsImpl = input.fs || require('node:fs');
  const storePath = resolveZcodeHarnessStorePath(input);
  if (!storePath) return null;
  try {
    if (!fsImpl.existsSync(storePath)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(storePath, 'utf8'));
    const blocks = extractZcodeHarnessBlocks(parsed && parsed.blocks);
    if (!blocks) return null;
    return {
      blocks,
      appVersion: normalizeText(parsed && parsed.appVersion),
      capturedAt: normalizeText(parsed && parsed.capturedAt)
    };
  } catch (_error) {
    return null;
  }
}

/**
 * 写入缓存的 harness（同内容不重写；原子写 + 0600）。
 *
 * @returns {boolean} 是否发生写入
 */
function writeZcodeHarnessSystem(input = {}) {
  const fsImpl = input.fs || require('node:fs');
  const pathImpl = input.path || require('node:path');
  const storePath = resolveZcodeHarnessStorePath(input);
  const blocks = extractZcodeHarnessBlocks(input.blocks);
  if (!storePath || !blocks) return false;
  const payload = {
    appVersion: normalizeText(input.appVersion),
    capturedAt: new Date().toISOString(),
    blocks
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    if (fsImpl.existsSync(storePath)) {
      const current = fsImpl.readFileSync(storePath, 'utf8');
      if (current === serialized) return false;
      try {
        const parsed = JSON.parse(current);
        if (JSON.stringify(parsed && parsed.blocks) === JSON.stringify(blocks)) return false;
      } catch (_error) { /* 覆盖坏文件 */ }
    }
    fsImpl.mkdirSync(pathImpl.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmpPath, serialized, { mode: 0o600 });
    fsImpl.renameSync(tmpPath, storePath);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  HARNESS_IDENTITY_MARKER,
  HARNESS_STORE_FILE,
  extractZcodeHarnessBlocks,
  extractZcodeHarnessFromRequestBody,
  readZcodeHarnessSystem,
  resolveZcodeHarnessStorePath,
  writeZcodeHarnessSystem
};
