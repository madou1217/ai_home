'use strict';

const nodePath = require('node:path');

/**
 * BaseHostAccountSync —— 宿主登录态「自动入库」的统一契约（模板方法 + SPI）。
 *
 * 为什么存在：codex / codebuddy 家族 / cline 三块观察者过去各自手写一遍同样的骨架
 * （快照稳定性校验、来源缓存、并发 CAS、身份去重、事件队列、生命周期），每加一个
 * provider 就要复制一遍骨架，也复制一遍 bug —— 墓碑列表漏项、把「账号刚登记、投影
 * 还没落地」误判成不可用，都是这么来的。这里把骨架收敛进基类，子类只声明**差异**：
 *
 *   providers          覆盖哪些 provider（家族可多值）
 *   sourceFiles()      候选来源（宿主 HOME + 已登记账号的投影根，绝不递归发现备份）
 *   inspect()          这份文档算不算「可用的登录态」（格式 / 过期 / 准入）
 *   extractIdentity()  稳定身份种子（拿不到就拒绝，绝不铸兜底身份）
 *   compare()          代际比较：比不出来就不动库
 *   buildPayload()     入库载荷（按 provider 槽位收窄，绝不整文件写入）
 *
 * 基类独占（子类不得重写）：readSnapshot / scan / ingest / start / stop / getStats。
 * 去重不变量由基类保证：accountRef 由身份种子确定性派生、换过种子走 matchExisting 复用、
 * 写入只走 CAS 或 insert-if-missing、自动观察一律 respectDeletion（用户删掉的账号不会被
 * 后台轮询登记回来）。
 */
class BaseHostAccountSync {
  constructor(deps = {}) {
    this.deps = deps;
    this.fs = deps.fs;
    this.path = deps.path || nodePath;
    this.aiHomeDir = String(deps.aiHomeDir || '').trim();
    this.hostHomeDir = String(deps.hostHomeDir || '').trim();
    this.now = typeof deps.now === 'function' ? deps.now : Date.now;
    this.store = deps.store || require('../../server/account-credential-store');
    this.identify = deps.resolveIdentity || require('../account-identity').resolveNativeAuthIdentitySeed;
    this.register = deps.registerIdentity || require('../account-registration').registerAccountIdentity;
    this.insert = deps.insertIfMissing
      || require('../../server/account-credential-store-insert').insertAccountNativeAuthIfMissing;
    this.resolveAlias = deps.resolveCliAccountRef
      || require('../../server/account-ref-store').resolveCliAccountRef;
    this.setIntervalImpl = deps.setInterval || setInterval;
    this.clearIntervalImpl = deps.clearInterval || clearInterval;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.lastScan = { updated: [], skipped: [], scanned: 0 };
    this.pending = new Map();
    this.sourceCache = new Map();
  }

  // ---------- 子类必须实现 ----------

  /** @returns {string[]} 本同步器覆盖的 provider（家族可多值，第一个是默认 provider）。 */
  get providers() {
    throw new Error('BaseHostAccountSync: providers must be implemented');
  }

  /** @returns {Array<{file: string, label: string, provider?: string, accountRef?: string}>} */
  sourceFiles(_records, _options) {
    throw new Error('BaseHostAccountSync: sourceFiles must be implemented');
  }

  /** @returns {{usable: boolean, reason?: string, doc?: object}} */
  inspect(_doc, _ctx) {
    throw new Error('BaseHostAccountSync: inspect must be implemented');
  }

  /** @returns {string} 稳定身份种子；空串表示身份不可验证。 */
  extractIdentity(_doc, _provider) {
    throw new Error('BaseHostAccountSync: extractIdentity must be implemented');
  }

  /** @returns {{adopt: boolean, reason: string}} */
  compare(_current, _candidate, _ctx) {
    throw new Error('BaseHostAccountSync: compare must be implemented');
  }

  /** @returns {object} 下一个 nativeAuth 载荷。 */
  buildPayload(_current, _snapshot, _ctx) {
    throw new Error('BaseHostAccountSync: buildPayload must be implemented');
  }

  // ---------- 可选钩子（默认值即最保守语义） ----------

  get intervalMs() { return 3000; }
  get maxArtifactBytes() { return 4 * 1024 * 1024; }
  get missingReason() { return 'credential_file_missing'; }
  get unreadableReason() { return 'credential_file_unreadable'; }
  get unsupportedReason() { return 'unsupported_credential_file'; }
  get changedDuringReadReason() { return 'credential_file_changed_during_read'; }
  get tooLargeReason() { return 'credential_file_too_large'; }
  get unstableIdentityReason() { return 'stable_identity_unavailable'; }
  get syncFailureReason() { return 'host_account_sync_failed'; }
  /** 不算「跳过」的比较结果：界面不该为它们报噪音。 */
  get unchangedReasons() { return ['unchanged']; }

  /** 快照上的额外派生字段（例如展示用昵称）。 */
  describe(_doc) { return null; }
  /** 候选准入（例如「只认 OAuth 登录态，纯 API Key 文档不入库」）。 */
  admit(_doc, _ctx) { return { adopt: true }; }
  /** 进身份索引的库内记录（API Key 模式的记录不参与 OAuth 身份归并）。 */
  isPoolableRecord(record) {
    return Boolean(record) && this.providers.includes(record.provider);
  }
  /** 从库内记录取回它保存的文档。 */
  recordDocument(record) {
    return record && record.nativeAuth && record.nativeAuth.auth;
  }
  /** 早期身份规则可能铸过别的 accountRef：按 provider 自己的作用域匹配复用。 */
  matchExisting(_records, _snapshot) { return []; }
  /** 库内记录与本次观察冲突时拒绝写入（返回原因码）。 */
  guardCurrent(_current, _snapshot) { return null; }
  /** 一次观察要落到哪些账号（家族可一份凭据同时修多个 provider 账号）。 */
  targetsFor(snapshot) {
    return [{
      provider: snapshot.provider || this.providers[0],
      identitySeed: snapshot.identitySeed,
      accountRef: snapshot.accountRef || ''
    }];
  }
  registrationFor(snapshot) {
    return {
      provider: snapshot.provider || this.providers[0],
      identitySeed: snapshot.identitySeed,
      respectDeletion: true
    };
  }
  /** 来源可用性前置条件（缺 fs / aiHomeDir 时明确不扫，而不是伪装成「扫了没结果」）。 */
  isEnabled(options = {}) {
    if (!this.fs || !this.aiHomeDir) return false;
    return Boolean(this.hostHomeDir) || Array.isArray(options.files);
  }
  listRecords() {
    return this.store.listAccountCredentialRecords(this.fs, this.aiHomeDir, this.providers[0]);
  }
  /** scan 收尾（家族用它算「账号集合变了」）。 */
  finalizeScan(_result, _ctx) {}
  shouldNotify(_result) { return this.pending.size > 0; }
  skipEntry(reason, ctx = {}) {
    return {
      reason,
      provider: ctx.provider || this.providers[0],
      source: ctx.source,
      ...(ctx.accountRef ? { accountRef: ctx.accountRef } : {})
    };
  }
  // ---------- 模板方法：骨架，子类不得重写 ----------

  /**
   * 读一份来源的快照。三道门：读前 lstat 判定（普通文件 / 非符号链接 / 体积上限）、
   * 读后再次 lstat 的稳定性校验（读的过程中被换掉或追加就不采纳这一代）、
   * 以及子类的 inspect() 准入与 admit() 候选判定。stamp 未变则复用上次快照，
   * 轮询不会每次都 parse 同一份没变的文件。
   */
  readSnapshot(source) {
    const filePath = source.file;
    try {
      const before = this.fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > this.maxArtifactBytes) {
        return { reason: this.unsupportedReason };
      }
      const stamp = [before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':');
      const cached = this.sourceCache.get(filePath);
      if (cached && cached.stamp === stamp) return cached.snapshot;
      const raw = this.fs.readFileSync(filePath, 'utf8');
      const after = this.fs.lstatSync(filePath);
      if (before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return { reason: this.changedDuringReadReason };
      }
      if (Buffer.byteLength(raw) > this.maxArtifactBytes) return { reason: this.tooLargeReason };
      const parsed = JSON.parse(raw);
      const inspected = this.inspect(parsed, { source, nowMs: this.now() });
      if (!inspected || inspected.usable !== true) {
        return { reason: (inspected && inspected.reason) || this.unsupportedReason };
      }
      const doc = inspected.doc === undefined ? parsed : inspected.doc;
      const admission = this.admit(doc, { source, nowMs: this.now() });
      if (!admission || admission.adopt !== true) {
        return { reason: (admission && admission.reason) || this.unsupportedReason };
      }
      const provider = source.provider || this.providers[0];
      const identitySeed = String(this.extractIdentity(doc, provider) || '');
      if (!identitySeed) return { reason: this.unstableIdentityReason };
      const snapshot = { doc, identitySeed, provider, ...(this.describe(doc) || {}) };
      this.sourceCache.set(filePath, { stamp, snapshot });
      return snapshot;
    } catch (error) {
      this.sourceCache.delete(filePath);
      return { reason: error && error.code === 'ENOENT' ? this.missingReason : this.unreadableReason };
    }
  }
  /**
   * 单目标采纳：复用/登记账号 → 读库内当前 → 代际比较 → CAS 或 insert-if-missing → 回填别名。
   * 家族型同步（一份凭据同时修多个 provider 账号）覆盖 `ingest`，其余复用这里。
   */
  ingest(snapshot, matches, _source = {}) {
    const [target] = this.targetsFor(snapshot);
    const provider = target.provider;
    if (matches.length > 1) return { reason: 'ambiguous_existing_identity' };
    const registration = matches.length
      ? { accountRef: matches[0].accountRef, created: false }
      : this.register(this.fs, this.aiHomeDir, this.registrationFor({ ...snapshot, provider }));
    const accountRef = registration.accountRef;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.store.readAccountCredentialRecord(this.fs, this.aiHomeDir, accountRef);
      const conflict = this.guardCurrent(current, { ...snapshot, provider, accountRef });
      if (conflict) return { accountRef, reason: conflict };
      const decision = this.compare(this.recordDocument(current), snapshot.doc, { nowMs: this.now(), provider, accountRef });
      if (!decision || decision.adopt !== true) {
        return { accountRef, reason: (decision && decision.reason) || 'credential_not_newer' };
      }
      const next = this.buildPayload(current, { ...snapshot, provider, accountRef });
      const saved = current
        ? this.store.compareAndSwapAccountNativeAuth(this.fs, this.aiHomeDir, accountRef, current, next)
        : this.insert(this.fs, this.aiHomeDir, accountRef, next);
      if (saved) {
        const alias = this.resolveAlias(this.fs, this.aiHomeDir, accountRef, { bestEffort: true });
        return {
          accountRef,
          updated: true,
          created: registration.created === true,
          cliAccountId: (alias && alias.cliAccountId) || '',
          reason: decision.reason
        };
      }
      // 并发的登录/续期赢了这一轮：重读再判定，不做无条件覆盖（可能盖掉更新的一代）。
    }
    return { accountRef, reason: 'concurrent_credential_update' };
  }

  /** 一轮扫描：库内身份索引 → 逐个来源读快照 → 采纳 → 记账。 */
  scan(options = {}) {
    const result = { updated: [], skipped: [], scanned: 0 };
    if (!this.isEnabled(options)) return result;
    let records;
    try {
      records = this.listRecords();
    } catch (_) {
      return { ...result, skipped: [this.skipEntry('credential_store_unavailable')] };
    }
    const identities = new Map();
    for (const record of records) {
      if (!this.isPoolableRecord(record)) continue;
      const identity = String(this.extractIdentity(this.recordDocument(record), record.provider) || '');
      if (identity) identities.set(identity, [...(identities.get(identity) || []), record]);
    }
    const sources = this.sourceFiles(records, options);
    const paths = sources.map(source => source.file);
    for (const cachedPath of this.sourceCache.keys()) if (!paths.includes(cachedPath)) this.sourceCache.delete(cachedPath);
    for (const source of sources) {
      result.scanned += 1;
      const provider = source.provider || this.providers[0];
      const snapshot = this.readSnapshot(source);
      if (!snapshot.doc) {
        if (snapshot.reason !== this.missingReason) {
          result.skipped.push(this.skipEntry(snapshot.reason, { provider, source: source.label }));
        }
        continue;
      }
      try {
        const outcome = this.ingest(snapshot, identities.get(snapshot.identitySeed) || [], source);
        if (outcome.updated) {
          result.updated.push(outcome);
          this.pending.set(outcome.accountRef, outcome);
          // 同一轮里后续来源（同一账号的沙箱投影）按新身份参与比较。
          identities.set(snapshot.identitySeed, [{ accountRef: outcome.accountRef }]);
        } else if (!this.unchangedReasons.includes(outcome.reason)) {
          result.skipped.push(this.skipEntry(outcome.reason, { provider, source: source.label, accountRef: outcome.accountRef }));
        }
      } catch (error) {
        result.skipped.push(this.skipEntry(
          error && error.code === 'account_deleted_by_user' ? 'account_deleted_by_user' : 'credential_adoption_failed',
          { provider, source: source.label }
        ));
      }
    }
    this.lastScan = result;
    this.finalizeScan(result, { records, options });
    return result;
  }
  /** 起观察循环：立刻跑一轮（不等第一个 interval），随后按 intervalMs 轮询。 */
  start(options = {}) {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => {
      if (this.running || this.stopped) return;
      this.running = true;
      try {
        const result = this.scan();
        if (typeof options.onUpdated === 'function' && this.shouldNotify(result)) {
          const events = [...this.pending.values()];
          // 同步回调是契约（账号池重载是同步的）；重载抛错时事件继续排队，不吞掉。
          options.onUpdated(events);
          for (const event of events) this.pending.delete(event.accountRef);
        }
      } catch (_) {
        if (typeof options.onError === 'function') options.onError(this.syncFailureReason);
      } finally { this.running = false; }
    };
    tick();
    this.timer = this.setIntervalImpl(tick, Math.max(1000, Number(options.intervalMs) || this.intervalMs));
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  getStats() {
    return {
      scanned: this.lastScan.scanned,
      updated: this.lastScan.updated.length,
      skipped: this.lastScan.skipped,
      pending: this.pending.size
    };
  }
}

module.exports = { BaseHostAccountSync };
