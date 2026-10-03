// 插件宿主运行时（ESM，跑在受监督的 Plugin Host 子进程里；测试可在进程内直接使用）。
//
// 一个 generation = 一个独立的 Cordis Context：准备（prepare）→ 发布（activate）→ 排空并卸载（dispose）。
// 宿主只通过 ctx.aih 暴露窄服务：register（按清单声明注册贡献项 handler）、provide（只能提供清单
// 声明过的服务）、instance（实例身份）。注册经由调用方插件自己的 fiber，卸载时自动回收。
//
// 失败语义：
// - 静态问题（身份冲突、缺失服务、版本不满足、依赖成环）在加载任何插件代码前诊断（dependency-graph）。
// - 运行期问题：插件 apply 抛错 → FAILED；依赖的服务没出现 → PENDING。两者都让候选准备失败并给出诊断，
//   不会留下半加载的代次。插件 disposer 抛错不会中断卸载，但会被记录并归属到具体实例。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';

const require = createRequire(import.meta.url);
const { validateManifest } = require('../sdk/manifest');
const { PluginError } = require('../sdk/errors');
const { limits } = require('../sdk/contract.generated.json');
const { planGeneration } = require('./dependency-graph');

const MAX_RECORDED_ERRORS = 64;
const FIBER_STATE = Object.freeze({ PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 });

function describeError(value) {
  if (value instanceof Error) return value.message || value.name;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

class AihHostService extends Service {
  constructor(ctx, candidate) {
    super(ctx, 'aih');
    this.candidate = candidate;
  }

  // this.ctx 是调用方插件的 context（Cordis 按调用方扩展服务实例），据此判定归属。
  instance() {
    const instanceId = this.candidate.instanceOf(this.ctx.fiber);
    const spec = this.candidate.specs.get(instanceId);
    return Object.freeze({ instanceId, pluginId: spec.manifest.pluginId, generation: this.candidate.generation });
  }

  register(contributionId, handler) {
    return this.candidate.register(this.ctx, contributionId, handler);
  }

  provide(name, value) {
    return this.candidate.provide(this.ctx, name, value);
  }
}

class Candidate {
  constructor(generation, specs, options) {
    this.generation = generation;
    this.specs = specs;
    this.options = options;
    this.root = null;
    this.fiberInstances = new WeakMap();
    this.pluginFibers = [];
    this.handlers = new Map();
    this.contributionOwners = new Map();
    this.inflight = new Map();
    this.errors = [];
    for (const [instanceId, spec] of specs) {
      for (const contribution of spec.manifest.contributes || []) this.contributionOwners.set(contribution.id, instanceId);
    }
  }

  record(instanceId, phase, error) {
    this.errors.push({ instanceId, phase, message: describeError(error), at: Date.now() });
    if (this.errors.length > MAX_RECORDED_ERRORS) this.errors.shift();
  }

  instanceOf(fiber) {
    let current = fiber;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const instanceId = this.fiberInstances.get(current);
      if (instanceId) return instanceId;
      current = current.parent?.fiber;
    }
    throw new PluginError('plugin_owner_invalid', '只能在插件自己的 context 中调用宿主服务');
  }

  register(ctx, contributionId, handler) {
    if (typeof handler !== 'function') throw new PluginError('plugin_handler_invalid');
    const instanceId = this.instanceOf(ctx.fiber);
    if (this.contributionOwners.get(contributionId) !== instanceId) {
      throw new PluginError('plugin_contribution_unknown', `贡献项 ${contributionId} 未在 ${instanceId} 的清单中声明`);
    }
    if (this.handlers.has(contributionId)) throw new PluginError('plugin_contribution_duplicate');
    return ctx.effect(() => {
      this.handlers.set(contributionId, { instanceId, handler });
      return () => {
        if (this.handlers.get(contributionId)?.handler === handler) this.handlers.delete(contributionId);
      };
    }, `aih.register(${contributionId})`);
  }

  provide(ctx, name, value) {
    const instanceId = this.instanceOf(ctx.fiber);
    const declared = (this.specs.get(instanceId).manifest.provides || []).some((service) => service.name === name);
    if (!declared) throw new PluginError('plugin_service_undeclared', `服务 ${name} 未在 ${instanceId} 的清单 provides 中声明`);
    return ctx.provide(name, value);
  }

  async load(order) {
    const root = new Context();
    this.root = root;
    root.logger.exporter({
      export: (message) => {
        if (message.type !== 'error') return;
        const fiber = message.fiber?.deref?.();
        let instanceId = '';
        try { instanceId = fiber ? this.instanceOf(fiber) : ''; } catch (_error) {}
        this.record(instanceId, 'runtime', message.args?.[0]);
      }
    });
    const candidate = this;
    await root.plugin({ name: `aih-host-generation-${this.generation}`, apply(ctx) { new AihHostService(ctx, candidate); } });

    const diagnostics = [];
    for (const instanceId of order) {
      const spec = this.specs.get(instanceId);
      let module;
      try {
        module = await import(`${pathToFileURL(spec.entryPath).href}?generation=${this.generation}&instance=${encodeURIComponent(instanceId)}`);
      } catch (error) {
        diagnostics.push({ code: 'plugin_entry_load_failed', instanceId, detail: describeError(error) });
        break;
      }
      const plugin = module.default || module.plugin;
      if (!plugin || typeof plugin.apply !== 'function') {
        diagnostics.push({ code: 'plugin_entry_invalid', instanceId, detail: '入口模块没有导出带 apply 的插件' });
        break;
      }
      const requires = (spec.manifest.requires || []).map((item) => item.name).filter((name) => name !== 'aih');
      const fiber = root.plugin({
        name: instanceId,
        inject: ['aih', ...requires],
        apply: async (ctx, config) => {
          this.fiberInstances.set(ctx.fiber, instanceId);
          await ctx.plugin(plugin, config);
        }
      }, spec.configuration || {});
      this.fiberInstances.set(fiber, instanceId);
      this.pluginFibers.push(fiber);
      try { await fiber; } catch (_error) { /* 状态与错误在下面统一诊断 */ }
      if (fiber.state === FIBER_STATE.FAILED) {
        const failure = [...this.errors].reverse().find((item) => item.instanceId === instanceId);
        diagnostics.push({ code: 'plugin_apply_failed', instanceId, detail: failure?.message || '插件启动失败' });
        break;
      }
      if (fiber.state !== FIBER_STATE.ACTIVE) {
        const missing = requires.filter((name) => !root.get(name));
        diagnostics.push({ code: 'plugin_service_pending', instanceId, detail: `等待服务：${missing.join(', ') || '未知'}`, services: missing });
        break;
      }
    }
    return diagnostics;
  }

  async invoke(contributionId, value, context) {
    const entry = this.handlers.get(contributionId);
    if (!entry) {
      throw new PluginError(this.contributionOwners.has(contributionId) ? 'plugin_contribution_unavailable' : 'plugin_contribution_unknown');
    }
    if (context.signal?.aborted) throw context.signal.reason || new PluginError('plugin_rpc_cancelled');
    const token = Symbol(contributionId);
    const controller = new AbortController();
    const forward = () => controller.abort(context.signal.reason);
    context.signal?.addEventListener('abort', forward, { once: true });
    this.inflight.set(token, controller);
    try {
      return await entry.handler(value, Object.freeze({
        invocationId: context.id,
        instanceId: entry.instanceId,
        generation: this.generation,
        deadline: context.deadline,
        signal: controller.signal,
        payload: context.payload ? new Uint8Array(context.payload) : new Uint8Array(0)
      }));
    } finally {
      context.signal?.removeEventListener('abort', forward);
      this.inflight.delete(token);
    }
  }

  // 先等在途调用自然结束；超过排空时限就取消它们，再卸载插件（disposer 逆序执行并被等待）。
  async dispose(drainTimeoutMs) {
    const deadline = Date.now() + drainTimeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const controller of this.inflight.values()) controller.abort(new PluginError('plugin_generation_draining'));
    for (const fiber of this.pluginFibers.slice().reverse()) {
      try { await fiber.dispose(); } catch (error) { this.record(this.fiberInstances.get(fiber) || '', 'dispose', error); }
    }
    this.pluginFibers = [];
    if (this.root) {
      try { await this.root.fiber.dispose(); } catch (error) { this.record('', 'dispose', error); }
    }
    this.handlers.clear();
  }
}

export class HostRuntime {
  constructor(options = {}) {
    this.hostVersion = String(options.hostVersion || '1.0.0');
    this.drainTimeoutMs = Number(options.drainTimeoutMs || limits.drainTimeoutMs);
    this.candidates = new Map();
    this.activeGeneration = 0;
    this.lastDisposed = [];
  }

  async prepare(spec = {}) {
    const generation = Number(spec.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new PluginError('plugin_generation_invalid');
    if (this.candidates.has(generation)) throw new PluginError('plugin_generation_duplicate');
    const plugins = Array.isArray(spec.plugins) ? spec.plugins : [];
    const specs = new Map();
    const diagnostics = [];
    for (const item of plugins) {
      const instanceId = String(item?.instanceId || '');
      try {
        const manifest = validateManifest(item.manifest, { hostVersion: this.hostVersion });
        if (!instanceId || !item.entryPath) throw new PluginError('plugin_spec_invalid', '缺少 instanceId 或 entryPath');
        specs.set(instanceId, { manifest, entryPath: String(item.entryPath), configuration: item.configuration || {} });
      } catch (error) {
        diagnostics.push({ code: error.code || 'plugin_manifest_invalid', instanceId, detail: describeError(error) });
      }
    }
    if (diagnostics.length) return { generation, state: 'rejected', diagnostics };
    const plan = planGeneration([...specs].map(([instanceId, value]) => ({ instanceId, manifest: value.manifest })));
    if (!plan.ok) return { generation, state: 'rejected', diagnostics: plan.diagnostics };

    const candidate = new Candidate(generation, specs, {});
    const loadDiagnostics = await candidate.load(plan.order);
    if (loadDiagnostics.length) {
      await candidate.dispose(0);
      return { generation, state: 'rejected', diagnostics: loadDiagnostics, errors: candidate.errors };
    }
    this.candidates.set(generation, candidate);
    return { generation, state: 'prepared', order: plan.order, contributions: [...candidate.handlers.keys()].sort() };
  }

  async activate(generation) {
    const next = this.candidates.get(Number(generation));
    if (!next) throw new PluginError('plugin_generation_unknown');
    const previous = this.activeGeneration;
    this.activeGeneration = next.generation;
    if (previous && previous !== next.generation) await this.dispose(previous);
    return { generation: this.activeGeneration, state: 'active' };
  }

  async invoke(request = {}, context = {}) {
    const generation = Number(request.generation || this.activeGeneration);
    const candidate = this.candidates.get(generation);
    if (!candidate) throw new PluginError('plugin_generation_unknown');
    return candidate.invoke(String(request.contributionId || ''), request.value, context);
  }

  async dispose(generation) {
    const key = Number(generation);
    const candidate = this.candidates.get(key);
    if (!candidate) return { generation: key, state: 'disposed', errors: [] };
    this.candidates.delete(key);
    if (this.activeGeneration === key) this.activeGeneration = 0;
    await candidate.dispose(this.drainTimeoutMs);
    this.lastDisposed = candidate.errors.slice();
    return { generation: key, state: 'disposed', errors: candidate.errors.slice() };
  }

  async shutdown() {
    for (const generation of [...this.candidates.keys()]) await this.dispose(generation);
  }

  status() {
    return {
      activeGeneration: this.activeGeneration,
      generations: [...this.candidates.keys()].sort((a, b) => a - b),
      errors: [...this.candidates.values()].flatMap((candidate) => candidate.errors).concat(this.lastDisposed).slice(-MAX_RECORDED_ERRORS)
    };
  }
}
