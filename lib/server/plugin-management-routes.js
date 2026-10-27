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
  'permissionGateVerified', 'legacyManifestProtocol', 'transportProtocolVersion', 'node'
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
    if (method === 'GET' && pathname === PREFIX) {
      writeJson(res, 200, { ok: true, ...control.list(), runtime: runtime.status() });
      return true;
    }
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
