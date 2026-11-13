'use strict';

// /v0/plugins/*：插件的安装、启停、诊断与调试调用。
//
// 安装插件等于以服务端用户身份执行任意代码，所以这里只认管理密钥（authorizeManagementKey），
// 不走 /v0/management 那种「没配密钥时本机免密」的放行；没配管理密钥一律 503。

const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('../../scripts/process-runner');
const { authorizeManagementKey } = require('./management-key-auth');
const { getPluginSystem } = require('../plugins/control/plugin-system');
const { callGoHost, proxyWebuiGo } = require('./webui-go-proxy');

const PREFIX = '/v0/plugins';
const MAX_BODY_BYTES = 256 * 1024;
const DEMO_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'aih-portable-plugin-demo.js');

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.code = 'plugin_request_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_error) {
    const error = new Error('请求体不是合法 JSON');
    error.code = 'plugin_request_invalid';
    throw error;
  }
}

const SAFE_DEMO_KEYS = new Set([
  'stage', 'passed', 'sharedCoreCalled', 'unavailable', 'installed', 'signatureVerified',
  'permissionGateVerified', 'legacyManifestProtocol', 'transportProtocolVersion', 'node', 'steps'
]);

function safeDemoEvidence(value) {
  if (Array.isArray(value)) return value.map(safeDemoEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => SAFE_DEMO_KEYS.has(key) || key === 'host' || key === 'runtime' || key === 'package')
    .map(([key, item]) => [key, safeDemoEvidence(item)]));
}

async function runPortablePluginDemo() {
  const execution = await runProcess(process.execPath, [DEMO_SCRIPT], {
    cwd: path.dirname(DEMO_SCRIPT),
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    timeoutMs: 5 * 60 * 1000,
    maxOutput: 4 * 1024 * 1024,
    stopWhen: (output) => {
      try {
        const parsed = JSON.parse(String(output || '').trim());
        return parsed && parsed.passed === true;
      } catch (_error) {
        return false;
      }
    }
  });
  let evidence = null;
  try { evidence = JSON.parse(String(execution.stdout || '').trim()); } catch (_error) {}
  if (execution.status !== 0 || !evidence || evidence.passed !== true) {
    const error = new Error('plugin_demo_failed');
    error.code = 'plugin_demo_failed';
    error.diagnostics = [{
      status: execution.status,
      timedOut: execution.timedOut === true,
      stderr: String(execution.stderr || '').slice(-2000)
    }];
    throw error;
  }
  return { command: `node ${path.relative(path.dirname(DEMO_SCRIPT), DEMO_SCRIPT)}`, evidence: safeDemoEvidence(evidence) };
}

function writeError(writeJson, res, error) {
  const code = error?.code || 'plugin_error';
  const status = code === 'plugin_runtime_unavailable' || code === 'plugin_runtime_inactive' ? 503
    : code === 'plugin_revision_conflict' || code === 'plugin_in_use' || code === 'plugin_version_conflict' ? 409
      : code === 'plugin_not_installed' || code === 'plugin_instance_unknown' ? 404
        : 400;
  writeJson(res, status, { ok: false, error: code, message: String(error?.message || code), diagnostics: error?.diagnostics || [] });
}

// —— 插件清单 ——
//
// 清单固定读 Go 的 GET /v1/management/plugins：控制面事实（revision / installed /
// instances）由 Go 直接读 app-state.db，数据面状态由 Go 已确认的投影给出。Node 侧不再
// 自己拼一份，也没有开关或回退——两份清单并存只会让「页面看到的」和「Go 执行的」分叉。
//
// 管理密钥不在路由里拼：goCoreSync 持有的客户端本来就用进程内那把密钥，
// 调用方（WebUI / CLI）只需要对 Node 出示同一把。

const GO_CORE_UNAVAILABLE = 'go_core_unavailable';

function objectsOf(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function textListOf(value) {
  return Array.isArray(value) ? value.map((item) => String(item == null ? '' : item)).filter(Boolean) : [];
}

function generationListOf(value) {
  return Array.isArray(value) ? value.map((item) => Number(item) || 0) : [];
}

function mapInstalledPlugin(item) {
  return {
    pluginId: String(item.pluginId || ''),
    version: String(item.version || ''),
    digest: String(item.digest || ''),
    installedAt: Number(item.installedAt) || 0,
    // 缺签名在 Go 侧已归一成 {status:'unsigned'}；这里再兜一层，别把 null 漏给页面。
    signature: item.signature && typeof item.signature === 'object' ? item.signature : { status: 'unsigned' },
    permissions: item.permissions && typeof item.permissions === 'object' ? item.permissions : null,
    contributes: textListOf(item.contributes)
  };
}

function mapPluginInstance(item) {
  return {
    instanceId: String(item.instanceId || ''),
    pluginId: String(item.pluginId || ''),
    version: String(item.version || ''),
    enabled: item.enabled === true,
    configurationKeys: textListOf(item.configurationKeys),
    permissionsAcceptedAt: item.permissionsAcceptedAt === null || item.permissionsAcceptedAt === undefined
      ? null
      : (Number(item.permissionsAcceptedAt) || 0),
    updatedAt: Number(item.updatedAt) || 0
  };
}

function mapRuntimeInstance(item) {
  return {
    instanceId: String(item.instanceId || ''),
    status: String(item.status || ''),
    generations: generationListOf(item.generations),
    contributions: Number(item.contributions) || 0
  };
}

/**
 * Go 只读清单 → /v0/plugins 既有响应契约。
 *
 * 字段名两边本来就一致（Go 侧按 Node control.list() 设计），但仍然逐字段映射而不是整体透传：
 * 缺失字段要有稳定默认值，null 与数组形状也不能直接漏给页面。
 * 多出来的 readOnly / source / consistency 是 Go 的只读边界与投影一致性事实，
 * 属于向后兼容的追加字段，页面可以忽略。
 */
function mapPluginInventory(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runtime = source.runtime && typeof source.runtime === 'object' ? source.runtime : {};
  const consistency = source.consistency && typeof source.consistency === 'object' ? source.consistency : {};
  return {
    ok: true,
    readOnly: source.readOnly === true,
    source: String(source.source || ''),
    revision: Number(source.revision) || 0,
    installed: objectsOf(source.installed).map(mapInstalledPlugin),
    instances: objectsOf(source.instances).map(mapPluginInstance),
    runtime: {
      activeGeneration: Number(runtime.activeGeneration) || 0,
      generations: generationListOf(runtime.generations),
      retiringGenerations: generationListOf(runtime.retiringGenerations),
      // 旧契约里 contributions 是 id 数组，Go 给的是对象数组；只取 id，
      // 既有消费方按字符串比较的行为保持不变。
      contributions: objectsOf(runtime.contributions).map((item) => String(item.id || '')).filter(Boolean),
      // Go 独有：实例在数据面投影里的状态（projected / retiring / absent）。
      instances: objectsOf(runtime.instances).map(mapRuntimeInstance)
    },
    consistency: {
      ok: consistency.ok === true,
      issues: objectsOf(consistency.issues)
    }
  };
}

/**
 * 写插件清单响应；Go 不可用一律 503，不做任何本地回退。
 */
async function writePluginInventory({ writeJson, res, deps }) {
  const goHost = deps.goCoreSync;
  if (!goHost || typeof goHost.getPluginInventory !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: GO_CORE_UNAVAILABLE,
      message: 'Go Core 未就绪，插件清单不可读'
    });
    return;
  }
  let response = null;
  try {
    response = await goHost.getPluginInventory();
  } catch (_error) {
    response = null;
  }
  if (!response || response.ok !== true) {
    // Go 的错误壳是 { ok:false, error:'<code>', message }——error 是字符串，管理客户端只在它是
    // 对象时才提取 errorCode（这里会退化成 http_503）。所以先取原始 body 里的领域码，
    // 取不到再用传输层码。状态码统一 503：这是上游没接住，不是调用方参数问题。
    const domainCode = response && response.body && typeof response.body.error === 'string'
      ? response.body.error
      : '';
    writeJson(res, 503, {
      ok: false,
      error: String(domainCode || (response && response.errorCode) || GO_CORE_UNAVAILABLE),
      message: 'Go Core 未就绪，插件清单不可读'
    });
    return;
  }
  writeJson(res, 200, mapPluginInventory(response.data));
}

/**
 * 把信任根的请求转给 Go，并把 Go 的状态码与响应体原样回给调用方。
 *
 * 为什么不在 Node 再映射一次错误：信任根只有「参数不对 / 存储损坏」两类领域错误，
 * Go 已按 Node writeError 的语义给出 400 + 错误码；再映射一遍只会让两边分叉。
 * 只有拿不到 HTTP 响应（status 0 / 抛错）才收敛成 503——那是 Go 没接住，不是请求有错。
 *
 * @returns {Promise<object|null>} 成功时的响应体，供 trust/untrust 写审计；失败为 null
 */
async function callGoTrustRoute({ writeJson, res, deps, method, args = [] }) {
  const goHost = deps.goCoreSync;
  const unavailable = () => writeJson(res, 503, {
    ok: false,
    error: GO_CORE_UNAVAILABLE,
    message: 'Go Core 未就绪，插件信任根不可用'
  });
  if (!goHost || typeof goHost[method] !== 'function') {
    unavailable();
    return null;
  }
  let response = null;
  try {
    response = await goHost[method](...args);
  } catch (_error) {
    response = null;
  }
  // status 0 = 传输失败；Go 自己的错误一定有 HTTP 状态码，必须原样透传。
  if (!response || !response.status) {
    unavailable();
    return null;
  }
  const body = response.body && typeof response.body === 'object' ? response.body : response.data;
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : { ok: response.ok === true };
  writeJson(res, response.status, payload);
  return response.ok === true ? payload : null;
}

/**
 * 把安装/卸载转发给 Go，并把 Go 的状态码与响应体原样回给调用方。
 *
 * 不在 Node 重做错误归类：Go 已按 Node writeError 的语义给出 400/404/409/503，
 * 再映射一遍只会让两边分叉。只有拿不到 HTTP 响应（status 0 / 抛错）才收敛成 503。
 *
 * @returns {Promise<object|null>} 成功时的响应体，供 install/uninstall 写审计；失败为 null
 */
/**
 * 采集运行态里激活的 `pricing.catalog` 插件快照，交由 Go 完成持久化、diff 与复核队列入库。
 * 单条插件执行失败不阻塞社区价格源采集，而是作为错误 attempt 透传给 Go。
 */
async function collectPluginPricingSnapshots(runtime, timeoutMs = 15_000) {
  const lease = runtime && typeof runtime.acquire === 'function' ? runtime.acquire() : null;
  if (!lease) return [];
  const snapshots = [];
  const effectiveTimeout = Math.max(1000, Math.min(60_000, Number(timeoutMs) || 15_000));
  try {
    const chain = (lease.snapshot && lease.snapshot.byCapability && lease.snapshot.byCapability.get('pricing.catalog')) || [];
    for (const item of chain) {
      try {
        const response = await runtime.invoke(item.id, {
          schemaVersion: 1,
          kind: 'catalog',
          now: new Date().toISOString()
        }, { generation: lease.generation, timeoutMs: effectiveTimeout });
        const rawValue = response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response;
        const value = Array.isArray(rawValue) ? { quotes: rawValue } : (rawValue && typeof rawValue === 'object' ? rawValue : {});
        const rawSource = value.source && typeof value.source === 'object' ? value.source : {};
        const sourceId = String(rawSource.id || '').trim() || `plugin:${item.instanceId}:${item.id}`;
        const fetchedAt = String(value.generatedAt || rawSource.fetchedAt || new Date().toISOString()).trim();
        snapshots.push({
          contributionId: String(item.id || ''),
          instanceId: String(item.instanceId || ''),
          sourceId,
          source: {
            id: sourceId,
            kind: String(rawSource.kind || 'community').trim() || 'community',
            url: String(rawSource.url || '').trim(),
            license: String(rawSource.license || '').trim(),
            fetchedAt: String(rawSource.fetchedAt || fetchedAt).trim()
          },
          quotes: Array.isArray(value.quotes) ? value.quotes : [],
          fetchedAt,
          requireReview: true
        });
      } catch (error) {
        snapshots.push({
          contributionId: String(item.id || ''),
          error: String((error && error.code) || 'pricing_catalog_failed').trim(),
          detail: String((error && error.message) || '').trim()
        });
      }
    }
  } finally {
    lease.release();
  }
  return snapshots;
}

async function callGoPluginAction({ writeJson, res, deps, method, args = [], message }) {
  const goHost = deps.goCoreSync;
  const unavailable = () => writeJson(res, 503, {
    ok: false,
    error: GO_CORE_UNAVAILABLE,
    message
  });
  if (!goHost || typeof goHost[method] !== 'function') {
    unavailable();
    return null;
  }
  let response = null;
  try {
    response = await goHost[method](...args);
  } catch (_error) {
    response = null;
  }
  // status 0 = 传输失败；Go 自己的错误一定有 HTTP 状态码，必须原样透传。
  if (!response || !response.status) {
    unavailable();
    return null;
  }
  const body = response.body && typeof response.body === 'object' ? response.body : response.data;
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : { ok: response.ok === true };
  writeJson(res, response.status, payload);
  return response.ok === true ? payload : null;
}

/**
 * @returns {Promise<boolean>} 是否处理了该请求
 */
async function handlePluginManagementRequest(ctx) {
  const { method, pathname, req, res, requiredManagementKey, deps = {} } = ctx;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  const { writeJson, parseAuthorizationBearer } = deps;
  const authorization = authorizeManagementKey({ req, requiredManagementKey, deps: { parseAuthorizationBearer } });
  if (!authorization.ok) {
    writeJson(res, authorization.statusCode, { ok: false, error: authorization.error });
    return true;
  }
  // 清单固定读 Go：Node 不再构建本地清单，Go 未就绪直接 503（无回退）。
  if (method === 'GET' && pathname === PREFIX) {
    await writePluginInventory({ writeJson, res, deps });
    return true;
  }
  // 信任根固定读 Go：Node 不再自己读文件，Go 未就绪直接 503（无回退）。
  // 写操作要顺带写 control.audit，仍需构造插件系统，所以放在下面统一处理。
  if (method === 'GET' && pathname === `${PREFIX}/trusted`) {
    await callGoTrustRoute({ writeJson, res, deps, method: 'getPluginTrustedKeys' });
    return true;
  }
  // enable/disable 的状态提交固定走 Go（Node 不再本地写 plugins.control.v1）。
  // Go 不可用时返回 status 0，由 state-store 收敛成 plugin_state_unavailable，绝不本地兜底。
  const commitPluginState = (payload) => {
    const goHost = deps.goCoreSync;
    if (!goHost || typeof goHost.commitPluginState !== 'function') {
      return Promise.resolve({ ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' });
    }
    return goHost.commitPluginState(payload);
  };
  const proxyCtx = ctx.writeJson ? ctx : { ...ctx, writeJson };
  if (method === 'GET' && pathname === `${PREFIX}/pricing/sources`) {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/sources',
      message: 'Go Core 未就绪，价格源目录不可读'
    });
  }
  if (method === 'GET' && pathname === `${PREFIX}/pricing/reviews`) {
    const status = new URL(req.url || '/', 'http://localhost').searchParams.get('status') || '';
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/reviews',
      query: status ? `status=${encodeURIComponent(status)}` : '',
      message: 'Go Core 未就绪，价格复核队列不可读'
    });
  }
  if (method === 'GET' && pathname === `${PREFIX}/pricing/status`) {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: '/v1/management/webui/pricing/status',
      message: 'Go Core 未就绪，价格状态不可读'
    });
  }
  const { account, control, runtime } = getPluginSystem(ctx.state, {
    aiHomeDir: deps.aiHomeDir,
    commitPluginState
  });
  const notifyPricingChanged = async () => {
    if (typeof deps.pricingChanged === 'function') return deps.pricingChanged();
    if (deps.modelUsageService && typeof deps.modelUsageService.syncPricingIfStale === 'function') {
      return deps.modelUsageService.syncPricingIfStale({ force: true, recalculateCosts: true });
    }
    return null;
  };
  try {
    if (method === 'GET' && pathname === `${PREFIX}/doctor`) {
      const report = control.doctor();
      const { available, response } = await callGoHost(proxyCtx, 'webuiRequest', [{
        method: 'GET',
        path: '/v1/management/webui/pricing/status?detail=doctor'
      }]);
      const pricingReport = available && response && response.ok === true && response.data && response.data.doctor
        ? response.data.doctor
        : null;
      writeJson(res, 200, { ok: true, ...report, pricing: pricingReport, healthy: report.ok });
      return true;
    }
    if (method === 'POST' && pathname === `${PREFIX}/demo`) {
      writeJson(res, 200, { ok: true, demo: await runPortablePluginDemo() });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/accounts/sources`) {
      const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider') || '';
      const listed = await account.listSources(provider);
      writeJson(res, 200, { ok: true, ...listed });
      return true;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJson(req);
    let result;
    if (pathname === `${PREFIX}/pricing/refresh`) {
      const sourceId = String(body.sourceId || '').trim();
      const goBody = sourceId
        ? { sourceId }
        : { pluginSnapshots: await collectPluginPricingSnapshots(runtime, body.timeoutMs) };
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/refresh',
        body: goBody,
        passStatuses: [400, 404, 409, 502],
        message: 'Go Core 未就绪，价格刷新不可用',
        transform: async (data) => {
          const applied = sourceId
            ? Boolean(data && data.applied === true)
            : Boolean(data && data.pluginRun && Array.isArray(data.pluginRun.sources) && data.pluginRun.sources.some((item) => item && item.applied === true));
          if (applied) await notifyPricingChanged();
          return data;
        }
      });
    } else if (pathname === `${PREFIX}/pricing/quote`) {
      const provider = String(body.provider || '').trim().toLowerCase();
      const model = String(body.model || '').trim();
      if (!provider || !model) {
        writeJson(res, 400, { ok: false, error: 'invalid_payload' });
        return true;
      }
      const lease = runtime.acquire();
      if (!lease) {
        writeJson(res, 503, { ok: false, error: 'plugin_runtime_inactive' });
        return true;
      }
      const quotes = [];
      try {
        for (const item of lease.snapshot.byCapability.get('pricing.quote') || []) {
          try {
            const response = await runtime.invoke(item.id, {
              schemaVersion: 1,
              kind: 'quote',
              provider,
              model,
              accountRef: String(body.accountRef || ''),
              at: new Date().toISOString()
            }, { generation: lease.generation, timeoutMs: Number(body.timeoutMs) || 10_000 });
            const value = response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response;
            const list = Array.isArray(value) ? value : (value && Array.isArray(value.quotes) ? value.quotes : []);
            quotes.push(...list);
          } catch (error) {
            quotes.push({ provider, model, source: { id: String(item.id), kind: 'unknown' }, warnings: [{ code: error?.code || 'pricing_quote_failed' }] });
          }
        }
      } finally {
        lease.release();
      }
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/merge-quotes',
        body: {
          provider,
          model,
          accountRef: String(body.accountRef || '').trim(),
          quotes
        },
        message: 'Go Core 未就绪，报价合并不可用'
      });
    } else if (pathname === `${PREFIX}/pricing/approve`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/approve',
        body: { sourceId: String(body.sourceId || '') },
        message: 'Go Core 未就绪，价格复核批准不可用',
        transform: async (data) => {
          await notifyPricingChanged();
          return data;
        }
      });
    } else if (pathname === `${PREFIX}/pricing/reject`) {
      return proxyWebuiGo(proxyCtx, {
        method: 'POST',
        path: '/v1/management/webui/pricing/reject',
        body: { sourceId: String(body.sourceId || '') },
        message: 'Go Core 未就绪，价格复核拒绝不可用',
        transform: async (data) => {
          await notifyPricingChanged();
          return data;
        }
      });
    } else if (pathname === `${PREFIX}/accounts/import`) {
      result = await account.importSource(body);
    } else if (pathname === `${PREFIX}/accounts/refresh`) {
      result = await account.refresh(body);
    } else if (pathname === `${PREFIX}/accounts/materialize`) {
      result = await account.materialize(body);
    } else if (pathname === `${PREFIX}/install`) {
      // 安装已切 Go：制品校验/签名/清单/CAS 都在 Go，Node 只转发与写审计。
      // file 在 Node 先 resolve 成绝对路径——Go 进程的 cwd 与 Node 不一定相同。
      const installed = await callGoPluginAction({
        writeJson,
        res,
        deps,
        method: 'installPlugin',
        args: [{ file: path.resolve(String(body.file || '')), requireSigned: body.requireSigned === true }],
        message: 'Go Core 未就绪，插件安装不可用'
      });
      if (installed) {
        const signature = installed.signature && typeof installed.signature === 'object' ? installed.signature : { status: 'unsigned' };
        control.audit.append('install', {
          pluginId: installed.pluginId,
          version: installed.version,
          digest: installed.digest,
          signature: signature.status || 'unsigned',
          keyId: signature.keyId || '',
          permissions: installed.permissions || null
        });
      }
      return true;
    } else if (pathname === `${PREFIX}/uninstall`) {
      const removed = await callGoPluginAction({
        writeJson,
        res,
        deps,
        method: 'uninstallPlugin',
        args: [{
          pluginId: body.pluginId,
          version: body.version,
          expectedRevision: body.expectedRevision
        }],
        message: 'Go Core 未就绪，插件卸载不可用'
      });
      if (removed) {
        control.audit.append('uninstall', { pluginId: removed.pluginId, version: removed.version });
      }
      return true;
    }
    else if (pathname === `${PREFIX}/enable`) {
      // 启停入口已切 Go：Node 只做参数兜底与转发，绝不在本地构建候选或写状态。
      const instanceId = String(body.instanceId || body.pluginId || '').trim();
      if (!instanceId) {
        writeJson(res, 400, { ok: false, error: 'plugin_id_required' });
        return true;
      }
      await callGoPluginAction({
        writeJson, res, deps, method: 'enablePlugin', args: [instanceId, body], message: 'Go Core 未就绪，插件启用不可用'
      });
      return true;
    }
    else if (pathname === `${PREFIX}/disable`) {
      const instanceId = String(body.instanceId || '').trim();
      if (!instanceId) {
        writeJson(res, 404, { ok: false, error: 'plugin_instance_unknown', message: `没有实例 ${instanceId}` });
        return true;
      }
      await callGoPluginAction({
        writeJson, res, deps, method: 'disablePlugin', args: [instanceId, body], message: 'Go Core 未就绪，插件停用不可用'
      });
      return true;
    }
    else if (pathname === `${PREFIX}/trust`) {
      // body.file 的读取留在 Node：Go 不接服务器本地路径，只接 PEM 内容。
      const publicKey = body.publicKey || (body.file ? fs.readFileSync(String(body.file), 'utf8') : '');
      const written = await callGoTrustRoute({
        writeJson,
        res,
        deps,
        method: 'addPluginTrustedKey',
        args: [{ publicKey, keyId: body.keyId }]
      });
      // 审计留在 Node：写文件已经成功，审计失败不能反向影响响应（audit.append 自己吞错）。
      if (written) control.audit.append('trust', { keyId: written.keyId, fingerprint: written.fingerprint });
      return true;
    } else if (pathname === `${PREFIX}/untrust`) {
      const written = await callGoTrustRoute({
        writeJson,
        res,
        deps,
        method: 'removePluginTrustedKey',
        args: [body.keyId]
      });
      if (written) control.audit.append('untrust', { keyId: written.keyId, removed: written.removed === true });
      return true;
    } else if (pathname === `${PREFIX}/invoke`) {
      const response = await runtime.invoke(String(body.contributionId || ''), body.value, { timeoutMs: Number(body.timeoutMs) || undefined });
      result = { value: response.value, payloadBytes: response.payload ? response.payload.length : 0 };
    } else {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    writeError(writeJson, res, error);
  }
  return true;
}

module.exports = { handlePluginManagementRequest, PLUGIN_ROUTE_PREFIX: PREFIX };
