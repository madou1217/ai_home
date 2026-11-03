'use strict';

// 原生会话**启动准备管线**（Native Session Launch Preparation Pipeline）。
//
// 为什么需要它：一次 work 轮次的启动不只是 spawn。CLI 路径在 spawn 前会做「账号投影的会话链接
// 对账」（pty-runtime-run.js:301 `reconcileProviderResources(ensureSessionStoreLinks, cliName, ref,
// { sessionLinksOnly: true })`），spawn 后还会补一条会话索引。canonical 驱动此前只调 spawn，于是
// 需要投影的 provider（agy 等）在「投影里还没有链接」的账号上直接 fail-closed：
//   provider_resource_reconcile_incomplete:cli.log
// 而同一账号走 CLI 路径同一步是成功的（linked 59）—— 两条链行为分叉，根因就是这个缺步骤。
//
// 设计（Registry + 声明式步骤序列）：
//   - **步骤序列是数据**：由启动档案声明（profile.preparation / profile.postSpawn）。
//   - **实现由注册表按 id 提供**：新增一类准备工作 = 注册一个 handler；新增 provider 通常只改描述符。
//   - 声明的步骤没有实现 → 记诊断（**可观察**），绝不静默跳过。
//   - 失败语义由步骤自己决定：fail-closed（抛，会话启动失败）/ best-effort（记诊断继续）。

const { ensureSessionIndexEntry } = require('./chat-runner-profile');
const path = require('node:path');
const { reconcileProviderResources } = require('../runtime/provider-resource-reconciliation');
const { resolveNativeProviderRuntime } = require('./native-session-chat-env');
const { healAgySettingsModel } = require('../runtime/agy-settings-heal');
const {
  POST_SPAWN_SESSION_INDEX,
  PREPARE_PROVIDER_CONFIG_HEAL,
  PREPARE_SESSION_STORE_LINKS
} = require('./native-session-launch-profile');

// provider 配置自愈注册表：provider → { settingsRelative, heal(context) }。
// 新增「某个 provider 的配置会过期、启动前要修」= 加一行；未声明的 provider 静默跳过。
const PROVIDER_CONFIG_HEALERS = Object.freeze({
  // agy：HOME 下的 settings.json 里 model 字段会过期（旧值不在 CLI 可用列表 → 直接跑 agy 会 429）。
  agy: Object.freeze({
    settingsRelative: Object.freeze(['.gemini', 'antigravity-cli', 'settings.json']),
    heal: (context) => healAgySettingsModel({
      fs: context.fs,
      settingsPath: context.settingsPath,
      preferredModel: context.model
    })
  })
});

function hasProviderConfigHealer(provider) {
  return typeof PROVIDER_CONFIG_HEALERS[String(provider || '').trim().toLowerCase()] === 'function';
}

// 与 CLI 路径同款：只对账会话链接，不接管整棵投影树。
const SESSION_LINKS_ONLY = Object.freeze({ sessionLinksOnly: true });

/**
 * 与引擎/CLI 同一个运行时解析函数（单一事实来源）：`projectionRequired` 决定是否需要投影对账。
 * 调用方可用 ports.resolveRuntime 覆盖（测试或网关作用域）。
 */
function resolveRuntimeDescriptor(ports, provider, accountRef) {
  if (typeof ports.resolveRuntime === 'function') {
    return ports.resolveRuntime(provider, accountRef);
  }
  if (typeof ports.getProfileDir !== 'function') return null;
  const projectionDir = ports.getProfileDir(provider, accountRef, { gateway: false });
  if (!projectionDir) return null;
  return resolveNativeProviderRuntime(provider, projectionDir, ports.env || process.env, {
    accountRef,
    aiHomeDir: ports.aiHomeDir,
    gateway: false
  });
}

/** 诊断出口：步骤失败/不可用都要可观察（默认 sink 静默，组合根会注入真实出口）。 */
function reportStepFailure(ports, entry) {
  if (typeof ports.diagnostics !== 'function') return;
  try {
    ports.diagnostics(entry);
  } catch (_error) { /* 诊断出口自身异常不影响失败语义 */ }
}

/** 步骤处理器注册表：id → handler。 */
function createNativeSessionPreparationHandlers(ports = {}) {
  const handlers = new Map();

  // 启动前：账号投影的会话链接对账（fail-closed —— 与 CLI 路径同一语义）。
  handlers.set(PREPARE_SESSION_STORE_LINKS, (context) => {
    if (typeof ports.ensureSessionStoreLinks !== 'function') {
      return { status: 'unavailable', reason: 'ensure_session_store_links_port_missing' };
    }
    const runtime = resolveRuntimeDescriptor(ports, context.provider, context.accountRef);
    if (!runtime) return { status: 'unavailable', reason: 'runtime_descriptor_unavailable' };
    if (!runtime.projectionRequired) return { status: 'skipped', reason: 'projection_not_required' };
    try {
      const summary = reconcileProviderResources(
        ports.ensureSessionStoreLinks,
        context.provider,
        context.accountRef,
        SESSION_LINKS_ONLY
      );
      return { status: 'done', migrated: summary.migrated, linked: summary.linked };
    } catch (error) {
      // fail-closed，但必须可观察：把失败事实与上下文交给诊断出口后再抛。
      reportStepFailure(ports, {
        code: 'native_session_preparation_step_failed',
        step: PREPARE_SESSION_STORE_LINKS,
        provider: context.provider,
        accountRef: context.accountRef,
        unresolved: Array.isArray(error && error.unresolved) ? error.unresolved : [],
        detail: String((error && error.message) || error || 'unknown_error')
      });
      throw error;
    }
  });

  // 启动前：provider 配置文件自愈（注册表按 provider 取实现；未声明 = 静默跳过）。
  handlers.set(PREPARE_PROVIDER_CONFIG_HEAL, (context) => {
    const provider = String(context.provider || '').trim().toLowerCase();
    const declaration = PROVIDER_CONFIG_HEALERS[provider];
    if (!declaration || typeof declaration.heal !== 'function') {
      return { status: 'skipped', reason: 'no_provider_config_healer' };
    }
    const projectionDir = String(context.projectionDir || '').trim();
    if (!projectionDir) return { status: 'skipped', reason: 'projection_dir_unavailable' };
    const settingsPath = path.join(projectionDir, ...declaration.settingsRelative);
    try {
      const result = declaration.heal({ ...context, settingsPath }) || {};
      if (result.status === 'healed') {
        reportStepFailure(ports, {
          code: 'native_session_provider_config_healed',
          step: PREPARE_PROVIDER_CONFIG_HEAL,
          provider,
          from: result.from,
          to: result.to
        });
      }
      return result;
    } catch (error) {
      // 自愈是 best effort：失败不拦会话，但必须可观察。
      reportStepFailure(ports, {
        code: 'native_session_provider_config_heal_failed',
        step: PREPARE_PROVIDER_CONFIG_HEAL,
        provider,
        detail: String((error && error.message) || error || 'unknown_error')
      });
      return { status: 'failed', reason: 'heal_threw' };
    }
  });

  // 启动后：补一条会话索引，让列表能看见刚建的会话（best effort，内部已自吞异常）。
  handlers.set(POST_SPAWN_SESSION_INDEX, (context) => {
    if (!context.nativeSessionId) return { status: 'skipped', reason: 'native_session_id_unknown' };
    ensureSessionIndexEntry(context.provider, {
      sessionId: context.nativeSessionId,
      prompt: context.prompt,
      projectPath: context.projectPath
    });
    return { status: 'done' };
  });

  return handlers;
}

/** 执行档案声明的步骤序列（stepsKey = 'preparation' | 'postSpawn'）。 */
function runNativeSessionPreparation(profile, stepsKey, context, options = {}) {
  const steps = Array.isArray(profile && profile[stepsKey]) ? profile[stepsKey] : [];
  const handlers = options.handlers instanceof Map ? options.handlers : new Map();
  const diagnostics = typeof options.diagnostics === 'function' ? options.diagnostics : () => {};
  const results = [];
  for (const step of steps) {
    const handler = handlers.get(step);
    if (!handler) {
      diagnostics({
        code: 'native_session_preparation_step_unregistered',
        step,
        stepsKey,
        provider: context.provider
      });
      results.push({ step, status: 'unregistered' });
      continue;
    }
    const result = handler(context) || { status: 'done' };
    results.push({ step, ...result });
    if (result.status === 'unavailable') {
      diagnostics({
        code: 'native_session_preparation_step_unavailable',
        step,
        stepsKey,
        provider: context.provider,
        reason: result.reason
      });
    }
  }
  return results;
}

module.exports = {
  SESSION_LINKS_ONLY,
  createNativeSessionPreparationHandlers,
  resolveRuntimeDescriptor,
  runNativeSessionPreparation
};
