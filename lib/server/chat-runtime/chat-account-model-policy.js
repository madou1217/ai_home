'use strict';

const { isAccountModelEnabled } = require('../model-catalog-settings-store');

// 与网关复用同一账号/模型开关；每次读取当前设置，不能随原生目录一起缓存。
function createChatAccountModelPolicy(getState) {
  return (provider, accountRef, model) => isAccountModelEnabled(
    getState().modelCatalogSettings,
    { id: model, provider, accountRef }
  );
}

module.exports = { createChatAccountModelPolicy };
