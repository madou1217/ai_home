'use strict';

// 插件 Provider 注册表 —— **canonical 描述符的唯一入口**。
//
// 旧实现维护了一套自己的 `{ id, version, protocol, capabilities[] }` 形状和
// 内置 provider 名单，与 `lib/providers/contract.js` 是两份事实源。现在统一：
//   * 校验交给 canonical `validateProviderDescriptor`（quota 必须显式回答等规则同源）；
//   * 写入 canonical provider 注册表的 `plugin` origin，可随插件代次整体替换；
//   * 本类只补充 owner/tombstone（插件卸载后不允许同名自动复活）。

const { validateProviderDescriptor } = require('../../providers/contract');
const { getProviderRegistry } = require('../../providers');

function normalizeId(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

class PluginProviderRegistry {
  constructor(options = {}) {
    this.registry = options.registry || getProviderRegistry();
    this.owners = new Map();
    this.tombstones = new Map();
  }

  register(definition, owner) {
    const descriptor = this.registry.register(definition, { origin: 'plugin' });
    this.owners.set(descriptor.id, String(owner || ''));
    this.tombstones.delete(descriptor.id);
    return descriptor;
  }

  unregister(id, owner) {
    const key = normalizeId(id);
    const currentOwner = this.owners.get(key) || '';
    if (owner && currentOwner !== String(owner)) return false;
    const descriptor = this.registry.get(key);
    if (!descriptor || this.registry.listByOrigin('plugin').indexOf(key) < 0) return false;
    const removed = this.registry.unregister(key, { origin: 'plugin' });
    if (!removed) return false;
    this.owners.delete(key);
    this.tombstones.set(key, { ...descriptor, disabledAt: Date.now() });
    return true;
  }

  has(id) {
    return this.registry.has(id);
  }

  get(id) {
    const key = normalizeId(id);
    return this.registry.listByOrigin('plugin').includes(key) ? this.registry.get(key) : null;
  }

  list() {
    return this.registry.listByOrigin('plugin')
      .map((id) => this.registry.get(id))
      .filter(Boolean);
  }

  listTombstones() {
    return [...this.tombstones.values()];
  }
}

module.exports = {
  PluginProviderRegistry,
  validateProviderDefinition: validateProviderDescriptor
};
