'use strict';

// 终端标题的**输出通道契约**（TitleTransport）——标题抽象的另一条轴。
//
//   终端轴      [各种各样的终端]              → 本契约 + transports.js（工厂）
//   Provider 轴 [各种各样的 provider 以及协议] → contract.js + registry.js + sources/
//
// 门面只认这条契约，不认具体终端。新增一种写标题的方式 = 加一个 transport 工厂
// （见 transports.js），门面代码不动。
//
// 契约：
//   writeTitle(text)   写一行标题；空串由门面拦截（有意清空走 clearTitle）
//   clearTitle()       把命名权还给终端（写空标题）
//   supports(options)  这台终端能不能承载标题（不可用时门面整体让位，不空转）
//
// 一条硬约束：**写标题绝不能抛**。标题是装饰，任何终端怪癖都不该影响会话启动。

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

class TitleTransportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TitleTransportError';
    this.code = code;
    this.detail = detail || '';
  }
}

function titleTransportError(code, detail) {
  return new TitleTransportError(code, detail);
}

function validateTitleTransport(factory) {
  if (!factory || typeof factory !== 'object') throw titleTransportError('title_transport_invalid');
  const id = normalizeText(factory.id).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw titleTransportError('title_transport_id_invalid', id);
  if (typeof factory.create !== 'function') throw titleTransportError('title_transport_create_missing', id);
  return Object.freeze({ ...factory, id });
}

module.exports = {
  TitleTransportError,
  titleTransportError,
  validateTitleTransport
};
