'use strict';

// 终端标题的**来源契约**（TitleSource）——标题抽象的两条轴之一。
//
//   终端轴      [各种各样的终端]              → transport.js
//   Provider 轴 [各种各样的 provider 以及协议] → 本契约 + registry.js + sources/
//
// 每个实现只回答一个问题：**你这个来源此刻要贡献哪几帧**。
//
//     provide(ctx) -> string[]
//
// 帧（frame）是「一段可独立显示的完整标题文本」，不是片段——轮播一次显示一帧，
// 所以每帧自己必须读得懂。返回空数组表示「此刻没有可显示的事实」（例如该 provider
// 没有额度面），**不是失败**：门面不因此报错，也不留空档。
//
// 三条纪律：
//   1. provide 必须**同步、纯读、绝不抛**。标题在每次状态变化时都要重算，抛异常会
//      拖垮启动路径。
//   2. 帧里的控制字符由 composer 统一清洗，来源不必自己 sanitize。
//   3. 来源**不判断显示开关**（用量开关、全屏 TUI 抑制、shell drawer 可见性、登录流）
//      ——那是门面的职责。来源只管「有事实就产出」。

// 内置来源的能力名。provider 描述符可以用 `title.sources` 追加自己的来源（经组合根
// 注册实现），但**不必**声明这些内置能力——它们是普适事实，不是某家 provider 的特性。
const TITLE_SOURCE_CAPABILITIES = Object.freeze([
  'title.session',
  'title.identity',
  'title.route',
  'title.usage',
  'title.account'
]);

const TITLE_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

class TitleSourceError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TitleSourceError';
    this.code = code;
    this.detail = detail || '';
  }
}

function titleSourceError(code, detail) {
  return new TitleSourceError(code, detail);
}

// 校验一个来源工厂：形状错了要**立刻**报，不能等到某个会话刷新标题时才发现。
function validateTitleSource(factory) {
  if (!factory || typeof factory !== 'object') throw titleSourceError('title_source_invalid');
  const id = normalizeText(factory.id).toLowerCase();
  if (!TITLE_SOURCE_ID_PATTERN.test(id)) throw titleSourceError('title_source_id_invalid', id);
  const capability = normalizeText(factory.capability);
  if (!TITLE_SOURCE_CAPABILITIES.includes(capability)) {
    throw titleSourceError('title_source_capability_unknown', `${id}:${capability || '(empty)'}`);
  }
  if (typeof factory.provide !== 'function') throw titleSourceError('title_source_provide_missing', id);
  const priority = Number(factory.priority);
  return Object.freeze({
    ...factory,
    id,
    capability,
    priority: Number.isFinite(priority) ? priority : 100
  });
}

module.exports = {
  TITLE_SOURCE_CAPABILITIES,
  TITLE_SOURCE_ID_PATTERN,
  TitleSourceError,
  titleSourceError,
  validateTitleSource
};
