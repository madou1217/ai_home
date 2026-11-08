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
const { addTrustedKey, listTrustedKeys, removeTrustedKey } = require('../plugins/control/signature');
const { mergePriceQuotes } = require('../usage/pricing/merge-quotes');
const {
  COMMUNITY_PRICING_SOURCES,
  refreshCommunitySource
} = require('../usage/pricing/community-sources');

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

const GO_INVENTORY_UNAVAILABLE = 'go_core_unavailable';

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
      error: GO_INVENTORY_UNAVAILABLE,
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
      error: String(domainCode || (response && response.errorCode) || GO_INVENTORY_UNAVAILABLE),
      message: 'Go Core 未就绪，插件清单不可读'
    });
    return;
  }
  writeJson(res, 200, mapPluginInventory(response.data));
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
  const { account, control, pricing, runtime } = getPluginSystem(ctx.state, { aiHomeDir: deps.aiHomeDir });
  const pricingStore = pricing && typeof pricing.store === 'function' ? pricing.store() : null;
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
      const pricingReport = pricingStore ? {
        sources: pricingStore.listSources().map((source) => ({
          sourceId: source.sourceId,
          kind: source.source.kind,
          fetchedAt: source.fetchedAt,
          quotes: source.quotes.length
        })),
        pendingReviews: pricingStore.listReviews({ status: 'pending' }).length,
        reviews: pricingStore.listReviews({ status: 'pending' }).slice(0, 20),
        records: pricingStore.buildPricingRecords().length,
        lastRun: pricing.lastReport ? pricing.lastReport() : null
      } : null;
      writeJson(res, 200, { ok: true, ...report, pricing: pricingReport, healthy: report.ok });
      return true;
    }
    if (method === 'POST' && pathname === `${PREFIX}/demo`) {
      writeJson(res, 200, { ok: true, demo: await runPortablePluginDemo() });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/pricing/sources`) {
      if (!pricingStore) {
        writeJson(res, 503, { ok: false, error: 'pricing_source_store_unavailable' });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        communitySources: COMMUNITY_PRICING_SOURCES,
        sources: pricingStore.listSources().map((source) => ({
          sourceId: source.sourceId,
          source: source.source,
          fetchedAt: source.fetchedAt,
          appliedAt: source.appliedAt,
          quotes: source.quotes.length
        })),
        reviews: pricingStore.listReviews({ status: 'pending' })
      });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/pricing/reviews`) {
      if (!pricingStore) {
        writeJson(res, 503, { ok: false, error: 'pricing_source_store_unavailable' });
        return true;
      }
      const status = new URL(req.url || '/', 'http://localhost').searchParams.get('status') || '';
      writeJson(res, 200, { ok: true, reviews: pricingStore.listReviews({ status }) });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/pricing/status`) {
      writeJson(res, 200, {
        ok: true,
        running: Boolean(pricing),
        lastRun: pricing && pricing.lastReport ? pricing.lastReport() : null,
        sources: pricingStore ? pricingStore.listSources().length : 0,
        pendingReviews: pricingStore ? pricingStore.listReviews({ status: 'pending' }).length : 0
      });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/accounts/sources`) {
      const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider') || '';
      const listed = await account.listSources(provider);
      writeJson(res, 200, { ok: true, ...listed });
      return true;
    }
    if (method === 'GET' && pathname === `${PREFIX}/trusted`) {
      writeJson(res, 200, { ok: true, keys: listTrustedKeys(deps.aiHomeDir) });
      return true;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJson(req);
    let result;
    if (pathname === `${PREFIX}/pricing/refresh`) {
      if (!pricingStore) {
        writeJson(res, 503, { ok: false, error: 'pricing_source_store_unavailable' });
        return true;
      }
      const sourceId = String(body.sourceId || '').trim();
      if (sourceId) {
        if (!COMMUNITY_PRICING_SOURCES.some((source) => source.id === sourceId)) {
          writeJson(res, 400, { ok: false, error: 'community_pricing_source_unknown' });
          return true;
        }
        result = await refreshCommunitySource(sourceId, {
          store: pricingStore,
          fetchImpl: deps.fetch || globalThis.fetch,
          // 管理面也只能触发采集，不能绕过复核门直接改计费事实。
          requireReview: true
        });
        if (result.applied) await notifyPricingChanged();
      } else {
        const reports = await pricing.syncNow({ community: true });
        result = { pluginRun: reports };
        if (Array.isArray(reports.sources) && reports.sources.some((item) => item.applied === true)) {
          await notifyPricingChanged();
        }
      }
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
      result = mergePriceQuotes(quotes, { provider, model, accountRef: body.accountRef, now: Date.now() });
      result = { quote: result, contributions: quotes.length };
    } else if (pathname === `${PREFIX}/pricing/approve`) {
      if (!pricingStore) {
        writeJson(res, 503, { ok: false, error: 'pricing_source_store_unavailable' });
        return true;
      }
      result = pricingStore.approveSource(body.sourceId);
      await notifyPricingChanged();
    } else if (pathname === `${PREFIX}/pricing/reject`) {
      if (!pricingStore) {
        writeJson(res, 503, { ok: false, error: 'pricing_source_store_unavailable' });
        return true;
      }
      result = pricingStore.rejectSource(body.sourceId);
      await notifyPricingChanged();
    } else if (pathname === `${PREFIX}/accounts/import`) {
      result = await account.importSource(body);
    } else if (pathname === `${PREFIX}/accounts/refresh`) {
      result = await account.refresh(body);
    } else if (pathname === `${PREFIX}/accounts/materialize`) {
      result = await account.materialize(body);
    } else if (pathname === `${PREFIX}/install`) {
      result = control.install(body.file, { requireSigned: body.requireSigned === true });
    } else if (pathname === `${PREFIX}/uninstall`) result = control.uninstall(body);
    else if (pathname === `${PREFIX}/enable`) result = await control.enable(body);
    else if (pathname === `${PREFIX}/disable`) result = await control.disable(body);
    else if (pathname === `${PREFIX}/trust`) {
      const publicKey = body.publicKey || (body.file ? fs.readFileSync(String(body.file), 'utf8') : '');
      result = addTrustedKey(deps.aiHomeDir, { publicKey, keyId: body.keyId });
      control.audit.append('trust', { keyId: result.keyId, fingerprint: result.fingerprint });
    } else if (pathname === `${PREFIX}/untrust`) {
      result = removeTrustedKey(deps.aiHomeDir, body.keyId);
      control.audit.append('untrust', { keyId: result.keyId, removed: result.removed === true });
    } else if (pathname === `${PREFIX}/trusted`) {
      result = { keys: listTrustedKeys(deps.aiHomeDir) };
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
