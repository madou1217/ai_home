'use strict';

// 插件控制面用例：安装 / 卸载 / 启用 / 停用 / 列表 / 诊断 / 期望状态。
//
// 持久事实只有一份：app-state.db 里的 plugins.control.v1（已接受的制品 + 实例配置 + revision）。
// 运行中的代次是由它推导出来的观测状态，由 runtime-service 发布。启用/停用的顺序是
// 「在宿主里准备候选 → 以 expectedRevision 做 CAS 提交 → 激活」，提交冲突时旧代次继续服务。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const { acceptArtifact } = require('./artifact');
const { createPluginStateStore, normalizeState } = require('./state-store');
const { createPluginAuditLog } = require('./audit');
const { validateManifest } = require('../sdk/manifest');
const { PluginError, requireCondition } = require('../sdk/errors');

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 配置按插件清单的 configSchema 校验并补默认值；没有 schema 的插件不接受任何配置。
function validateInstanceConfiguration(manifest, configuration) {
  const value = configuration === undefined ? {} : clone(configuration);
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'plugin_config_invalid', '配置必须是 JSON 对象');
  if (!manifest.configSchema) {
    requireCondition(Object.keys(value).length === 0, 'plugin_config_unsupported', '该插件不接受配置');
    return value;
  }
  const validate = ajv.compile(manifest.configSchema);
  if (!validate(value)) {
    const detail = (validate.errors || []).map((item) => `${item.instancePath || '/'} ${item.message}`).join('；');
    throw new PluginError('plugin_config_invalid', `配置不符合插件的 configSchema：${detail}`);
  }
  return value;
}

function permissionFingerprint(manifest) {
  const permissions = manifest && manifest.permissions;
  if (!permissions) return '';
  return crypto.createHash('sha256').update(JSON.stringify(permissions)).digest('hex').slice(0, 16);
}

function hasDeclaredPermissions(manifest) {
  const permissions = manifest && manifest.permissions;
  if (!permissions) return false;
  return (permissions.network || []).length > 0
    || (permissions.secrets || []).length > 0
    || (permissions.environment || []).length > 0
    || (permissions.filesystem && ((permissions.filesystem.read || []).length > 0 || (permissions.filesystem.write || []).length > 0));
}

function createPluginControl(options = {}) {
  const aiHomeDir = path.resolve(text(options.aiHomeDir));
  const root = path.join(aiHomeDir, 'plugins');
  const roots = { acceptedDir: path.join(root, 'accepted'), extractedDir: path.join(root, 'extracted') };
  const store = options.stateStore || createPluginStateStore({ fs, aiHomeDir, remoteCommit: options.commitPluginState });
  const audit = options.audit || createPluginAuditLog({ aiHomeDir });
  const hostVersion = text(options.hostVersion) || '1.0.0';
  let runtime = options.runtime || null;
  // 票据 → 审计载荷。单发布锁下最多一条；TTL 丢弃的票据靠下次 prepare 覆盖。
  const pendingChanges = new Map();

  function attachRuntime(value) { runtime = value; }

  function findInstalled(state, pluginId, version) {
    const matches = state.installed.filter((item) => item.pluginId === pluginId && (!version || item.version === version));
    if (matches.length === 0) throw new PluginError('plugin_not_installed', `未安装插件 ${pluginId}${version ? `@${version}` : ''}`);
    if (matches.length > 1) throw new PluginError('plugin_version_ambiguous', `插件 ${pluginId} 安装了多个版本，请指定 --version`);
    return matches[0];
  }

  // 宿主 prepare 需要的期望插件集合（只含已启用实例）。
  function hostPlugins(state) {
    return state.instances.filter((instance) => instance.enabled).map((instance) => {
      const installed = findInstalled(state, instance.pluginId, instance.version);
      return {
        instanceId: instance.instanceId,
        manifest: installed.manifest,
        entryPath: path.join(installed.directory, ...installed.manifest.entry.split('/')),
        configuration: instance.configuration
      };
    });
  }

  function desiredPlugins() {
    try { return hostPlugins(store.get()); } catch (_error) { return []; }
  }

  function install(file, installOptions = {}) {
    const accepted = acceptArtifact(file, roots, {
      hostVersion,
      aiHomeDir,
      trustedKeys: installOptions.trustedKeys,
      requireSigned: installOptions.requireSigned === true
    });
    const manifest = validateManifest(accepted.manifest, { hostVersion });
    const next = store.update((state) => {
      const sameVersion = state.installed.find((item) => item.pluginId === manifest.pluginId && item.version === manifest.version);
      if (sameVersion && sameVersion.digest !== accepted.digest) {
        throw new PluginError('plugin_version_conflict', `${manifest.pluginId}@${manifest.version} 已安装且内容不同；请提升版本号`);
      }
      if (!sameVersion) {
        state.installed.push({
          pluginId: manifest.pluginId,
          version: manifest.version,
          digest: accepted.digest,
          artifact: accepted.artifactPath,
          directory: accepted.directory,
          manifest,
          installedAt: Date.now(),
          signature: accepted.signature,
          permissionsFingerprint: permissionFingerprint(manifest)
        });
      }
      return state;
    });
    audit.append('install', {
      pluginId: manifest.pluginId,
      version: manifest.version,
      digest: accepted.digest,
      signature: accepted.signature.status,
      keyId: accepted.signature.keyId || '',
      permissions: manifest.permissions || null
    });
    return {
      pluginId: manifest.pluginId,
      version: manifest.version,
      digest: accepted.digest,
      revision: next.revision,
      signature: accepted.signature,
      permissions: manifest.permissions || null
    };
  }

  function uninstall(input = {}) {
    const pluginId = text(input.pluginId);
    const version = text(input.version);
    let removed = null;
    const next = store.update((state) => {
      const target = findInstalled(state, pluginId, version);
      const users = state.instances.filter((item) => item.pluginId === target.pluginId && item.version === target.version);
      if (users.length) {
        throw new PluginError('plugin_in_use', `仍被实例引用：${users.map((item) => item.instanceId).join(', ')}（先停用并删除实例）`);
      }
      removed = target;
      state.installed = state.installed.filter((item) => item !== target);
      return state;
    }, input.expectedRevision === undefined ? undefined : Number(input.expectedRevision));
    // 同一摘要可能还被别的已安装记录引用（同包装成不同版本不可能，但防御性检查）。
    if (!next.installed.some((item) => item.digest === removed.digest)) {
      fs.rmSync(removed.artifact, { force: true });
      fs.rmSync(removed.directory, { recursive: true, force: true });
    }
    audit.append('uninstall', { pluginId: removed.pluginId, version: removed.version });
    return { pluginId: removed.pluginId, version: removed.version, revision: next.revision };
  }

  function prunePendingChanges() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [ticketId, entry] of pendingChanges) {
      if (!entry || entry.at < cutoff) pendingChanges.delete(ticketId);
    }
  }

  // 候选构建与宿主准备；不写状态。Go 拿到候选后做 CAS，成功才回调 activate。
  async function prepareChange(operation, spec, expectedRevision) {
    requireCondition(runtime, 'plugin_runtime_unavailable', '插件运行时不可用（需要在 aih server 中执行）');
    prunePendingChanges();
    const current = store.get();
    const expected = expectedRevision === undefined || expectedRevision === null || expectedRevision === ''
      ? current.revision
      : Number(expectedRevision);
    requireCondition(current.revision === expected, 'plugin_revision_conflict', `配置已被修改（当前 revision ${current.revision}）`);
    const candidate = spec.mutate(clone(current));
    const plugins = hostPlugins(candidate);
    const prepared = await runtime.prepare(plugins);
    const normalized = normalizeState(clone(candidate));
    normalized.revision = expected + 1;
    const auditDetails = typeof spec.audit === 'function' ? spec.audit() : spec.audit;
    pendingChanges.set(prepared.ticket, { operation, audit: auditDetails || null, at: Date.now() });
    return {
      ticket: prepared.ticket,
      generation: prepared.generation,
      candidate: normalized,
      contributions: prepared.contributions || [],
      // 内部使用：同一份 expected 既用于 Node 预检，也用于 commitRemote/Go CAS。
      expectedRevision: expected
    };
  }

  // 激活成功后才写审计：状态已由 Go 提交，审计恰好一次。
  async function activateChange(ticket, revision) {
    const result = await runtime.activate(ticket, revision);
    const entry = pendingChanges.get(ticket);
    pendingChanges.delete(ticket);
    if (entry && entry.audit) audit.append(entry.operation, entry.audit);
    return { revision: Number(revision) || result.revision || 0, generation: result.generation, state: result.state };
  }

  async function discardChange(ticket, reason) {
    try {
      return await runtime.discard(ticket, reason);
    } finally {
      pendingChanges.delete(ticket);
    }
  }

  function buildEnableSpec(input = {}) {
    const pluginId = text(input.pluginId);
    requireCondition(pluginId, 'plugin_id_required');
    const current = store.get();
    const target = findInstalled(current, pluginId, text(input.version));
    const targetFingerprint = permissionFingerprint(target.manifest);
    const instanceId = text(input.instanceId) || pluginId;
    const existing = current.instances.find((item) => item.instanceId === instanceId);
    const alreadyAccepted = Boolean(existing
      && existing.pluginId === pluginId
      && existing.version === target.version
      && existing.permissionsAcceptedFingerprint === targetFingerprint
      && existing.permissionsAcceptedAt);
    // 「安装即授权」只对真正申请了网络/凭据/环境/文件系统权限的插件生效：
    // 用户必须在启用时显式确认，或此前对同一权限指纹确认过。权限内容变化后必须重认。
    requireCondition(!hasDeclaredPermissions(target.manifest) || input.acceptPermissions === true || alreadyAccepted,
      'plugin_permissions_unacknowledged',
      `插件 ${pluginId} 申请了权限，启用时需要确认（acceptPermissions）`);
    let auditDetails = null;
    return {
      mutate(state) {
        const installed = findInstalled(state, pluginId, text(input.version));
        requireCondition(INSTANCE_ID_PATTERN.test(instanceId), 'plugin_instance_id_invalid');
        const previous = state.instances.find((item) => item.instanceId === instanceId);
        requireCondition(!previous || previous.pluginId === pluginId, 'plugin_instance_conflict', `实例 ${instanceId} 属于其他插件`);
        const configuration = validateInstanceConfiguration(installed.manifest,
          input.configuration !== undefined ? input.configuration : previous?.configuration);
        const fingerprint = permissionFingerprint(installed.manifest);
        const record = {
          instanceId,
          pluginId,
          version: installed.version,
          enabled: true,
          configuration,
          updatedAt: Date.now(),
          createdAt: previous?.createdAt || Date.now(),
          ...(hasDeclaredPermissions(installed.manifest)
            ? {
                permissionsAcceptedAt: previous?.permissionsAcceptedFingerprint === fingerprint
                  ? previous.permissionsAcceptedAt
                  : Date.now(),
                permissionsAcceptedFingerprint: fingerprint
              }
            : {})
        };
        state.instances = state.instances.filter((item) => item.instanceId !== instanceId).concat(record);
        auditDetails = {
          instanceId,
          pluginId,
          version: installed.version,
          signature: installed.signature?.status || 'unsigned',
          permissions: installed.manifest.permissions || null
        };
        return state;
      },
      audit: () => auditDetails
    };
  }

  function buildDisableSpec(input = {}) {
    const instanceId = text(input.instanceId);
    let auditDetails = null;
    return {
      mutate(state) {
        const instance = state.instances.find((item) => item.instanceId === instanceId);
        requireCondition(instance, 'plugin_instance_unknown', `没有实例 ${instanceId}`);
        instance.enabled = false;
        instance.updatedAt = Date.now();
        if (input.remove) state.instances = state.instances.filter((item) => item.instanceId !== instanceId);
        auditDetails = { instanceId, pluginId: instance.pluginId, remove: input.remove === true };
        return state;
      },
      audit: () => auditDetails
    };
  }

  // 内部协议入口：按 operation 构建候选（enable/disable 的校验与权限门都在这里）。
  function prepareInstance(operation, input, expectedRevision) {
    requireCondition(operation === 'enable' || operation === 'disable', 'plugin_operation_invalid');
    const body = input && typeof input === 'object' ? input : {};
    const spec = operation === 'enable' ? buildEnableSpec(body) : buildDisableSpec(body);
    return prepareChange(operation, spec, expectedRevision);
  }

  // 进程内兼容壳（demo/单测）：prepare → 本地或 Go commit → activate。
  // 生产 HTTP 入口不再调用它；/v0/plugins/enable|disable 直接代理 Go。
  async function publishChange(spec, expectedRevision, operation) {
    const prepared = await prepareChange(operation, spec, expectedRevision);
    let committed;
    try {
      committed = await store.commitRemote(prepared.candidate, prepared.expectedRevision, operation);
    } catch (error) {
      try { await discardChange(prepared.ticket, 'commit_failed'); } catch (_discardError) {}
      throw error;
    }
    return activateChange(prepared.ticket, committed.revision);
  }

  function enable(input = {}) {
    return publishChange(buildEnableSpec(input), input.expectedRevision, 'enable');
  }

  function disable(input = {}) {
    return publishChange(buildDisableSpec(input), input.expectedRevision, 'disable');
  }

	function doctor() {
    const state = store.get();
    const issues = [];
    const warnings = [];
    const capabilities = {};
    for (const item of state.installed) {
      try { validateManifest(item.manifest, { hostVersion }); } catch (error) {
        issues.push({ code: error.code || 'plugin_manifest_invalid', pluginId: item.pluginId, detail: error.message });
      }
      if (!fs.existsSync(item.artifact)) issues.push({ code: 'plugin_artifact_missing', pluginId: item.pluginId, detail: item.artifact });
      const entry = path.join(item.directory, ...String(item.manifest.entry || '').split('/'));
      if (!fs.existsSync(entry)) issues.push({ code: 'plugin_extracted_missing', pluginId: item.pluginId, detail: entry });
      if (!item.signature || item.signature.status !== 'signed') {
        warnings.push({ code: 'plugin_signature_unsigned', pluginId: item.pluginId, detail: '插件包未签名（完整性由摘要保证，来源不可验证）' });
      }
      for (const contribution of item.manifest.contributes || []) {
        capabilities[contribution.capability] = (capabilities[contribution.capability] || 0) + 1;
      }
    }
    for (const instance of state.instances) {
      const installed = state.installed.find((item) => item.pluginId === instance.pluginId && item.version === instance.version);
      if (!installed) {
        issues.push({ code: 'plugin_instance_artifact_missing', instanceId: instance.instanceId });
        continue;
      }
      if (instance.enabled && hasDeclaredPermissions(installed.manifest)
        && instance.permissionsAcceptedFingerprint !== permissionFingerprint(installed.manifest)) {
        issues.push({ code: 'plugin_permissions_unacknowledged', instanceId: instance.instanceId, pluginId: instance.pluginId });
      }
    }
    const runtimeStatus = runtime ? runtime.status() : null;
    if (runtimeStatus && ['degraded'].includes(runtimeStatus.state)) {
      issues.push({ code: 'plugin_runtime_degraded', detail: runtimeStatus.lastError?.message || '', diagnostics: runtimeStatus.diagnostics });
    }
    for (const error of (runtimeStatus && runtimeStatus.providerDescriptorErrors) || []) {
      warnings.push({ code: error.code || 'provider_descriptor_rejected', detail: error.detail || '' });
    }
    return {
      ok: issues.length === 0,
      revision: state.revision,
      issues,
      warnings,
      capabilities,
      installed: state.installed.map((item) => ({
        pluginId: item.pluginId,
        version: item.version,
        digest: item.digest,
        signature: item.signature || { status: 'unsigned' },
        permissions: item.manifest.permissions || null
      })),
      audit: audit.read({ limit: 20 }),
      runtime: runtimeStatus
    };
  }

  return {
    attachRuntime, audit, desiredPlugins, disable, doctor, enable, install, uninstall, roots, store,
    // P2：公开入口由 Go 驱动，Node 只负责候选构建与宿主生命周期。
    prepareChange, prepareInstance, activateChange, discardChange
  };
}

module.exports = { createPluginControl, permissionFingerprint, validateInstanceConfiguration };