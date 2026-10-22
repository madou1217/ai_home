'use strict';

// 账号生命周期插件（P4）：宿主执行、插件只产出 JSON。
//
// 四个能力：
//   account.source       —— 列出该 provider 现在可用的认证来源（collect）
//   account.login        —— 交互式登录任务（设备码 / 浏览器回调 / 粘贴凭据）
//   account.refresh      —— 刷新既有凭据（先 match、命中才把凭据交给插件）
//   account.materialize  —— 把账号凭据物化成 provider CLI 期望的投影文件
//
// 插件永远拿不到 accountRef 的分配权、数据库写权或任意路径写权：
// 账号判重/入库统一走 registerProviderAuthProjection，
// 文件只能写进宿主指定的 runtimeDir（相对路径、禁止 ..、禁止绝对路径）。
// 登录任务持久化的是公开状态（设备码、过期时间、插件侧 jobId），**不落凭据**。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  normalizeLoginResult,
  normalizeMaterializeResult,
  normalizeProjectionFiles,
  normalizeProvider,
  normalizeRefreshResult,
  normalizeSourceListResult,
  writeProjectionFiles
} = require('./contract');
const { registerProviderAuthProjection } = require('../../account/native-auth-projection');
const { resolveLoginRuntimeDir } = require('../../runtime/aih-storage-layout');
const { PluginError, requireCondition } = require('../sdk/errors');

const DEFAULT_LIST_TIMEOUT_MS = 5000;
const DEFAULT_LOGIN_TIMEOUT_MS = 15000;
const DEFAULT_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_JOBS = 100;
const JOB_FILE = 'account-login-jobs.json';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function invokeValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

function createAccountPluginService(options = {}) {
  const runtime = options.runtime || null;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Math.max(30_000, Number(options.jobTtlMs) || DEFAULT_JOB_TTL_MS);
  const fsImpl = options.fs || fs;
  const pluginPath = options.path || path;
  const timers = options.timers || { setTimeout, clearTimeout };
  const audit = options.audit && typeof options.audit.append === 'function' ? options.audit : null;
  const jobFile = aiHomeDir ? pluginPath.join(aiHomeDir, 'plugins', JOB_FILE) : '';
  const jobs = new Map();
  let cleanupTimer = null;

  function auditAccount(event, details = {}) {
    try { audit?.append(event, details); } catch (_error) { /* 审计失败不阻断账号操作 */ }
  }

  function readJobs() {
    if (!jobFile || !fsImpl.existsSync(jobFile)) return;
    let document = null;
    try { document = JSON.parse(fsImpl.readFileSync(jobFile, 'utf8')); } catch (_error) { return; }
    const list = Array.isArray(document && document.jobs) ? document.jobs : [];
    for (const item of list) {
      if (!item || !item.jobId || !item.provider || !item.pluginJobId || !item.contributionId) continue;
      if (Number(item.expiresAt) > 0 && Number(item.expiresAt) <= now()) continue;
      jobs.set(item.jobId, item);
    }
  }

  function persistJobs() {
    if (!jobFile) return;
    try {
      fsImpl.mkdirSync(pluginPath.dirname(jobFile), { recursive: true, mode: 0o700 });
      const list = [...jobs.values()].slice(-MAX_JOBS);
      const temp = `${jobFile}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, jobs: list }, null, 2)}\n`, { mode: 0o600 });
      fsImpl.renameSync(temp, jobFile);
    } catch (_error) { /* 任务持久化失败不阻断登录；内存状态仍可用 */ }
  }

  function pruneExpired() {
    const current = now();
    let changed = false;
    for (const [jobId, job] of jobs) {
      if (job.status !== 'waiting_user') continue;
      if (job.expiresAt > 0 && job.expiresAt <= current) {
        jobs.set(jobId, { ...job, status: 'expired', updatedAt: current, error: '设备码/登录任务已过期' });
        changed = true;
      }
    }
    if (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.values()].sort((left, right) => Number(left.createdAt) - Number(right.createdAt))
        .slice(0, jobs.size - MAX_JOBS);
      for (const item of oldest) jobs.delete(item.jobId);
      changed = true;
    }
    if (changed) persistJobs();
  }

  function ensureCleanupTimer() {
    if (cleanupTimer || typeof timers.setInterval !== 'function') return;
    cleanupTimer = timers.setInterval(pruneExpired, 60_000);
    cleanupTimer?.unref?.();
  }

  function close() {
    if (cleanupTimer) timers.clearInterval?.(cleanupTimer);
    cleanupTimer = null;
  }

  function activeLease() {
    if (!runtime || typeof runtime.acquire !== 'function') return null;
    return runtime.acquire();
  }

  async function invokeContribution(lease, contributionId, value, timeoutMs) {
    if (!runtime || typeof runtime.invoke !== 'function') {
      throw new PluginError('plugin_runtime_inactive', '插件运行时未启动');
    }
    const result = await runtime.invoke(contributionId, value, {
      generation: lease ? lease.generation : undefined,
      timeoutMs
    });
    return invokeValue(result);
  }

  function contributionList(snapshot, capability) {
    return snapshot && snapshot.byCapability ? (snapshot.byCapability.get(capability) || []) : [];
  }

  /** 运行投影的乐观 CAS 指纹：任何并发写入（另一个 CLI/daemon）都会改变它。 */
  function assertHostRuntimeDir(runtimeDir) {
    const root = normalizeText(runtimeDir);
    requireCondition(root, 'account_plugin_runtime_dir_missing');
    if (!aiHomeDir) return root;
    const home = pluginPath.resolve(aiHomeDir);
    const target = pluginPath.resolve(root);
    const relative = pluginPath.relative(home, target);
    requireCondition(relative && !relative.startsWith('..') && !pluginPath.isAbsolute(relative),
      'account_plugin_runtime_dir_outside_home', 'runtimeDir 必须在 AIH_HOME_DIR 内');
    return target;
  }

  function runtimeDigest(root) {
    if (!root || !fsImpl.existsSync(root)) return '';
    const hash = crypto.createHash('sha256');
    const walk = (dir) => {
      let entries = [];
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_error) { return; }
      entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
      for (const entry of entries) {
        const target = pluginPath.join(dir, entry.name);
        hash.update(pluginPath.relative(root, target));
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) {
          try { hash.update(fsImpl.readFileSync(target)); } catch (_error) { hash.update('unreadable'); }
        }
      }
    };
    walk(root);
    return hash.digest('hex');
  }

  function providerMatches() {
    // 插件贡献项没有 provider 目标字段；来源/登录/刷新都通过「列表或 match 阶段」自行声明，
    // 宿主不维护 provider 中央清单，也不把 provider 名写进派发代码。
    return true;
  }

  /**
   * 列出该 provider 的插件来源。每个来源保留 pluginInstanceId / pluginContributionId，
   * 后续登录与导入据此定位确切贡献项，不按插件名猜测。
   */
  async function listSources(provider, listOptions = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const lease = activeLease();
    if (!lease) return { sources: [], warnings: [], generation: 0 };
    const warnings = [];
    const sources = [];
    try {
      const chain = contributionList(lease.snapshot, 'account.source');
      for (const item of chain) {
        try {
          const result = await invokeContribution(lease, item.id, {
            schemaVersion: 1,
            kind: 'list',
            provider: normalizedProvider,
            host: listOptions.host || null
          }, Math.max(500, Number(listOptions.timeoutMs) || DEFAULT_LIST_TIMEOUT_MS));
          const normalized = normalizeSourceListResult(result, {
            instanceId: item.instanceId,
            contributionId: item.id,
            provider: normalizedProvider
          });
          for (const source of normalized) {
            // 同一来源 id 已被前面的插件占用时拒绝后者，避免「导入时按 id 找到别的插件」。
            if (sources.some((existing) => existing.id === source.id)) {
              warnings.push({ code: 'account_source_duplicate', contributionId: item.id, detail: source.id });
              continue;
            }
            let loginAvailable = false;
            try {
              loginAvailable = Boolean(findLoginContribution(lease.snapshot, source));
            } catch (error) {
              warnings.push({
                code: error && error.code || 'account_login_contribution_missing',
                contributionId: item.id,
                detail: source.id
              });
            }
            sources.push(Object.freeze({ ...source, loginAvailable }));
          }
        } catch (error) {
          warnings.push({
            code: error && error.code || 'account_source_failed',
            contributionId: item.id,
            detail: normalizeText(error && error.message)
          });
          if (item.failurePolicy === 'deny' && !listOptions.allowSourceFailure) {
            // 列表阶段仍返回其他插件的来源，但把失败明确交给调用方判断（doctor / UI 可见）。
            warnings.push({ code: 'account_source_chain_degraded', contributionId: item.id });
          }
        }
      }
      return { sources, warnings, generation: lease.generation };
    } finally {
      lease.release();
    }
  }

  function findLoginContribution(snapshot, source) {
    const chain = contributionList(snapshot, 'account.login');
    if (!chain.length) return null;
    const requested = normalizeText(source.loginContribution);
    if (requested) {
      const exact = chain.find((item) => item.id === requested);
      if (!exact) throw new PluginError('account_login_contribution_missing', `登录贡献项不存在：${requested}`);
      return exact;
    }
    // 默认认「同一插件实例内的第一个 account.login」：来源与登录通常同包提供，
    // 但插件仍可显式声明 loginContribution 来复用另一个登录实现。
    return chain.find((item) => item.instanceId === source.pluginInstanceId) || null;
  }

  async function registerRuntimeProjection(provider, runtimeDir, runtimeOptions = {}) {
    const registration = registerProviderAuthProjection(fsImpl, runtimeDir, provider, {
      path: pluginPath,
      aiHomeDir,
      ...(runtimeOptions.accountRef ? { accountRef: runtimeOptions.accountRef } : {}),
      ...(runtimeOptions.projectionMetadata ? { projectionMetadata: runtimeOptions.projectionMetadata } : {}),
      ...(runtimeOptions.respectDeletion === true ? { respectDeletion: true } : {})
    });
    if (!registration || !registration.registered) {
      const reason = registration && registration.reason || 'unknown';
      // 删除墓碑是用户意图，不能笼统报成注册失败：界面据此提示「已删除的账号不会自动复活」。
      const code = reason === 'account_deleted_by_user' ? 'account_deleted_by_user' : 'account_plugin_registration_failed';
      const error = new PluginError(code, code === 'account_deleted_by_user'
        ? '该账号已被用户删除，自动导入不会复活它；如需重新使用请显式登录'
        : `账号注册失败：${reason}`);
      error.reason = reason;
      throw error;
    }
    return registration;
  }

  /**
   * 登录/刷新只返回 credential 时，由同插件实例的 account.materialize 产出投影文件。
   * 这是 P4 的分工：登录插件不直接写 runtime dir，物化是单独能力。
   */
  async function materializeCredential(lease, input = {}) {
    if (input.credential && Array.isArray(input.credential.files)) {
      return { files: normalizeProjectionFiles(input.credential.files), removed: [] };
    }
    const chain = contributionList(lease.snapshot, 'account.materialize')
      .filter((item) => !input.instanceId || item.instanceId === input.instanceId);
    for (const item of chain) {
      try {
        const match = invokeValue(await invokeContribution(lease, item.id, {
          schemaVersion: 1,
          kind: 'match',
          provider: input.provider
        }, 3000));
        if (!match || match.handles !== true) continue;
        const result = normalizeMaterializeResult(invokeValue(await invokeContribution(lease, item.id, {
          schemaVersion: 1,
          kind: 'materialize',
          provider: input.provider,
          accountRef: input.accountRef || '',
          credential: input.credential || null,
          runtimeDir: input.runtimeDir || ''
        }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
        if (result.handled && result.files.length) return { files: result.files, removed: result.removed };
      } catch (error) {
        return { files: [], removed: [], error };
      }
    }
    return { files: [], removed: [] };
  }

  async function sourceFiles(lease, source, result, input = {}) {
    if (Array.isArray(result)) {
      return { files: normalizeProjectionFiles(result), removed: [] };
    }
    if (Array.isArray(result && result.files) && result.files.length) {
      return { files: normalizeProjectionFiles(result.files), removed: [] };
    }
    if (result && result.credential) {
      return materializeCredential(lease, {
        provider: source.provider,
        instanceId: source.pluginInstanceId,
        accountRef: input.accountRef || '',
        credential: result.credential,
        runtimeDir: input.runtimeDir || ''
      });
    }
    if (source.credential && Array.isArray(source.credential.files) && source.credential.files.length) {
      return { files: normalizeProjectionFiles(source.credential.files), removed: [] };
    }
    if (source.credential) {
      return materializeCredential(lease, {
        provider: source.provider,
        instanceId: source.pluginInstanceId,
        accountRef: input.accountRef || '',
        credential: source.credential,
        runtimeDir: input.runtimeDir || ''
      });
    }
    return { files: [], removed: [] };
  }

  /**
   * 直接导入：来源声明 directImport 时，插件返回投影文件，宿主写入并走既有注册链路。
   */
  async function importSource(input = {}) {
    const provider = normalizeProvider(input.provider);
    const sourceId = normalizeText(input.sourceId);
    requireCondition(sourceId, 'account_source_id_required');
    const lease = activeLease();
    if (!lease) return { ok: false, code: 'plugin_runtime_inactive' };
    try {
      const chain = contributionList(lease.snapshot, 'account.source');
      const listing = await listSources(provider);
      const source = (listing.sources || []).find((item) => item.id === sourceId) || null;
      if (!source) return { ok: false, code: 'auth_source_unknown', warnings: listing.warnings };
      if (!source.available) return { ok: false, code: 'auth_source_unavailable', source };
      if (!source.directImport) return { ok: false, code: 'auth_source_requires_login_job', source };
      const contribution = chain.find((item) => item.id === source.pluginContributionId);
      if (!contribution) return { ok: false, code: 'auth_source_impl_missing', source };
      const runtimeDir = input.runtimeDir
        ? assertHostRuntimeDir(input.runtimeDir)
        : resolveLoginRuntimeDir(aiHomeDir, provider,
          `plugin-${crypto.randomBytes(6).toString('hex')}`);
      if (!runtimeDir) return { ok: false, code: 'invalid_login_runtime' };
      fsImpl.mkdirSync(runtimeDir, { recursive: true });
      const result = invokeValue(await invokeContribution(lease, contribution.id, {
        schemaVersion: 1,
        kind: 'import',
        provider,
        sourceId
      }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS));
      const materialized = await sourceFiles(lease, source, result, { runtimeDir });
      if (!materialized.files.length) return { ok: false, code: 'account_plugin_files_missing', source };
      writeProjectionFiles(fsImpl, runtimeDir, materialized.files, { remove: result && result.removed });
      // 来源扫描属于自动观察语义：用户删除过的账号不能被下一次扫描复活。
      const registration = await registerRuntimeProjection(provider, runtimeDir, { ...input, respectDeletion: true });
      auditAccount('account_import', { provider, sourceId, accountRef: registration.accountRef, files: materialized.files.length });
      return {
        ok: true,
        accountRef: registration.accountRef,
        cliAccountId: registration.cliAccountId,
        sourceId,
        runtimeDir
      };
    } catch (error) {
      return { ok: false, code: error && error.code || 'account_plugin_import_failed', detail: normalizeText(error && error.message) };
    } finally {
      lease.release();
    }
  }

  function publicJob(job) {
    return {
      jobId: job.jobId,
      provider: job.provider,
      sourceId: job.sourceId,
      authMode: job.authMode,
      status: job.status,
      message: job.message || '',
      verificationUri: job.verificationUri || '',
      verificationUriComplete: job.verificationUriComplete || '',
      userCode: job.userCode || '',
      authorizationUrl: job.authorizationUrl || '',
      redirectUri: job.redirectUri || '',
      intervalMs: Number(job.intervalMs) || 5000,
      canSubmit: job.canSubmit === true,
      submitLabel: job.submitLabel || '',
      submitPlaceholder: job.submitPlaceholder || '',
      expiresAt: Number(job.expiresAt) || 0,
      createdAt: Number(job.createdAt) || 0,
      updatedAt: Number(job.updatedAt) || 0,
      accountRef: job.accountRef || '',
      cliAccountId: job.cliAccountId || '',
      error: job.error || ''
    };
  }

  async function finishLoginJob(job, result, lease) {
    let files = Array.isArray(result.files) ? result.files : [];
    let removed = [];
    if (!files.length && result.credential) {
      const materialized = await materializeCredential(lease, {
        provider: job.provider,
        instanceId: job.instanceId,
        credential: result.credential,
        runtimeDir: job.runtimeDir
      });
      files = materialized.files;
      removed = materialized.removed;
    }
    if (!files.length) {
      return failLoginJob(job, 'account_plugin_files_missing', '登录成功但插件没有返回投影文件');
    }
    try {
      fsImpl.mkdirSync(job.runtimeDir, { recursive: true });
      writeProjectionFiles(fsImpl, job.runtimeDir, files, { remove: removed });
      const registration = await registerRuntimeProjection(job.provider, job.runtimeDir);
      const next = {
        ...job,
        status: 'success',
        accountRef: registration.accountRef,
        cliAccountId: registration.cliAccountId || '',
        pluginJobId: '',
        updatedAt: now(),
        expiresAt: 0
      };
      jobs.set(job.jobId, next);
      persistJobs();
      auditAccount('account_login', {
        provider: job.provider,
        sourceId: job.sourceId,
        accountRef: next.accountRef,
        status: next.status
      });
      return publicJob(next);
    } catch (error) {
      return failLoginJob(job, error && error.code || 'account_plugin_registration_failed',
        normalizeText(error && error.message));
    }
  }

  function failLoginJob(job, code, message) {
    const next = {
      ...job,
      status: 'failed',
      error: `${code}${message ? `：${message}` : ''}`,
      pluginJobId: '',
      updatedAt: now(),
      expiresAt: 0
    };
    jobs.set(job.jobId, next);
    persistJobs();
    auditAccount('account_login', {
      provider: job.provider,
      sourceId: job.sourceId,
      accountRef: next.accountRef,
      status: next.status,
      error: next.error
    });
    return publicJob(next);
  }

  /**
   * 开始登录。返回的 jobId 是宿主 id；后续 poll 会带上插件侧 jobId。
   */
  async function startLogin(input = {}) {
    const provider = normalizeProvider(input.provider);
    const sourceId = normalizeText(input.sourceId);
    requireCondition(sourceId, 'account_source_id_required');
    const lease = activeLease();
    if (!lease) {
      const error = new PluginError('plugin_runtime_inactive', '插件运行时未启动');
      error.code = 'plugin_runtime_inactive';
      throw error;
    }
    try {
      const listing = await listSources(provider);
      const source = (listing.sources || []).find((item) => item.id === sourceId) || null;
      if (!source) throw new PluginError('auth_source_unknown', `未知认证来源：${sourceId}`);
      if (!source.available) throw new PluginError('auth_source_unavailable', '认证来源当前不可用');
      const loginContribution = findLoginContribution(lease.snapshot, source);
      if (!loginContribution) throw new PluginError('account_login_unsupported', '来源没有对应的登录插件');
      const runtimeDir = input.runtimeDir
        ? assertHostRuntimeDir(input.runtimeDir)
        : resolveLoginRuntimeDir(aiHomeDir, provider,
          `plugin-${crypto.randomBytes(6).toString('hex')}`);
      if (!runtimeDir) throw new PluginError('invalid_login_runtime');
      fsImpl.mkdirSync(runtimeDir, { recursive: true });
      const result = normalizeLoginResult(invokeValue(await invokeContribution(lease, loginContribution.id, {
        schemaVersion: 1,
        kind: 'start',
        provider,
        sourceId,
        runtimeDir
      }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
      const jobId = crypto.randomUUID();
      const createdAt = now();
      let job = {
        jobId,
        provider,
        sourceId,
        authMode: source.authMode,
        contributionId: loginContribution.id,
        instanceId: loginContribution.instanceId,
        pluginJobId: result.jobId || jobId,
        runtimeDir,
        status: result.status,
        message: result.message,
        verificationUri: result.verificationUri,
        verificationUriComplete: result.verificationUriComplete,
        userCode: result.userCode,
        authorizationUrl: result.authorizationUrl,
        redirectUri: result.redirectUri,
        intervalMs: result.intervalMs,
        canSubmit: result.canSubmit,
        submitLabel: result.submitLabel,
        submitPlaceholder: result.submitPlaceholder,
        createdAt,
        updatedAt: createdAt,
        expiresAt: result.expiresAt > 0 ? Math.min(result.expiresAt, createdAt + ttlMs) : createdAt + ttlMs,
        accountRef: '',
        cliAccountId: '',
        error: ''
      };
      if (result.status === 'success') {
        job = { ...job, pluginJobId: '' };
        jobs.set(jobId, job);
        persistJobs();
        return finishLoginJob(job, result, lease);
      }
      if (result.status === 'failed') {
        job = { ...job, status: 'failed', error: result.message || '登录失败' };
      }
      jobs.set(jobId, job);
      persistJobs();
      ensureCleanupTimer();
      return publicJob(job);
    } finally {
      lease.release();
    }
  }

  async function pollLogin(jobId, pollOptions = {}) {
    pruneExpired();
    const job = jobs.get(normalizeText(jobId));
    if (!job) {
      const error = new PluginError('account_login_job_not_found', '登录任务不存在或已过期');
      error.statusCode = 404;
      throw error;
    }
    if (job.status !== 'waiting_user') return publicJob(job);
    if (job.expiresAt > 0 && job.expiresAt <= now()) {
      return failLoginJob(job, 'expired', '登录任务已过期');
    }
    const lease = activeLease();
    if (!lease) throw new PluginError('plugin_runtime_inactive', '插件运行时未启动');
    try {
      const result = normalizeLoginResult(invokeValue(await invokeContribution(lease, job.contributionId, {
        schemaVersion: 1,
        kind: 'poll',
        provider: job.provider,
        sourceId: job.sourceId,
        jobId: job.pluginJobId,
        runtimeDir: job.runtimeDir
      }, Number(pollOptions.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
      if (result.status === 'success') {
        return finishLoginJob({ ...job, ...publicLoginFields(result) }, result, lease);
      }
      if (result.status === 'failed') {
        return failLoginJob({ ...job, ...publicLoginFields(result) },
          'account_login_failed', result.message);
      }
      const next = {
        ...job,
        ...publicLoginFields(result, job),
        pluginJobId: result.jobId || job.pluginJobId,
        status: 'waiting_user',
        updatedAt: now()
      };
      jobs.set(job.jobId, next);
      persistJobs();
      return publicJob(next);
    } finally {
      lease.release();
    }
  }

  /**
   * 把用户粘贴的授权码 / 回调地址 / token 交给插件。
   *
   * 这是登录任务的第三个动词（start / poll / submit），提交值只在本次调用中存在：
   * 不写 job 文件、不写审计、不返回给前端。插件成功时仍必须返回投影文件或 credential，
   * 由宿主完成物化和注册。
   */
  async function submitLogin(jobId, input = {}) {
    pruneExpired();
    const job = jobs.get(normalizeText(jobId));
    if (!job) {
      const error = new PluginError('account_login_job_not_found', '登录任务不存在或已过期');
      error.statusCode = 404;
      throw error;
    }
    if (job.status !== 'waiting_user') return publicJob(job);
    if (job.expiresAt > 0 && job.expiresAt <= now()) {
      return failLoginJob(job, 'expired', '登录任务已过期');
    }
    const value = normalizeText(input.value);
    requireCondition(value, 'account_login_submit_value_required');
    requireCondition(Buffer.byteLength(value, 'utf8') <= 128 * 1024,
      'account_login_submit_value_too_large');
    requireCondition(job.canSubmit === true, 'account_login_submit_unsupported');
    const lease = activeLease();
    if (!lease) throw new PluginError('plugin_runtime_inactive', '插件运行时未启动');
    try {
      const result = normalizeLoginResult(invokeValue(await invokeContribution(lease, job.contributionId, {
        schemaVersion: 1,
        kind: 'submit',
        provider: job.provider,
        sourceId: job.sourceId,
        jobId: job.pluginJobId,
        runtimeDir: job.runtimeDir,
        value
      }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
      auditAccount('account_login_submit', {
        provider: job.provider,
        sourceId: job.sourceId,
        jobId: job.jobId,
        status: result.status
      });
      if (result.status === 'success') {
        return finishLoginJob({ ...job, ...publicLoginFields(result, job) }, result, lease);
      }
      if (result.status === 'failed') {
        return failLoginJob({ ...job, ...publicLoginFields(result, job) },
          'account_login_failed', result.message);
      }
      const next = {
        ...job,
        ...publicLoginFields(result, job),
        pluginJobId: result.jobId || job.pluginJobId,
        status: 'waiting_user',
        updatedAt: now()
      };
      jobs.set(job.jobId, next);
      persistJobs();
      return publicJob(next);
    } finally {
      lease.release();
    }
  }

  function publicLoginFields(result, previous = {}) {
    return {
      message: result.message,
      verificationUri: result.verificationUri || '',
      verificationUriComplete: result.verificationUriComplete || '',
      userCode: result.userCode || '',
      authorizationUrl: result.authorizationUrl || '',
      redirectUri: result.redirectUri || '',
      intervalMs: result.intervalMs,
      // poll/submit 没重新声明时沿用 start 的能力，避免一轮轮询把粘贴入口抹掉。
      canSubmit: result.canSubmit === true || previous.canSubmit === true,
      submitLabel: result.submitLabel || previous.submitLabel || '',
      submitPlaceholder: result.submitPlaceholder || previous.submitPlaceholder || ''
    };
  }

  async function cancelLogin(jobId) {
    const job = jobs.get(normalizeText(jobId));
    if (!job) {
      const error = new PluginError('account_login_job_not_found', '登录任务不存在');
      error.statusCode = 404;
      throw error;
    }
    if (job.status === 'waiting_user' && job.pluginJobId) {
      const lease = activeLease();
      if (lease) {
        try {
          await invokeContribution(lease, job.contributionId, {
            schemaVersion: 1,
            kind: 'cancel',
            provider: job.provider,
            sourceId: job.sourceId,
            jobId: job.pluginJobId
          }, 3000);
        } catch (_error) { /* 取消失败不影响本地任务终止 */ } finally {
          lease.release();
        }
      }
    }
    const next = { ...job, status: 'cancelled', error: '', pluginJobId: '', updatedAt: now(), expiresAt: 0 };
    jobs.set(job.jobId, next);
    persistJobs();
    auditAccount('account_login', {
      provider: job.provider,
      sourceId: job.sourceId,
      accountRef: next.accountRef,
      status: 'cancelled'
    });
    return publicJob(next);
  }

  function getLoginJob(jobId) {
    const job = jobs.get(normalizeText(jobId));
    return job ? publicJob(job) : null;
  }

  /**
   * 刷新：先 match 再交凭据，避免把凭据广播给无关插件。
   */
  async function refresh(input = {}) {
    const provider = normalizeProvider(input.provider);
    const accountRef = normalizeText(input.accountRef);
    requireCondition(accountRef, 'account_ref_required');
    const lease = activeLease();
    if (!lease) return { handled: false, reason: 'plugin_runtime_inactive' };
    try {
      for (const item of contributionList(lease.snapshot, 'account.refresh')) {
        try {
          const match = invokeValue(await invokeContribution(lease, item.id, {
            schemaVersion: 1,
            kind: 'match',
            provider
          }, 3000));
          if (!match || match.handles !== true) continue;
          const runtimeDir = input.runtimeDir ? assertHostRuntimeDir(input.runtimeDir) : '';
          const digestBefore = runtimeDir ? runtimeDigest(runtimeDir) : '';
          const result = normalizeRefreshResult(invokeValue(await invokeContribution(lease, item.id, {
            schemaVersion: 1,
            kind: 'refresh',
            provider,
            accountRef,
            credential: input.credential || null,
            consumedRefreshToken: input.consumedRefreshToken || (input.credential && input.credential.refreshToken) || '',
            runtimeDir
          }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
          if (!result || !result.handled) return { handled: false, contributionId: item.id, reason: 'not_handled' };
          let files = result.files;
          let removed = [];
          if (!files.length && result.credential) {
            const materialized = await materializeCredential(lease, {
              provider,
              instanceId: item.instanceId,
              accountRef,
              credential: result.credential,
              runtimeDir
            });
            files = materialized.files;
            removed = materialized.removed;
          }
          let registration = null;
          if (runtimeDir && files.length) {
            // 并发写回防线：插件执行期间投影被另一条刷新链改动时，放弃覆盖并让上层重读。
            if (input.cas !== false && digestBefore && runtimeDigest(runtimeDir) !== digestBefore) {
              return {
                handled: false,
                contributionId: item.id,
                reason: 'account_refresh_conflict',
                cas: false
              };
            }
            writeProjectionFiles(fsImpl, runtimeDir, files, { remove: removed });
            registration = await registerRuntimeProjection(provider, runtimeDir, { accountRef });
          }
          auditAccount('account_refresh', {
            provider,
            accountRef,
            contributionId: item.id,
            files: files.length,
            rotated: result.rotated === true
          });
          return {
            handled: true,
            contributionId: item.id,
            files: files.map((file) => file.path),
            rotated: result.rotated,
            expiresAt: result.expiresAt,
            registration
          };
        } catch (error) {
          return {
            handled: false,
            contributionId: item.id,
            reason: error && error.code || 'account_refresh_failed',
            detail: normalizeText(error && error.message)
          };
        }
      }
      return { handled: false, reason: 'no_matching_plugin' };
    } finally {
      lease.release();
    }
  }

  /**
   * 物化：插件返回投影文件；宿主只写 runtimeDir，并支持显式移除旧文件。
   */
  async function materialize(input = {}) {
    const provider = normalizeProvider(input.provider);
    const runtimeDir = normalizeText(input.runtimeDir) ? assertHostRuntimeDir(input.runtimeDir) : '';
    const lease = activeLease();
    if (!lease) return { handled: false, reason: 'plugin_runtime_inactive' };
    try {
      for (const item of contributionList(lease.snapshot, 'account.materialize')) {
        try {
          const match = invokeValue(await invokeContribution(lease, item.id, {
            schemaVersion: 1,
            kind: 'match',
            provider
          }, 3000));
          if (!match || match.handles !== true) continue;
          const result = normalizeMaterializeResult(invokeValue(await invokeContribution(lease, item.id, {
            schemaVersion: 1,
            kind: 'materialize',
            provider,
            accountRef: normalizeText(input.accountRef),
            credential: input.credential || null,
            runtimeDir
          }, Number(input.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS)));
          if (!result.handled) return { handled: false, contributionId: item.id };
          writeProjectionFiles(fsImpl, runtimeDir, result.files, { remove: result.removed });
          // 只记文件数量与贡献点，不记任何凭据内容。
          auditAccount('account_materialize', {
            provider,
            accountRef: normalizeText(input.accountRef),
            contributionId: item.id,
            files: result.files.length,
            removed: result.removed.length
          });
          return {
            handled: true,
            contributionId: item.id,
            files: result.files.map((file) => file.path),
            removed: result.removed
          };
        } catch (error) {
          return {
            handled: false,
            contributionId: item.id,
            reason: error && error.code || 'account_materialize_failed',
            detail: normalizeText(error && error.message)
          };
        }
      }
      return { handled: false, reason: 'no_matching_plugin' };
    } finally {
      lease.release();
    }
  }

  readJobs();
  ensureCleanupTimer();

  return {
    cancelLogin,
    close,
    getLoginJob,
    importSource,
    listSources,
    materialize,
    pollLogin,
    providerMatches,
    refresh,
    startLogin,
    submitLogin
  };
}

module.exports = {
  DEFAULT_JOB_TTL_MS,
  JOB_FILE,
  createAccountPluginService
};
