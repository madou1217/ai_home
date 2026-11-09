'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  openAppStateDatabase,
  readJsonValue,
} = require('../../server/app-state-store');
const { PluginError, requireCondition } = require('../sdk/errors');

const PLUGIN_STATE_KEY = 'plugins.control.v1';
const EMPTY_STATE = Object.freeze({ schemaVersion: 1, revision: 0, installed: [], instances: [], generations: [], activeGeneration: 0 });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion: 1,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    installed: Array.isArray(source.installed) ? source.installed : [],
    instances: Array.isArray(source.instances) ? source.instances : [],
    generations: Array.isArray(source.generations) ? source.generations : [],
    activeGeneration: Number.isSafeInteger(source.activeGeneration) && source.activeGeneration >= 0 ? source.activeGeneration : 0,
  };
}

function createPluginStateStore(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const pathImpl = options.path || path;
	const databaseOptions = options.databaseOptions || {};
	const open = options.openDatabase || ((...args) => openAppStateDatabase(...args));
	const read = options.readValue || ((...args) => readJsonValue(...args));
	// 生产由 plugin-system 注入 Go CAS 提交；未注入时保留本地事务（单测/离线 demo）。
	// 这不是用户开关：有 Go 写入口就绝不允许本地兜底，避免双写。
	const remoteCommit = typeof options.remoteCommit === 'function' ? options.remoteCommit : null;

  function get() {
    return normalizeState(read(fsImpl, aiHomeDir, PLUGIN_STATE_KEY, { ...databaseOptions, bestEffort: false }));
  }

  function update(mutator, expectedRevision) {
    requireCondition(typeof mutator === 'function', 'plugin_state_mutator_invalid');
    let db = null;
    try {
      db = open(fsImpl, aiHomeDir, databaseOptions);
      if (!db) throw new PluginError('plugin_state_unavailable');
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(PLUGIN_STATE_KEY);
      const current = normalizeState(row ? JSON.parse(String(row.value)) : EMPTY_STATE);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        db.exec('ROLLBACK');
        throw new PluginError('plugin_revision_conflict');
      }
      const next = normalizeState(mutator(clone(current)) || current);
      next.revision = current.revision + 1;
      db.prepare(`
        INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(PLUGIN_STATE_KEY, JSON.stringify(next), Date.now());
      db.exec('COMMIT');
      return clone(next);
    } catch (error) {
      try { if (db) db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    } finally {
      try { if (db) db.close(); } catch (_error) {}
    }
  }

	/**
	 * 以候选原文做一次 CAS 提交（enable/disable 使用）。
	 *
	 * 与 update 的区别：候选由 control 计算，状态文档不能在这里重排；注入 Go 后
	 * 本地只做 revision 预检与候选归一，真正的 CAS 与落盘在 Go。
	 */
	async function commitRemote(candidate, expectedRevision, operation) {
		const current = get();
		const expected = expectedRevision === undefined || expectedRevision === null || expectedRevision === ''
			? current.revision
			: Number(expectedRevision);
		if (!Number.isSafeInteger(expected) || current.revision !== expected) {
			throw new PluginError('plugin_revision_conflict', `配置已被修改（当前 revision ${current.revision}）`);
		}
		const next = normalizeState(clone(candidate));
		next.revision = expected + 1;
		if (!remoteCommit) {
			// 没有 Go 写入口（单测/离线 demo）：保留旧的本地事务语义。
			return update(() => next, expected);
		}
		let response = null;
		try {
			response = await remoteCommit({ operation, expectedRevision: expected, candidate: next });
		} catch (error) {
			throw new PluginError('plugin_state_unavailable', String(error && error.message || '插件状态写入失败'));
		}
		const body = response && (response.body || response.data) || null;
		if (!response || response.ok !== true) {
			const status = Number(response && response.status) || 0;
			const code = status === 0
				? 'plugin_state_unavailable'
				: (body && typeof body.error === 'string' && body.error)
					|| (response && response.errorCode && !String(response.errorCode).startsWith('http_') ? response.errorCode : 'plugin_state_unavailable');
			const failure = new PluginError(code, (body && body.message) || code);
			if (body && Number.isSafeInteger(Number(body.revision))) failure.revision = Number(body.revision);
			throw failure;
		}
		const revision = Number(body && body.revision);
		if (!Number.isSafeInteger(revision) || revision <= expected) {
			throw new PluginError('plugin_state_invalid', 'Go 返回的 revision 非法');
		}
		return { ...next, revision };
	}

	return {
		aiHomeDir,
		path: pathImpl,
		get,
		update,
		commitRemote,
		key: PLUGIN_STATE_KEY,
	};
}

module.exports = { EMPTY_STATE, PLUGIN_STATE_KEY, createPluginStateStore, normalizeState };
