'use strict';

// One command for the resource closure requested by the product surface.
// Existing host-specific demos remain the executable evidence; this script only
// composes their bounded JSON reports and joins them with the descriptor report.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const { createProviderResourceDoctor } = require('../lib/native-resources/provider-resource-doctor');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { createSkillManager } = require('../lib/native-resources/skill-manager');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEMO_PLUGIN = path.join(ROOT, 'examples/native-plugins/aih-demo');
const DEMO_SKILL = path.join(ROOT, 'assets/provider-skills/aih-demo');
const DEMO_MCP = path.join(ROOT, 'examples/mcp/aih-demo-server.js');

function parseArgs(argv) {
  const options = {
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skip: new Set(),
    geminiBinary: '',
    codebuddyBinary: '',
    codebuddyCnBinary: '',
    workbuddyCnBinary: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--timeout-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1000) throw new Error('timeout_ms_invalid');
      options.timeoutMs = value;
    } else if (arg === '--gemini-binary') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('gemini_binary_required');
      options.geminiBinary = value;
    } else if (arg === '--codebuddy-binary') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('codebuddy_binary_required');
      options.codebuddyBinary = value;
    } else if (arg === '--codebuddycn-binary') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('codebuddycn_binary_required');
      options.codebuddyCnBinary = value;
    } else if (arg === '--workbuddycn-binary') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('workbuddycn_binary_required');
      options.workbuddyCnBinary = value;
    } else if (arg.startsWith('--skip-')) {
      options.skip.add(arg.slice('--skip-'.length));
    } else {
      throw new Error(`unknown_option:${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/resource-closure-demo.js [options]',
    '',
    'Runs the existing native Plugin, Skill, MCP, and imported-host demos,',
    'then joins their evidence with provider capabilities.',
    '',
    '  --json                 Emit one machine-readable report',
    '  --timeout-ms <n>       Per-demo timeout (default: 300000)',
    '  --skip-plugin          Skip native-plugin-demo.js',
    '  --skip-skill           Skip Codex/Claude/OpenCode Skill demos',
    '  --skip-mcp             Skip mcp-native-demo.js',
    '  --gemini-binary <path> Use this Gemini CLI for extension/Skill evidence',
    '  --codebuddy-binary <path>   Use this CodeBuddy CLI for native resource evidence',
    '  --codebuddycn-binary <path> Use this CodeBuddy CN CLI for native resource evidence',
    '  --workbuddycn-binary <path> Use this WorkBuddy CN bundled CLI for native resource evidence',
    '  --skip-gemini          Skip the Gemini extension/Skill demo',
    '  --skip-workbuddy       Skip the WorkBuddy provider demo'
  ].join('\n');
}

function runJsonCommand(args, timeoutMs) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  let value = null;
  try { value = JSON.parse(stdout); } catch (_error) {}
  return {
    command: args.slice(1),
    status: result.status,
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    passed: result.status === 0 && Boolean(value && value.passed !== false),
    value,
    error: result.error ? String(result.error.code || result.error.message || result.error) : '',
    stderr: stderr.slice(0, 2000)
  };
}

function readCapabilities(options = {}) {
  // A demo may use an explicitly supplied native binary that is intentionally
  // outside PATH (for example an isolated Gemini fixture).  Pass that same
  // binary to the doctor so the report does not combine positive native-use
  // evidence with an unrelated PATH-only "runtime unavailable" result.
  const nativeBinaries = Object.fromEntries([
    ['gemini', options.geminiBinary],
    ['codebuddy', options.codebuddyBinary],
    ['codebuddycn', options.codebuddyCnBinary],
    ['workbuddycn', options.workbuddyCnBinary]
  ].filter(([, binary]) => Boolean(binary)));
  const report = createProviderResourceDoctor({
    hostHomeDir: process.env.HOME || process.env.USERPROFILE,
    probeRuntime: true,
    ...(Object.keys(nativeBinaries).length ? { nativeBinaries } : {})
  }).capabilities();
  if (!report || !Array.isArray(report.providers)) throw new Error('provider_capabilities_failed');
  return report;
}

async function runManagementLifecycle(capabilities, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-resource-management-'));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'host');
  const nativeBinaries = Object.fromEntries([
    ['gemini', options.geminiBinary],
    ['codebuddy', options.codebuddyBinary],
    ['codebuddycn', options.codebuddyCnBinary],
    ['workbuddycn', options.workbuddyCnBinary]
  ].filter(([, binary]) => Boolean(binary)));
  const managerOptions = {
    aiHomeDir,
    hostHomeDir,
    ...(Object.keys(nativeBinaries).length ? { nativeBinaries } : {})
  };
  const pluginManager = createNativePluginManager(managerOptions);
  const skillManager = createSkillManager(managerOptions);
  const mcpManager = createMcpManager({ aiHomeDir, hostHomeDir });
  const result = { providers: {}, passed: true };
  try {
    for (const row of capabilities.providers || []) {
      const provider = row.provider;
      const resources = {};
      const record = (resource, value) => { resources[resource] = value; if (value.status === 'failed') result.passed = false; };
      if (row.resources?.plugin?.state === 'supported') {
        try {
          pluginManager.install(DEMO_PLUGIN, { provider });
          const listed = pluginManager.list({ provider }).resources.length === 1;
          pluginManager.disable('aih-demo', { provider });
          pluginManager.enable('aih-demo', { provider });
          const healthy = pluginManager.doctor({ provider }).healthy;
          pluginManager.remove('aih-demo', { provider });
          record('plugin', { status: listed && healthy ? 'verified' : 'failed', lifecycle: 'install-disable-enable-remove-doctor' });
        } catch (error) {
          record('plugin', { status: 'unavailable', reason: error.code || error.message });
        }
      } else record('plugin', { status: 'unsupported', reason: row.resources?.plugin?.reason || 'unsupported' });
      if (row.resources?.skill?.state !== 'unsupported') {
        try {
          skillManager.install(DEMO_SKILL, { provider });
          const listed = skillManager.list({ provider }).resources.length === 1;
          skillManager.disable('aih-demo', { provider });
          skillManager.enable('aih-demo', { provider });
          const healthy = skillManager.doctor({ provider }).healthy;
          skillManager.remove('aih-demo', { provider });
          record('skill', { status: listed && healthy ? 'verified' : 'failed', lifecycle: 'install-disable-enable-remove-doctor' });
        } catch (error) {
          record('skill', { status: 'unavailable', reason: error.code || error.message });
        }
      } else record('skill', { status: 'unsupported', reason: row.resources?.skill?.reason || 'unsupported' });
      if (row.resources?.mcp?.projection) {
        try {
          const name = `aih-demo-${crypto.randomUUID().slice(0, 8)}`;
          mcpManager.add(name, { command: process.execPath, args: [DEMO_MCP] }, { provider });
          const test = await mcpManager.test(name, { provider });
          mcpManager.enable(name, { provider });
          const healthy = mcpManager.doctor({ provider }).healthy;
          mcpManager.disable(name, { provider });
          mcpManager.remove(name, { provider });
          record('mcp', { status: test?.ok && healthy ? 'verified' : 'failed', lifecycle: 'add-test-enable-disable-remove-doctor' });
        } catch (error) {
          record('mcp', { status: 'unavailable', reason: error.code || error.message });
        }
      } else record('mcp', { status: 'unsupported', reason: row.resources?.mcp?.reason || 'projection_missing' });
      result.providers[provider] = resources;
    }
    return result;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function addEvidence(map, key, evidence) {
  if (!key || !evidence) return;
  const list = map.get(key) || [];
  list.push(evidence);
  map.set(key, list);
}

function indexNativePlugin(report, evidence) {
  for (const row of Array.isArray(report && report.stages) ? report.stages : []) {
    const key = row.provider ? `provider:${row.provider}:plugin` : row.host ? `host:${row.host}:plugin` : '';
    if (!key) continue;
    addEvidence(evidence, key, {
      source: 'native-plugin-demo',
      passed: row.passed === true,
      managementLifecycle: row.passed === true,
      nativeUse: row.pluginUseVerified === true || row.evidence?.passed === true,
      version: row.version || row.evidence?.version || null,
      detail: row.pluginUseVerified === true ? 'native plugin body used by host' : 'native lifecycle/projection demo'
    });
    if (row.provider === 'opencode') addEvidence(evidence, 'host:opencode:plugin', {
      source: 'native-plugin-demo',
      passed: row.passed === true,
      managementLifecycle: row.passed === true,
      nativeUse: row.pluginUseVerified === true || row.evidence?.passed === true,
      version: row.version || row.evidence?.version || null,
      detail: 'native OpenCode server plugin loop'
    });
  }
}

function indexSkill(report, evidence) {
  const key = report && report.provider ? `provider:${report.provider}:skill` : '';
  if (!key) return;
  addEvidence(evidence, key, {
    source: 'skill-native-demo',
    passed: report.passed === true,
    managementLifecycle: report.passed === true,
    nativeUse: report.passed === true && Array.isArray(report.stages)
      && report.stages.some(stage => stage.marker === true),
    version: null,
    detail: 'native skill body observed in model request'
  });
}

function indexMcp(report, evidence) {
  for (const row of Array.isArray(report && report.stages) ? report.stages : []) {
    const key = row.provider ? `provider:${row.provider}:mcp` : '';
    if (!key) continue;
    const loop = row.nativeToolLoop;
    addEvidence(evidence, key, {
      source: 'mcp-native-demo',
      passed: row.passed === true,
      managementLifecycle: row.passed === true,
      nativeUse: loop ? loop.toolExecutionVerified === true : false,
      version: typeof row.version === 'string' ? row.version : row.version?.stdout?.trim() || null,
      detail: loop?.toolExecutionVerified === true
        ? 'native model/tool loop observed'
        : 'native configuration and direct MCP call observed'
    });
  }
}

function indexGemini(report, evidence) {
  if (!report || report.host !== 'gemini') return;
  const passed = report.passed === true;
  addEvidence(evidence, 'provider:gemini:plugin', {
    source: 'gemini-resource-native-demo', passed, managementLifecycle: passed,
    nativeUse: passed, version: report.version || null, detail: 'native extension Skill activation observed'
  });
  addEvidence(evidence, 'provider:gemini:skill', {
    source: 'gemini-resource-native-demo', passed, managementLifecycle: passed,
    nativeUse: passed, version: report.version || null, detail: 'native managed Skill activation observed'
  });
}

function indexWorkBuddy(report, evidence) {
  if (!report || !report.host) return;
  const passed = report.passed === true;
  for (const resource of ['plugin', 'skill', 'mcp']) {
    // The WorkBuddy-family probe proves native plugin/Skill loading through the
    // model fixture. Its MCP section currently proves projection, connection,
    // direct tools/list and tools/call, but not that the model autonomously
    // selected the MCP tool and received the result. Keep that evidence level
    // explicit instead of upgrading direct stdio use to native agent use.
    const nativeUse = resource === 'mcp'
      ? report.mcp?.nativeAgentToolLoopVerified === true
      : passed;
    addEvidence(evidence, `provider:${report.host}:` + resource, {
      source: 'workbuddy-resource-native-demo', passed, managementLifecycle: passed,
      nativeUse, version: report.runtime || null,
      detail: resource === 'mcp' ? 'native connected and direct tools called' : 'native body/resource observed'
    });
  }
}

function summarizeResource(capability, entries) {
  const declared = capability && capability.state ? capability.state : 'unsupported';
  if (!entries.length) {
    return {
      declared,
      management: 'unverified',
      use: 'unverified',
      reason: capability && capability.reason || 'no_runtime_demo_evidence'
    };
  }
  const passed = entries.every(entry => entry.passed === true);
  const used = entries.some(entry => entry.nativeUse === true);
  return {
    declared,
    management: passed && entries.some(entry => entry.managementLifecycle) ? 'verified' : 'failed',
    use: used ? 'verified' : 'not_proven',
    evidence: entries.map(({ source, passed: ok, nativeUse, detail, version }) => ({
      source, passed: ok, nativeUse, detail, ...(version ? { version } : {})
    }))
  };
}

async function buildReport(options) {
  const capabilities = readCapabilities(options);
  const evidence = new Map();
  const demos = [];
  const management = await runManagementLifecycle(capabilities, options);
  const run = (id, args, indexer) => {
    if (options.skip.has(id)) return;
    const result = runJsonCommand(args, options.timeoutMs);
    demos.push({ id, ...result });
    if (result.value) indexer(result.value, evidence);
  };

  run('plugin', ['scripts/native-plugin-demo.js'], indexNativePlugin);
  if (!options.skip.has('skill')) {
    for (const provider of ['codex', 'claude', 'opencode']) {
      const result = runJsonCommand(['scripts/skill-native-demo.js', '--provider', provider], options.timeoutMs);
      demos.push({ id: `skill:${provider}`, ...result });
      if (result.value) indexSkill(result.value, evidence);
    }
  }
  run('mcp', ['scripts/mcp-native-demo.js'], indexMcp);
  if (!options.skip.has('gemini')) {
    const binary = options.geminiBinary || (() => {
      const candidates = ['/tmp/aih-gemini-resource-runtime/node_modules/.bin/gemini', 'gemini'];
      return candidates.find(candidate => candidate === 'gemini' || fs.existsSync(candidate)) || '';
    })();
    if (binary && (binary === 'gemini' || fs.existsSync(binary))) {
      const result = runJsonCommand(['scripts/gemini-resource-native-demo.js', binary], options.timeoutMs);
      demos.push({ id: 'gemini', ...result });
      if (result.value) indexGemini(result.value, evidence);
    } else {
      demos.push({ id: 'gemini', skipped: true, reason: 'gemini_binary_unavailable' });
    }
  }
  if (!options.skip.has('workbuddy')) {
    const result = runJsonCommand(['scripts/workbuddy-resource-native-demo.js'], options.timeoutMs);
    demos.push({ id: 'workbuddy', ...result });
    if (result.value) indexWorkBuddy(result.value, evidence);
  }
  const importedProviderDemos = [
    ['codebuddy', options.codebuddyBinary],
    ['codebuddycn', options.codebuddyCnBinary],
    ['workbuddycn', options.workbuddyCnBinary]
  ];
  for (const [provider, binary] of importedProviderDemos) {
    if (!binary || options.skip.has(provider)) continue;
    const result = runJsonCommand([
      'scripts/workbuddy-resource-native-demo.js',
      '--provider', provider,
      '--binary', binary
    ], options.timeoutMs);
    demos.push({ id: provider, ...result });
    if (result.value) indexWorkBuddy(result.value, evidence);
  }

  const providers = (capabilities.providers || []).map(row => ({
    provider: row.provider,
    runtime: row.runtime,
    resources: Object.fromEntries(['plugin', 'skill', 'mcp'].map(resource => [
      resource,
      summarizeResource(row.resources && row.resources[resource], evidence.get(`provider:${row.provider}:${resource}`) || [])
    ]))
  }));
  const hosts = (capabilities.hostAdapters || []).map(row => ({
    host: row.host,
    runtime: row.runtime || null,
    state: row.state,
    reason: row.reason,
    plugin: summarizeResource({ state: row.state, reason: row.reason }, evidence.get(`host:${row.host}:plugin`) || [])
  }));
  const gaps = [];
  for (const row of providers) {
    for (const [resource, result] of Object.entries(row.resources)) {
      if (result.declared === 'supported' && result.management !== 'verified') gaps.push({ scope: 'provider', id: row.provider, resource, gap: 'supported_but_management_unverified' });
      if (result.management === 'verified' && result.use !== 'verified') gaps.push({ scope: 'provider', id: row.provider, resource, gap: 'managed_but_native_use_unproven' });
    }
  }
  for (const row of hosts) {
    if (row.state === 'supported' && row.plugin.management !== 'verified') gaps.push({ scope: 'host', id: row.host, resource: 'plugin', gap: 'supported_but_native_use_unverified' });
  }
  return {
    generatedAt: new Date().toISOString(),
    evidenceBoundary: 'local deterministic fixtures and installed native clients; no remote-model success claim',
    passed: management.passed && demos.filter(item => !item.skipped).every(item => item.passed === true),
    demos: demos.map(({ value, ...item }) => ({ ...item, ...(value ? { report: value } : {}) })),
    management,
    providers,
    hosts,
    gaps
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  const report = await buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Resource closure: ${report.passed ? 'demo commands passed' : 'demo failures present'}`);
    for (const row of report.providers) console.log(`${row.provider}  runtime=${row.runtime?.available ? 'available' : 'unavailable'}  plugin=${row.resources.plugin.use}  skill=${row.resources.skill.use}  mcp=${row.resources.mcp.use}`);
    for (const row of report.hosts) console.log(`host/${row.host}  ${row.state}  plugin=${row.plugin.use}`);
    if (report.gaps.length) console.log(`Gaps: ${report.gaps.length} (use --json for details)`);
  }
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  main().then(result => { process.exitCode = result; }).catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = { buildReport, parseArgs, summarizeResource };
