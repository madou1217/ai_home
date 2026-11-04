'use strict';

// 备份策略注册表。新增策略（例如 webdav）= 在这里加一行，配置层与服务编排都不用改。

const { createSshBackupStrategy } = require('./ssh');

const BACKUP_STRATEGIES = Object.freeze({
  ssh: createSshBackupStrategy
});

function listBackupStrategies() {
  return Object.keys(BACKUP_STRATEGIES);
}

function createBackupStrategy(target, deps = {}) {
  const name = String(target && target.strategy || '').trim().toLowerCase();
  const factory = BACKUP_STRATEGIES[name];
  if (!factory) throw new Error(`不支持的备份策略：${name || '(empty)'}（可用：${listBackupStrategies().join(', ')}）`);
  return factory(target, deps);
}

module.exports = {
  BACKUP_STRATEGIES,
  createBackupStrategy,
  listBackupStrategies
};
