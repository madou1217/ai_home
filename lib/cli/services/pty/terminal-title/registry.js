'use strict';

// 标题来源注册表：**能力 → 来源**的倒排索引 + 优先级排序。
//
// 门面问「现在有哪些来源」，注册表按 `priority` 给出有序链；派发代码里**没有
// provider 名**。新增一种标题事实 = 注册一个来源工厂（`sources/index.js`），
// 不动门面；provider 要追加自己的来源，就把工厂交给组合根，同样不动门面。
//
// 与 `lib/providers/registry.js` 同一条纪律：消费方问能力，不问 provider。

const { validateTitleSource } = require('./contract');

function createTitleSourceRegistry(options = {}) {
  const sources = [];
  const seen = new Set();

  function registerSource(factory) {
    const normalized = validateTitleSource(factory);
    // 幂等：组合根可能在多处装配同一个来源（例如内置 + provider 扩展），重复注册不报错。
    if (seen.has(normalized.id)) return normalized;
    seen.add(normalized.id);
    sources.push(normalized);
    return normalized;
  }

  (Array.isArray(options.sources) ? options.sources : []).forEach(registerSource);

  // 有序链：priority 小的先出帧。同 priority 保持注册顺序（排序稳定）。
  function listSources() {
    return sources
      .map((source, index) => ({ source, index }))
      .sort((a, b) => (a.source.priority - b.source.priority) || (a.index - b.index))
      .map((entry) => entry.source);
  }

  // 按顺序把每个来源的帧摊平。单个来源抛异常只丢它自己的帧——标题永远不该因为
  // 某一个事实读不到而整条消失。
  // 声明 attention 的来源（待回答的提问、失败/中断）一旦出帧，就只显示这些帧：
  // 会话卡在用户身上时，标题不能把它排进 4s×N 的轮播队尾。
  function collectFrames(ctx) {
    const frames = [];
    const attentionFrames = [];
    for (const source of listSources()) {
      try {
        const produced = source.provide(ctx);
        if (!Array.isArray(produced)) continue;
        for (const frame of produced) {
          const text = String(frame == null ? '' : frame).trim();
          if (!text) continue;
          frames.push(text);
          if (source.attention === true) attentionFrames.push(text);
        }
      } catch (_error) {
        // 契约要求来源绝不抛；这里兜底，保证一个坏来源不会让标题消失。
      }
    }
    return attentionFrames.length > 0 ? attentionFrames : frames;
  }

  return { registerSource, listSources, collectFrames };
}

let defaultRegistry = null;

function getTitleSourceRegistry(options = {}) {
  if (options.registry) return options.registry;
  if (!defaultRegistry) {
    const { createBuiltinTitleSources } = require('./sources');
    defaultRegistry = createTitleSourceRegistry({ sources: createBuiltinTitleSources() });
  }
  return defaultRegistry;
}

// provider 扩展来源在组合根装配后调用，使下一次取门面时带上它们。
function setTitleSourceRegistry(registry) {
  defaultRegistry = registry || null;
  return defaultRegistry;
}

function resetTitleSourceRegistry() {
  defaultRegistry = null;
}

module.exports = {
  createTitleSourceRegistry,
  getTitleSourceRegistry,
  setTitleSourceRegistry,
  resetTitleSourceRegistry
};
