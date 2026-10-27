'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createNativePluginManager } = require('../native-resources/native-plugin-manager');
const { createSkillManager } = require('../native-resources/skill-manager');
const { createMcpManager } = require('../native-resources/mcp-manager');
const { createProviderResourceDoctor } = require('../native-resources/provider-resource-doctor');
const { defaultProviderResourceRegistry } = require('../native-resources/provider-resource-registry');
const { runProcess } = require('../../scripts/process-runner');

const ROOT_PATH = '/v0/webui/toolkit/native-resources';
const DEMO_ROOT = path.resolve(__dirname, '..', '..');
const DEMO_SOURCES = Object.freeze({
  plugin: path.join(DEMO_ROOT, 'examples/native-plugins/aih-demo'),
  skill: path.join(DEMO_ROOT, 'assets/provider-skills/aih-demo'),
  mcp: path.join(DEMO_ROOT, 'examples/mcp/aih-demo-server.js')
});
const RESOURCE_TYPES = Object.freeze(['plugin', 'skill', 'mcp']);

const managersByState = new WeakMap();
let fallbackManagers = null;

function json(ctx, status, value) {
  if (typeof ctx.writeJson === 'function') return ctx.writeJson(ctx.res, status, value);
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(value));
  return undefined;
}

function buildManagers(ctx) {
  const deps = ctx.deps || {};
  const options = {
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path
  };
  return {
    plugin: createNativePluginManager(options),
    skill: createSkillManager(options),
    mcp: createMcpManager(options)
  };
}

function getManagers(ctx) {
  if (ctx.deps && ctx.deps.nativeResourceManagers) return ctx.deps.nativeResourceManagers;
  if (ctx.state && typeof ctx.state === 'object') {
    const current = managersByState.get(ctx.state);
    if (current) return current;
    const managers = buildManagers(ctx);
    managersByState.set(ctx.state, managers);
    return managers;
  }
  if (!fallbackManagers) fallbackManagers = buildManagers(ctx);
  return fallbackManagers;
}

function readBody(ctx) {
  return new Promise((resolve, reject) => {
    if (typeof ctx.readRequestBody === 'function') {
      Promise.resolve(ctx.readRequestBody(ctx.req, { maxBytes: 128 * 1024 }))
        .then((value) => resolve(value ? JSON.parse(value.toString('utf8')) : {}), reject);
      return;
    }
    let text = '';
    ctx.req.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 128 * 1024) reject(new Error('native_resource_payload_too_large'));
    });
    ctx.req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); }
    });
    ctx.req.on('error', reject);
  });
}

function normalize(value) { return String(value || '').trim().toLowerCase(); }

function selection(body = {}) {
  const provider = normalize(body.provider);
  const host = normalize(body.host);
  if ((provider && host) || (!provider && !host)) throw Object.assign(new Error('native_resource_selector_required'), { code: 'native_resource_selector_required' });
  return provider ? { provider } : { host };
}

function sourceFor(kind, source) {
  const candidate = path.resolve(String(source || DEMO_SOURCES[kind] || ''));
  const relative = path.relative(DEMO_ROOT, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('native_resource_source_forbidden'), { code: 'native_resource_source_forbidden' });
  }
  if (!fs.existsSync(candidate)) throw Object.assign(new Error('native_resource_source_missing'), { code: 'native_resource_source_missing' });
  return candidate;
}

function managedSnapshot(managers) {
  return {
    plugin: managers.plugin.list().resources,
    skill: managers.skill.list().resources,
    mcp: managers.mcp.list().resources
  };
}

function demoFor(kind) {
  const source = DEMO_SOURCES[kind];
  return {
    source: path.relative(DEMO_ROOT, source),
    command: kind === 'plugin'
      ? 'node scripts/resource-closure-demo.js --skip-skill --skip-mcp'
      : kind === 'skill'
        ? 'node scripts/skill-native-demo.js --provider <provider>'
        : 'node scripts/mcp-native-demo.js'
  };
}

function demoSpec(selection, kind) {
  const id = selection.provider || selection.host || '';
  if (kind === 'plugin' && selection.host === 'deepseek') return { command: 'node scripts/deepseek-plugin-managed-demo.mjs', args: ['scripts/deepseek-plugin-managed-demo.mjs'] };
  if (kind === 'plugin' && selection.host === 'pi') return { command: 'node scripts/pi-plugin-native-demo.js --managed', args: ['scripts/pi-plugin-native-demo.js', '--managed'] };
  if (kind === 'plugin' && selection.host === 'aih') return { command: 'node scripts/aih-portable-plugin-demo.js', args: ['scripts/aih-portable-plugin-demo.js'] };
  if (kind === 'plugin' && ['codex', 'claude'].includes(id)) return { command: `node scripts/native-plugin-use-demo.js ${id}`, args: ['scripts/native-plugin-use-demo.js', id] };
  if (kind === 'plugin' && id === 'opencode') return { command: 'node scripts/opencode-plugin-native-demo.js', args: ['scripts/opencode-plugin-native-demo.js'] };
  if (kind === 'skill' && ['codex', 'claude', 'opencode'].includes(id)) return { command: `node scripts/skill-native-demo.js --provider ${id}`, args: ['scripts/skill-native-demo.js', '--provider', id] };
  if (kind === 'mcp' && ['codex', 'claude', 'opencode', 'cline', 'workbuddy'].includes(id)) return { command: `node scripts/${id}-mcp-tool-loop-demo.js`, args: [`scripts/${id}-mcp-tool-loop-demo.js`] };
  return null;
}

function report(ctx) {
  const managers = getManagers(ctx);
  const doctor = createProviderResourceDoctor({
    hostHomeDir: ctx.hostHomeDir || ctx.deps?.hostHomeDir,
    aiHomeDir: ctx.aiHomeDir || ctx.deps?.aiHomeDir
  }).capabilities();
  const managed = managedSnapshot(managers);
  const providers = (doctor.providers || []).map((row) => ({
    ...row,
    resources: Object.fromEntries(RESOURCE_TYPES.map((kind) => ({
      kind,
      capability: row.resources?.[kind] || { state: 'unsupported', reason: 'resource_not_declared' },
      managed: managed[kind].filter((record) => record.provider === row.provider)
    })).map(({ kind, capability, managed: records }) => [kind, {
      ...capability,
      managed: records,
      demo: demoFor(kind)
    }]))
  }));
  const hosts = (doctor.hostAdapters || []).map((row) => ({
    ...row,
    resources: {
      plugin: {
        capability: row.state === 'supported'
          ? { state: 'supported' }
          : { state: 'projection-only', reason: row.reason || 'host_runtime_unavailable' },
        managed: managed.plugin.filter((record) => record.host === row.host),
        demo: demoFor('plugin')
      }
    }
  }));
  return {
    ok: true,
    source: doctor.source,
    demoSources: Object.fromEntries(Object.entries(DEMO_SOURCES).map(([kind, source]) => [kind, path.relative(DEMO_ROOT, source)])),
    providers,
    hosts,
    managed,
    lifecycle: ['install', 'enable', 'disable', 'remove'],
    evidenceBoundary: 'management state and runtime declaration; native use is proven by the linked demo command'
  };
}

async function operate(ctx, body) {
  const kind = normalize(body.kind);
  if (!RESOURCE_TYPES.includes(kind)) throw Object.assign(new Error('native_resource_kind_invalid'), { code: 'native_resource_kind_invalid' });
  const managers = getManagers(ctx);
  const target = selection(body);
  const manager = managers[kind];
  const action = normalize(body.action || 'install');
  if (action === 'demo') {
    const spec = demoSpec(selection(body), kind);
    if (!spec || !fs.existsSync(path.join(DEMO_ROOT, spec.args[0]))) throw Object.assign(new Error('native_resource_demo_unavailable'), { code: 'native_resource_demo_unavailable' });
    const execution = await runProcess(process.execPath, spec.args, {
      cwd: DEMO_ROOT,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
      timeoutMs: 5 * 60 * 1000,
      maxOutput: 8 * 1024 * 1024,
      stopWhen: (output) => {
        try { const value = JSON.parse(String(output || '').trim()); return value && value.passed === true; } catch (_) { return false; }
      }
    });
    const output = String(execution.stdout || '').trim();
    let evidence = null;
    try { evidence = JSON.parse(output); } catch (_) {}
    if (execution.status !== 0 || !evidence || evidence.passed !== true) throw Object.assign(new Error('native_resource_demo_failed'), { code: 'native_resource_demo_failed', detail: { status: execution.status, timedOut: execution.timedOut, stderr: String(execution.stderr || '').slice(-2000) } });
    return { ok: true, kind, action, selection, demo: { ...spec, evidence } };
  }
  let result;
  if (kind === 'plugin') {
    if (action === 'install') result = manager.install(sourceFor(kind, body.source), target);
    else result = manager[action](String(body.id || '').trim(), target);
  } else if (kind === 'skill') {
    if (action === 'install') result = manager.install(sourceFor(kind, body.source), target);
    else result = manager[action](String(body.id || '').trim(), target);
  } else {
    const id = String(body.id || 'aih-demo').trim();
    if (action === 'install') {
      manager.add(id, { command: process.execPath, args: [sourceFor(kind, body.source)] }, target);
      result = manager.enable(id, target);
    } else if (action === 'test' || action === 'tools') result = await manager[action](id, target);
    else if (action === 'call') result = await manager.call(id, String(body.tool || 'aih_echo'), body.args || { text: 'AIH_WEBUI_MCP_OK' }, target);
    else result = manager[action](id, target);
  }
  return { ok: true, kind, action, selection: target, result, report: report(ctx) };
}

function matchNativeResourceRoute(method, pathname) {
  return pathname === ROOT_PATH && ['GET', 'POST'].includes(String(method || '').toUpperCase());
}

async function handleWebUiNativeResourceRequest(ctx = {}) {
  const method = String(ctx.method || ctx.req?.method || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  if (!matchNativeResourceRoute(method, pathname)) return false;
  try {
    if (method === 'GET') return json(ctx, 200, report(ctx)), true;
    const body = await readBody(ctx);
    return json(ctx, 200, await operate(ctx, body || {})), true;
  } catch (error) {
    const code = error && (error.code || error.message) || 'native_resource_operation_failed';
    const status = code === 'native_resource_payload_too_large' ? 413
      : /required|invalid|forbidden|missing|unsupported/.test(code) ? 400 : 409;
    return json(ctx, status, { ok: false, error: code }), true;
  }
}

module.exports = { ROOT_PATH, DEMO_SOURCES, matchNativeResourceRoute, handleWebUiNativeResourceRequest };
