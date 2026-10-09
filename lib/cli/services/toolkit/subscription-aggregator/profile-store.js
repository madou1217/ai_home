'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { atomicWritePrivateFile } = require('../proxy-pool/secure-file-io');
const { resolveProxyPoolAiHome } = require('../proxy-pool/aih-home');
const { normalizeProfile, profileError } = require('./profile-schema');

const STORE_VERSION = 1;
const STORE_FILE_NAME = 'subscription-aggregator.json';

function generateProfileId() {
  return `agg_${crypto.randomBytes(6).toString('hex')}`;
}

// 订阅链接即凭据：32 字节随机数，URL 安全编码。
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokensEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 聚合配置的持久化：单个私有 JSON 文件，只在写入时创建（读不落盘）。
 * 订阅源与节点不在这里，它们的唯一来源是代理节点库。
 */
class SubscriptionAggregatorStore {
  constructor(options = {}) {
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.filePath = options.filePath
      || this.path.join(resolveProxyPoolAiHome(options), STORE_FILE_NAME);
    this.now = options.now || (() => Date.now());
  }

  _read() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: STORE_VERSION, profiles: [] };
      throw error;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      throw profileError('aggregator_store_corrupted');
    }
    return {
      version: STORE_VERSION,
      profiles: Array.isArray(data?.profiles) ? data.profiles : []
    };
  }

  _write(data) {
    atomicWritePrivateFile(this.fs, this.path, this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  listProfiles() {
    return this._read().profiles.map((profile) => ({ ...profile }));
  }

  getProfile(profileId) {
    return this.listProfiles().find((profile) => profile.id === profileId) || null;
  }

  findProfileByToken(token) {
    return this.listProfiles().find((profile) => tokensEqual(profile.token, token)) || null;
  }

  saveProfile(input = {}) {
    const data = this._read();
    const requestedId = String(input?.id || '').trim();
    const index = requestedId ? data.profiles.findIndex((profile) => profile.id === requestedId) : -1;
    if (requestedId && index === -1) throw profileError('aggregator_profile_not_found');
    const existing = index === -1
      ? { id: generateProfileId(), token: generateToken(), createdAt: this.now() }
      : data.profiles[index];
    const profile = normalizeProfile(input, existing, this.now());
    if (index === -1) data.profiles.push(profile);
    else data.profiles[index] = profile;
    this._write(data);
    return { ...profile };
  }

  deleteProfile(profileId) {
    const data = this._read();
    const next = data.profiles.filter((profile) => profile.id !== profileId);
    if (next.length === data.profiles.length) return false;
    this._write({ ...data, profiles: next });
    return true;
  }

  rotateToken(profileId) {
    const data = this._read();
    const profile = data.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw profileError('aggregator_profile_not_found');
    profile.token = generateToken();
    profile.updatedAt = this.now();
    this._write(data);
    return { ...profile };
  }
}

let defaultStore = null;

function getSubscriptionAggregatorStore(options) {
  if (options) return new SubscriptionAggregatorStore(options);
  if (!defaultStore) defaultStore = new SubscriptionAggregatorStore();
  return defaultStore;
}

module.exports = {
  STORE_FILE_NAME,
  SubscriptionAggregatorStore,
  getSubscriptionAggregatorStore,
  tokensEqual
};
