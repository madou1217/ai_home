'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const YAML = require('yaml');
const { buildManagedHostPluginArgs } = require('../native-resources/host-plugin-runtime');
const {
  ensureRequestedModel,
  fetchGatewayModelCatalog,
  withModelMetadata
} = require('./gateway-catalog');
const {
  buildHarnessModelEntries,
  linkHostSessions,
  resolveHarnessProjectionRoot,
  writePrivateJson,
  writePrivateText
} = require('./projection');

const PROFILE_NAME = 'aih';
const WRAPPER_FILE = 'run-dsh.mjs';
const MODEL_REFRESH_FILE = 'aih-model-refresh.mjs';
const MODEL_REFRESH_ENTRY = 'aih-model-refresh';
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PNPM_WORKSPACE_YML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`;

function normalizeText(value) {
  return String(value || '').trim();
}

function buildDshModels(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    id: entry.id,
    name: entry.name || entry.id,
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
    input: Array.isArray(entry.input) && entry.input.length ? entry.input : ['text']
  }));
}

function buildDshProviderConfig(input = {}) {
  const headers = {
    'x-aih-route-owner': 'node'
  };
  const accountRef = normalizeText(input.accountRef);
  if (accountRef) headers['x-account-ref'] = accountRef;
  return {
    displayName: 'AIH Gateway',
    apiKeyEnv: 'OPENAI_API_KEY',
    api: 'openai-completions',
    baseURL: normalizeText(input.baseUrl).replace(/\/+$/, ''),
    headers,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens'
    },
    models: buildDshModels(input.models)
  };
}

function parseDshPatch(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  let parsed = null;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    const wrapped = new Error(`dsh_patch_parse_failed: ${error && error.message || error}`);
    wrapped.code = 'dsh_patch_parse_failed';
    throw wrapped;
  }
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    const wrapped = new Error('dsh_patch_parse_failed: cordis.patch.yml must be a YAML array');
    wrapped.code = 'dsh_patch_parse_failed';
    throw wrapped;
  }
  return parsed;
}

function mergeDshPatchEntries(entries, input = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => (normalizeText(entry.id) ? { ...entry } : entry));
  let llm = list.find((entry) => entry.id === 'llm-pi-ai');
  if (!llm) {
    llm = { id: 'llm-pi-ai', config: {} };
    list.push(llm);
  }
  const llmConfig = llm.config && typeof llm.config === 'object' && !Array.isArray(llm.config)
    ? { ...llm.config }
    : {};
  const providers = llmConfig.providers && typeof llmConfig.providers === 'object' && !Array.isArray(llmConfig.providers)
    ? { ...llmConfig.providers }
    : {};
  providers.aih = buildDshProviderConfig(input);
  llmConfig.providers = providers;
  llm.config = llmConfig;

  let defaultModel = list.find((entry) => entry.id === 'agent-default-model');
  if (!defaultModel) {
    defaultModel = { id: 'agent-default-model', config: {} };
    list.push(defaultModel);
  }
  const defaultConfig = defaultModel.config && typeof defaultModel.config === 'object' && !Array.isArray(defaultModel.config)
    ? { ...defaultModel.config }
    : {};
  defaultModel.config = {
    ...defaultConfig,
    provider: 'aih',
    model: normalizeText(input.model)
  };
  return withDshModelRefreshEntry(list, input);
}

function serializeDshPatch(entries) {
  return `${PATCH_HEADER}${YAML.stringify(entries, { lineWidth: 0 })}`;
}

// 模型目录热更新插件：profile 里的本地 Cordis 插件（name 用相对路径，
// loader 以 profile 目录为 baseUrl 解析）。插件轮询网关 /v1/models，发现
// 变化就经 settings 服务改写同一份 profile patch；providers 是 volatile 字段，
// llm-pi-ai 会就地换掉 provider 目录，TUI / WebUI 下一次打开模型列表即可见。
function ensureDshModelRefresh(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const profileDir = normalizeText(input.profileDir);
  if (!profileDir) throw new Error('dsh_profile_dir_missing');
  const source = normalizeText(input.source)
    || fsImpl.readFileSync(pathImpl.join(__dirname, MODEL_REFRESH_FILE), 'utf8');
  const target = pathImpl.join(profileDir, MODEL_REFRESH_FILE);
  writePrivateText(fsImpl, target, source);
  return target;
}

// patch 的 config 是整块替换而不是深合并，因此每次都要重述完整配置。
// 新插件只能用 insert 行引入：非 insert 的扁平行按 id 覆盖已有条目，
// 目标不存在时会被 DSH 警告并跳过。
function withDshModelRefreshEntry(entries, input = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const config = {
    settingsNamespace: 'llm-pi-ai',
    provider: 'aih',
    intervalMs: Number(input.intervalMs) > 0 ? Math.trunc(Number(input.intervalMs)) : 5 * 60 * 1000
  };
  // 早期版本误把新插件写成扁平行（按 id 覆盖、目标不存在会被跳过），
  // 这里顺手清掉，统一收敛到 insert 行。
  const list = source.filter((row) => !(row && typeof row === 'object' && row.id === MODEL_REFRESH_ENTRY));
  for (const row of list) {
    if (!row || typeof row !== 'object' || !Array.isArray(row.insert)) continue;
    const inserted = row.insert.find((item) => item && typeof item === 'object' && item.id === MODEL_REFRESH_ENTRY);
    if (!inserted) continue;
    inserted.config = {
      ...(inserted.config && typeof inserted.config === 'object' && !Array.isArray(inserted.config)
        ? inserted.config
        : {}),
      ...config
    };
    return list;
  }
  list.push({
    insert: [{
      id: MODEL_REFRESH_ENTRY,
      name: `./${MODEL_REFRESH_FILE}`,
      config
    }]
  });
  return list;
}

function readJsonFile(fsImpl, filePath, fallback) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function ensureDshProfile(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const dshHome = normalizeText(input.dshHome);
  if (!dshHome) throw new Error('dsh_home_missing');
  const profileDir = pathImpl.join(dshHome, 'profiles', PROFILE_NAME);
  fsImpl.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  ensureDshModelRefresh({
    fs: fsImpl,
    path: pathImpl,
    profileDir,
    source: input.modelRefreshSource
  });

  const cordisPath = pathImpl.join(profileDir, 'cordis.yml');
  if (!fsImpl.existsSync(cordisPath)) {
    writePrivateText(fsImpl, cordisPath, CORDIS_YML);
  }
  const workspacePath = pathImpl.join(profileDir, 'pnpm-workspace.yaml');
  if (!fsImpl.existsSync(workspacePath)) {
    writePrivateText(fsImpl, workspacePath, PNPM_WORKSPACE_YML);
  }

  const packagePath = pathImpl.join(profileDir, 'package.json');
  const pkg = readJsonFile(fsImpl, packagePath, {});
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? { ...pkg.dsh } : {};
  const profile = dsh.profile && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile) ? { ...dsh.profile } : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.slice() : [];
  for (const bundle of PROFILE_BUNDLES) {
    if (!bundles.includes(bundle)) bundles.push(bundle);
  }
  profile.bundles = bundles;
  dsh.profile = profile;
  const nextPackage = {
    name: normalizeText(pkg.name) || `dsh-profile-${PROFILE_NAME}`,
    private: pkg.private !== false,
    dependencies: pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {},
    ...pkg,
    dsh
  };
  writePrivateJson(fsImpl, packagePath, nextPackage);

  const patchPath = pathImpl.join(profileDir, 'cordis.patch.yml');
  const existing = fsImpl.existsSync(patchPath)
    ? fsImpl.readFileSync(patchPath, 'utf8')
    : '[]\n';
  const entries = mergeDshPatchEntries(parseDshPatch(existing), input);
  writePrivateText(fsImpl, patchPath, serializeDshPatch(entries));
  return {
    profileDir,
    profileName: PROFILE_NAME,
    packagePath,
    patchPath,
    cordisPath,
    workspacePath
  };
}

function extractShimTarget(text) {
  const source = String(text || '');
  const posix = source.match(/cmd-shim-target=(.+)\s*$/m);
  if (posix && normalizeText(posix[1])) return normalizeText(posix[1]);
  const absoluteWindows = source.match(/[A-Za-z]:\\[^"\r\n]*?node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js/i);
  if (absoluteWindows) return absoluteWindows[0];
  const relative = source.match(/(?:%~dp0[\\/])?([^\s"']*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/i);
  if (relative && normalizeText(relative[1])) return normalizeText(relative[1]);
  return '';
}

function resolveDshEntry(cliPath, input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const candidate = normalizeText(cliPath);
  if (!candidate) return '';
  try {
    const real = fsImpl.realpathSync(candidate);
    if (/\.(?:js|mjs|cjs)$/i.test(real)) return real;
  } catch (_error) {}
  let text = '';
  try {
    text = fsImpl.readFileSync(candidate, 'utf8');
  } catch (_error) {
    return '';
  }
  const target = extractShimTarget(text);
  if (!target) return '';
  const resolved = pathImpl.isAbsolute(target)
    ? target
    : pathImpl.resolve(pathImpl.dirname(candidate), target);
  try {
    // pnpm 全局安装把包放在 store 的隔离目录里，依赖是包目录的兄弟节点。
    // 必须按真实路径解析，否则从全局 bin 的软链接路径出发找不到这些兄弟依赖
    // （DSH 的 node-addon-require-builtin 平台包就是靠它定位）。
    const real = fsImpl.realpathSync(resolved);
    if (fsImpl.existsSync(real)) return real;
  } catch (_error) {}
  try {
    if (fsImpl.existsSync(resolved)) return resolved;
  } catch (_error) {}
  return '';
}

function buildDshWrapperSource(entryPath) {
  const moduleUrl = pathToFileURL(String(entryPath || '')).href;
  return [
    '// DSH 0.2.x 的 bin 末尾用 import.meta.main 判断入口；Node 22 里该值为空，',
    '// 直接执行会静默退出。包装器显式 import runCli() 并等待它，行为等价。',
    `import { runCli } from ${JSON.stringify(moduleUrl)};`,
    'await runCli();',
    ''
  ].join('\n');
}

// pnpm 全局安装把 DSH 的依赖放在 store 的隔离目录里，而 DSH 的
// node-addon-native-custom-loader 用「从 loader 自身 require 平台包」的方式探测，
// 平台包只被链接在 node-addon-require-builtin/node_modules 下，因此 require 走不到。
// 把该 node_modules 加进 NODE_PATH 就能让 Node 的全局回退路径找到它（实测
// darwin-arm64 + Node 22）。这是启动环境修复，不修改 DSH 自己的安装。
function resolveDshNodePath(entryPath, pathImpl = nodePath) {
  const entry = normalizeText(entryPath);
  if (!entry) return '';
  try {
    const requireFromDsh = createRequire(entry);
    const packageEntry = requireFromDsh.resolve('node-addon-require-builtin');
    return pathImpl.dirname(pathImpl.dirname(pathImpl.dirname(packageEntry)));
  } catch (_error) {
    return '';
  }
}

function buildDshLaunchArgs(input = {}) {
  return [
    '--profile',
    PROFILE_NAME,
    ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])
  ];
}

async function prepareDshHarness(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const accountRef = normalizeText(input.accountRef);
  const provider = normalizeText(input.provider).toLowerCase();
  const gateway = input.gateway || {};
  const baseUrl = normalizeText(gateway.baseUrl).replace(/\/+$/, '');
  const apiKey = normalizeText(gateway.apiKey);
  if (!baseUrl) throw new Error('gateway_base_url_missing');
  if (!apiKey) throw new Error('gateway_api_key_missing');

  let catalog = input.catalog || null;
  if (!catalog) {
    catalog = await fetchGatewayModelCatalog({
      baseUrl,
      apiKey,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs
    });
  }
  catalog = withModelMetadata(catalog, provider);
  catalog = ensureRequestedModel(catalog, input.model, provider);
  const models = buildHarnessModelEntries(catalog);
  if (!models.length) throw new Error('gateway_model_catalog_empty');
  const requested = normalizeText(input.model);
  const model = models.some((entry) => entry.id === requested)
    ? requested
    : normalizeText(models[0].id);

  const dshHome = resolveHarnessProjectionRoot({
    fs: fsImpl,
    path: pathImpl,
    aiHomeDir: input.aiHomeDir,
    harnessId: 'dsh',
    accountRef
  });
  const profile = ensureDshProfile({
    fs: fsImpl,
    path: pathImpl,
    dshHome,
    baseUrl,
    accountRef,
    models,
    model
  });

  const sessionSummary = linkHostSessions({
    fs: fsImpl,
    path: pathImpl,
    projectionRoot: dshHome,
    hostHomeDir: input.hostHomeDir,
    hostSegments: ['.dsh']
  });

  const dshArgs = buildDshLaunchArgs({ nativeArgs: [
    ...buildManagedHostPluginArgs({ host: 'deepseek', aiHomeDir: input.aiHomeDir, hostHomeDir: input.hostHomeDir }),
    ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])
  ] });
  const entryPath = resolveDshEntry(input.dshPath, { fs: fsImpl, path: pathImpl });
  if (!entryPath) {
    // DSH 0.2.x 的 bin 在 Node 22 上直接执行会静默退出；解析不到真实入口时
    // 启动 shim 只会让用户看到一个立即消失的窗口，明确失败比假装启动更好。
    throw new Error('dsh_entry_not_found');
  }
  const wrapperPath = pathImpl.join(dshHome, WRAPPER_FILE);
  writePrivateText(fsImpl, wrapperPath, buildDshWrapperSource(entryPath));
  const command = {
    file: input.nodePath || process.execPath,
    args: [wrapperPath, ...dshArgs]
  };
  const env = {
    DSH_HOME: dshHome,
    OPENAI_API_KEY: apiKey
  };
  const nodePathEntry = resolveDshNodePath(entryPath, pathImpl);
  if (nodePathEntry) {
    const existingNodePath = normalizeText(input.env && input.env.NODE_PATH);
    env.NODE_PATH = existingNodePath
      ? `${nodePathEntry}${pathImpl.delimiter}${existingNodePath}`
      : nodePathEntry;
  }
  return {
    ok: true,
    harness: 'dsh',
    dshHome,
    profile,
    entryPath,
    command,
    args: dshArgs,
    models,
    model,
    env,
    sessionSummary
  };
}

module.exports = {
  CORDIS_YML,
  MODEL_REFRESH_ENTRY,
  MODEL_REFRESH_FILE,
  PATCH_HEADER,
  PNPM_WORKSPACE_YML,
  PROFILE_BUNDLES,
  PROFILE_NAME,
  buildDshLaunchArgs,
  buildDshModels,
  buildDshProviderConfig,
  buildDshWrapperSource,
  ensureDshModelRefresh,
  ensureDshProfile,
  extractShimTarget,
  mergeDshPatchEntries,
  parseDshPatch,
  prepareDshHarness,
  resolveDshEntry,
  resolveDshNodePath,
  serializeDshPatch,
  withDshModelRefreshEntry
};
