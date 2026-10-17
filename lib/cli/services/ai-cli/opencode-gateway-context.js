'use strict';

// 兼容入口：上下文定义已下沉到 runtime（run-layouts 也需要读同一份）。
const context = require('../../../runtime/opencode-context');

module.exports = {
  OPENCODE_GATEWAY_ENV: context.OPENCODE_CONTEXT_ENV,
  parseOpencodeGateway: context.parseOpencodeContext,
  serializeOpencodeGateway: context.serializeOpencodeContext,
  readOpencodeGatewayField: context.readOpencodeContextField
};
