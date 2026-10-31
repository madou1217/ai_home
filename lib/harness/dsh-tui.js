'use strict';

// dsh-tui 是 DSH 的树外 profile 包（package.json 的 dsh.bundle.patch 指向
// ./cordis.patch.yml），不是一个独立 runtime。因此 aih 从不调用它自己的
// 瘦壳启动器（那层只做自举 / 版本对齐 / delegate），而是把它当 bundle 安装进
// DSH profile，再用 `dsh --profile <name>` 启动 —— 与 DSH 官方 web profile
// 完全同一条组合链路，profile 的 patch 分层语义也原样适用。
//
// 隔离口径（与 codex/claude 的投影同构）：
//   1. 每个账号一个 HOME 投影：dsh-tui 的 DATA_DIR 是 join(homedir(), '.dsh-tui')，
//      而 homedir() 读 os.homedir()（Windows 才回落到 USERPROFILE），所以 HOME
//      投影就整体搬走了 onboarding/model/settings/history 等全部偏好。
//   2. 每个账号一个 DSH_HOME：DSH 官方的凭据/会话/profile 根，profile 本体装在这里。
//   3. 会话默认链回宿主 `~/.dsh`（会话不属于某个账号），可用 sharedSessions=false 关闭。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
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
const {
  buildDshProviderConfig,
  buildDshWrapperSource,
  ensureDshModelRefresh,
  parseDshPatch,
  resolveDshEntry,
  resolveDshNodePath,
  serializeDshPatch,
  withDshModelRefreshEntry
} = require('./dsh');

const HARNESS_ID = 'dsh-tui';
const PROFILE_NAME = 'dsh-tui';
const PROFILE_BUNDLE = '@deepseek-harness-tui/dsh-tui';
const BASE_BUNDLE = '@deepseek-ai/dsh-base';
const PROVIDER_ID = 'aih';
const WRAPPER_FILE = 'run-dsh-tui.mjs';
const CONFIG_DIRNAME = '.dsh-tui';
const ONBOARDING_FILE = 'onboarding.json';
const MODEL_PREFS_FILE = 'model.json';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const PNPM_WORKSPACE_YML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

function normalizeText(value) {
  return String(value || '').trim();
}

// HOME 投影：dsh-tui 的 homedir() 只认 os.homedir()，macOS/Linux 上是 HOME，
// Windows 上是 USERPROFILE，所以两个都写（与既有 home-redirect 口径一致）。
function buildHomeProjectionEnv(input = {}) {
  const homeDir = normalizeText(input.homeDir);
  if (!homeDir) return {};
  const hostHomeDir = normalizeText(input.hostHomeDir);
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    // XDG 配置与状态属于身份，跟着投影走；缓存是可再生的，留在宿主避免多份拷贝。
    XDG_CONFIG_HOME: homeDir,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    XDG_STATE_HOME: `${homeDir}/.local/state`,
    ...(hostHomeDir ? { XDG_CACHE_HOME: `${hostHomeDir}/.cache` } : {})
  };
}

// onboarding 只是一次偏好写入：dsh-tui 允许 Esc/Ctrl+C 直接 finish('skipped')，
// 所以预写 completed 既不是绕过门禁，也不会把用户永久锁在某个值上。
function ensureTuiPreferences(fsImpl, pathImpl, homeDir, input = {}) {
  const dataDir = pathImpl.join(homeDir, CONFIG_DIRNAME);
  fsImpl.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const onboardingPath = pathImpl.join(dataDir, ONBOARDING_FILE);
  if (!fsImpl.existsSync(onboardingPath)) {
    writePrivateJson(fsImpl, onboardingPath, { completed: true, version: 1 });
  }
  // 预置 provider/model：TUI 启动时据此解析默认模型；用户之后在 TUI 内切模型
  // 会自己改写这份文件，所以只在首次写入。
  const modelPath = pathImpl.join(dataDir, MODEL_PREFS_FILE);
  if (!fsImpl.existsSync(modelPath) && normalizeText(input.model)) {
    writePrivateJson(fsImpl, modelPath, {
      provider: normalizeText(input.provider) || PROVIDER_ID,
      model: normalizeText(input.model)
    });
  }
  return { dataDir, onboardingPath, modelPath };
}

function buildDshTuiProfilePackage(previous) {
  const pkg = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? { ...pkg.dsh } : {};
  const profile = dsh.profile && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile)
    ? { ...dsh.profile }
    : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.slice() : [];
  for (const bundle of [BASE_BUNDLE, PROFILE_BUNDLE]) {
    if (!bundles.includes(bundle)) bundles.push(bundle);
  }
  profile.bundles = bundles;
  dsh.profile = profile;
  return {
    ...pkg,
    name: normalizeText(pkg.name) || `dsh-profile-${PROFILE_NAME}`,
    private: pkg.private !== false,
    dependencies: pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {},
    dsh
  };
}

function readProfilePackage(fsImpl, filePath) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function mergeDshTuiPatchEntries(entries, input = {}) {
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
  providers[PROVIDER_ID] = buildDshProviderConfig(input);
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
    provider: PROVIDER_ID,
    model: normalizeText(input.model)
  };
  return withDshModelRefreshEntry(list, input);
}

// profile 目录的静态部分（不含任何可变账号状态）：profile 本体可跨账号共享，
// per-account 的 provider 头由账号投影里的 DSH_HOME 决定。
function ensureDshTuiProfile(input = {}) {
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
  if (!fsImpl.existsSync(cordisPath)) writePrivateText(fsImpl, cordisPath, CORDIS_YML);
  const workspacePath = pathImpl.join(profileDir, 'pnpm-workspace.yaml');
  if (!fsImpl.existsSync(workspacePath)) writePrivateText(fsImpl, workspacePath, PNPM_WORKSPACE_YML);

  const packagePath = pathImpl.join(profileDir, 'package.json');
  writePrivateJson(fsImpl, packagePath, buildDshTuiProfilePackage(readProfilePackage(fsImpl, packagePath)));

  const patchPath = pathImpl.join(profileDir, 'cordis.patch.yml');
  const existing = fsImpl.existsSync(patchPath) ? fsImpl.readFileSync(patchPath, 'utf8') : '[]\n';
  const entries = mergeDshTuiPatchEntries(parseDshPatch(existing), {
    baseUrl: input.baseUrl,
    accountRef: input.accountRef,
    models: input.models,
    model: input.model
  });
  writePrivateText(fsImpl, patchPath, serializeDshPatch(entries));
  return { profileDir, profileName: PROFILE_NAME, packagePath, patchPath, cordisPath, workspacePath };
}

function hasInstalledBundle(dshHome, fsImpl = nodeFs, pathImpl = nodePath) {
  const home = normalizeText(dshHome);
  if (!home) return false;
  const packagePath = pathImpl.join(
    home, 'profiles', PROFILE_NAME, 'node_modules', ...PROFILE_BUNDLE.split('/'), 'package.json'
  );
  try {
    return Boolean(fsImpl.readFileSync(packagePath, 'utf8').trim());
  } catch (_error) {
    return false;
  }
}

// dsh 自己负责 profile 初始化与 pnpm 解析（复用全局 store，实测冷启动 ~5s）。
// 直接调 pnpm 会绕过 DSH 的 bundle 激活与 workspace 约定。
function buildDshTuiInstallArgs() {
  return ['plugin', '--profile', PROFILE_NAME, 'add', PROFILE_BUNDLE];
}

// 升级用 `add <pkg>@latest` 而不是 `update <pkg>`：pnpm update 只在 package.json
// 已声明的 semver 范围内升级，跨 minor 的 bundle 新版本它拿不到。
function buildDshTuiUpdateArgs() {
  return ['plugin', '--profile', PROFILE_NAME, 'add', `${PROFILE_BUNDLE}@latest`];
}

function runDshCli(input = {}) {
  const spawnImpl = input.spawnImpl || spawn;
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawnImpl(input.file, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: 'pipe',
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: String(error && error.message || error) });
      return;
    }
    let output = '';
    const collect = (chunk) => {
      if (output.length < 64 * 1024) output += String(chunk || '');
    };
    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer && timer.unref) clearTimeout(timer);
      resolve({ ok: code === 0, code: Number.isInteger(code) ? code : -1, output });
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: -1, output: `${output}\n${String(error && error.message || error)}` });
    });
    child.on('close', finish);
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : INSTALL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_error) {}
      finish(-1);
    }, timeoutMs);
    if (timer && timer.unref) timer.unref();
  });
}

function dshTuiInstallFailure(output) {
  const text = normalizeText(output);
  const error = new Error(`dsh_tui_profile_install_failed: ${text.slice(-400) || 'no output'}`);
  error.code = 'dsh_tui_profile_install_failed';
  return error;
}

// pnpm 全局安装把 DSH 的依赖放在 store 的隔离目录里；平台包只被链接在
// node-addon-require-builtin/node_modules 下，把该目录加进 NODE_PATH 才找得到。
function buildDshNodePathEnv(entryPath, pathImpl, existing) {
  const nodePathEntry = resolveDshNodePath(entryPath, pathImpl);
  if (!nodePathEntry) return {};
  const current = normalizeText(existing);
  return {
    NODE_PATH: current ? `${nodePathEntry}${pathImpl.delimiter}${current}` : nodePathEntry
  };
}

function buildDshTuiLaunchArgs(input = {}) {
  // 必须用 dsh-tui 自己的 profile 名：dsh-tui 的 bundle 声明在它自己的
  // package.json 里，复用 DSH web profile 只会组合 dsh-web-app（没有终端界面）。
  return [
    '--profile',
    PROFILE_NAME,
    ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])
  ];
}

function writeDshTuiWrapper(fsImpl, pathImpl, projectionRoot, entryPath) {
  // DSH 0.2.x 的 bin 末尾用 import.meta.main 判断入口，Node 22 上该值为空，
  // 直接执行会静默退出；包装器显式 import runCli() 并等待它。
  const wrapperPath = pathImpl.join(projectionRoot, WRAPPER_FILE);
  writePrivateText(fsImpl, wrapperPath, buildDshWrapperSource(entryPath));
  return wrapperPath;
}

// ── 随 DSH 应用卡片升级 ────────────────────────────────────────────────────
// DSH 本体（npm 包）升级不会碰 dsh-tui 的 profile bundle：bundle 装在每个账号
// 投影自己的 DSH_HOME 里，是 aih 的派生状态，只有 aih 知道它在哪。因此升级 DSH
// 时按「已存在的 profile」逐个追加一条 pnpm 计划，复用生命周期计划执行器既有的
// 进度 / 超时 / attempts 通道，不新增作业类型。
function listInstalledDshTuiProjections(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const aiHomeDir = normalizeText(input.aiHomeDir);
  if (!aiHomeDir) return [];
  const harnessRoot = pathImpl.join(aiHomeDir, 'run', 'harness', HARNESS_ID);
  let entries = [];
  try {
    entries = fsImpl.readdirSync(harnessRoot, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const projections = [];
  for (const entry of entries) {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue;
    const projectionRoot = pathImpl.join(harnessRoot, String(entry.name || ''));
    const dshHome = pathImpl.join(projectionRoot, 'dsh');
    if (!hasInstalledBundle(dshHome, fsImpl, pathImpl)) continue;
    projections.push({ accountRef: String(entry.name || ''), projectionRoot, dshHome });
  }
  return projections;
}

function buildDshTuiProfileUpdatePlans(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const entryPath = resolveDshEntry(input.dshPath, { fs: fsImpl, path: pathImpl });
  // 解析不出 DSH 入口（CLI 刚被换掉 / 路径失效）时不追加计划：npm 计划本身已经把
  // DSH 升上去了，下一次启动 dsh-tui 会重新解析入口并按需补装。
  if (!entryPath) return [];
  const nodeBin = normalizeText(input.nodePath) || process.execPath;
  const projections = listInstalledDshTuiProjections({
    fs: fsImpl,
    path: pathImpl,
    aiHomeDir: input.aiHomeDir
  });
  const plans = [];
  for (const projection of projections) {
    const homeDir = pathImpl.join(projection.projectionRoot, 'home');
    try {
      fsImpl.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    } catch (_error) {
      // HOME 投影建不出来只是少了隔离，升级本身仍应尝试。
    }
    const wrapperPath = writeDshTuiWrapper(fsImpl, pathImpl, projection.projectionRoot, entryPath);
    plans.push({
      id: `dsh_tui_profile_update:${projection.accountRef}`,
      label: `升级 dsh-tui profile（${projection.accountRef}）`,
      command: nodeBin,
      args: [wrapperPath, ...buildDshTuiUpdateArgs()],
      env: {
        ...buildHomeProjectionEnv({ homeDir, hostHomeDir: input.hostHomeDir }),
        DSH_HOME: projection.dshHome,
        ...buildDshNodePathEnv(entryPath, pathImpl, input.env && input.env.NODE_PATH)
      },
      timeoutMs: INSTALL_TIMEOUT_MS
    });
  }
  return plans;
}

async function prepareDshTuiHarness(input = {}) {
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
      accountRef,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs
    });
  }
  catalog = withModelMetadata(catalog, provider);
  catalog = ensureRequestedModel(catalog, input.model, provider);
  const models = buildHarnessModelEntries(catalog);
  if (!models.length) throw new Error('gateway_model_catalog_empty');
  const requested = normalizeText(input.model);
  const model = models.some((entry) => entry.id === requested) ? requested : normalizeText(models[0].id);

  const aiHomeDir = normalizeText(input.aiHomeDir);
  if (!aiHomeDir) throw new Error('ai_home_dir_missing');

  const projectionRoot = resolveHarnessProjectionRoot({
    fs: fsImpl,
    path: pathImpl,
    aiHomeDir,
    harnessId: HARNESS_ID,
    accountRef
  });
  const homeDir = pathImpl.join(projectionRoot, 'home');
  const dshHome = pathImpl.join(projectionRoot, 'dsh');
  fsImpl.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fsImpl.mkdirSync(dshHome, { recursive: true, mode: 0o700 });

  const entryPath = resolveDshEntry(input.dshPath, { fs: fsImpl, path: pathImpl });
  if (!entryPath) throw new Error('dsh_entry_not_found');

  const profile = ensureDshTuiProfile({
    fs: fsImpl,
    path: pathImpl,
    dshHome,
    baseUrl,
    accountRef,
    models,
    model
  });

  const launchEnv = {
    ...buildHomeProjectionEnv({ homeDir, hostHomeDir: input.hostHomeDir }),
    DSH_HOME: dshHome,
    OPENAI_API_KEY: apiKey
  };
  const nodePathEnv = buildDshNodePathEnv(entryPath, pathImpl, input.env && input.env.NODE_PATH);
  const wrapperPath = writeDshTuiWrapper(fsImpl, pathImpl, projectionRoot, entryPath);

  // profile 本体缺 bundle 时补装一次（幂等：装过直接跳过）。
  let installed = true;
  if (!hasInstalledBundle(dshHome, fsImpl, pathImpl)) {
    if (input.autoInstall === false) throw dshTuiInstallFailure('bundle missing and autoInstall disabled');
    const notify = typeof input.notify === 'function' ? input.notify : () => {};
    const installStartedAt = Date.now();
    notify({ phase: 'install:start', harness: HARNESS_ID, label: `${PROFILE_BUNDLE} 首次安装（profile bundle）` });
    const result = await runDshCli({
      file: input.nodePath || process.execPath,
      args: [wrapperPath, ...buildDshTuiInstallArgs()],
      cwd: projectionRoot,
      env: { ...(input.env || process.env), ...launchEnv, ...nodePathEnv },
      spawnImpl: input.spawnImpl,
      timeoutMs: input.installTimeoutMs
    });
    installed = result.ok && hasInstalledBundle(dshHome, fsImpl, pathImpl);
    notify({
      phase: 'install:end',
      harness: HARNESS_ID,
      ok: installed,
      durationMs: Date.now() - installStartedAt
    });
    if (!installed) throw dshTuiInstallFailure(result.output);
  }

  const preferences = ensureTuiPreferences(fsImpl, pathImpl, homeDir, { provider: PROVIDER_ID, model });
  const sessionSummary = input.sharedSessions === false
    ? { linked: 0, skipped: 'shared_sessions_disabled' }
    : linkHostSessions({
        fs: fsImpl,
        path: pathImpl,
        projectionRoot: dshHome,
        hostHomeDir: input.hostHomeDir,
        hostSegments: ['.dsh']
      });

  const args = [wrapperPath, ...buildDshTuiLaunchArgs({ nativeArgs: [
    ...buildManagedHostPluginArgs({ host: 'deepseek', aiHomeDir: input.aiHomeDir, hostHomeDir: input.hostHomeDir }),
    ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])
  ] })];
  return {
    ok: true,
    harness: HARNESS_ID,
    projectionRoot,
    homeDir,
    dshHome,
    profile,
    preferences,
    entryPath,
    wrapperPath,
    installed,
    models,
    model,
    command: { file: input.nodePath || process.execPath, args },
    args: args.slice(1),
    env: { ...launchEnv, ...nodePathEnv },
    sessionSummary
  };
}

module.exports = {
  BASE_BUNDLE,
  CONFIG_DIRNAME,
  HARNESS_ID,
  INSTALL_TIMEOUT_MS,
  MODEL_PREFS_FILE,
  ONBOARDING_FILE,
  PROFILE_BUNDLE,
  PROFILE_NAME,
  PROVIDER_ID,
  WRAPPER_FILE,
  buildDshNodePathEnv,
  buildDshTuiInstallArgs,
  buildDshTuiLaunchArgs,
  buildDshTuiProfileUpdatePlans,
  buildDshTuiProfilePackage,
  buildDshTuiUpdateArgs,
  buildHomeProjectionEnv,
  ensureDshTuiProfile,
  ensureTuiPreferences,
  hasInstalledBundle,
  listInstalledDshTuiProjections,
  mergeDshTuiPatchEntries,
  prepareDshTuiHarness,
  runDshCli,
  writeDshTuiWrapper
};
