'use strict';

// 把 upgrade-runner 声明的那组依赖接到真实世界上。
//
// runner 自己不 require 网络、定时器、子进程，全部靠注入；这个模块就是那张「接线图」。
// 单独成文件而不是塞进 server.js，是因为接线本身有实打实的判断要做（见下），
// 而 server.js 已经太大了。
//
// 三处关键判断：
//
// 1. resolveCliPath 必须复用 server 传进来的那一个。
//    验证判据的全部意义是「重新解析一次 **aih 真正会启动哪个二进制**」。
//    如果这里自己再造一个解析器，断言测的就是另一个问题，而它照样会全绿。
//
// 2. 影子二进制的断言用「渠道不变」而不是「owner 路径不变」。
//    standalone 渠道的 owner 路径含版本号（releases/<version>-<triple>/bin/codex），
//    升级后必然变化，拿升级前的路径去比只会误判。渠道则是升级前后都该相同的不变量：
//    装完之后会被启动的那份如果来自另一条渠道，就是影子二进制。
//
// 3. reinstallCodexCliHook 只在 server 真的接管了 codex CLI hook 时才注入。
//    没接管时不注入，runPostInstallActions 会按「跳过」而非「失败」处理 —— 这是对的：
//    没有 hook 要恢复，就不该因为「没恢复 hook」判升级失败。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');

const { getProviderCLIConfig, listProviderDefinitions } = require('../../provider-catalog');
const { probeProviderRuntimeVersion } = require('../../runtime/provider-runtime-version');
const { checkManagedAppUpdate } = require('../../cli/services/toolkit/app-update-checker');
const { runInstallPlanAsync } = require('../../cli/services/ai-cli/ensure-native-cli');
const { detectCliChannel } = require('./upgrade-channel');
const { checkProviderQuiescence } = require('./upgrade-liveness');
const { createUpgradeVerifier, VERDICTS } = require('./upgrade-verifier');
const { verifyCodexAppServerBoot } = require('./verifiers/codex');
const { fetchNpmPublishTime } = require('./upgrade-publish-time');
const { resolveInstallRoots, npmPackageDirFor } = require('./upgrade-install-roots');

// codex 那次事故里 `--version` 完全正常，失败在 app-server 启动。强判据按 provider 注册，
// 没注册的自动落到「同一性断言 + 渠道不变」这条通用兜底上。
const STRONG_VERIFIERS = Object.freeze({ codex: verifyCodexAppServerBoot });

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const FILE_PREFIX_BYTES = 160;

/** 有 npm 包名的 provider 才谈得上「钉版本安装」，也才可能回滚。 */
function listUpgradeCandidateProviders() {
  return listProviderDefinitions()
    .map((definition) => definition.id)
    .filter((provider) => String((getProviderCLIConfig(provider) || {}).pkg || '').trim());
}

function providerPackageName(provider) {
  return String((getProviderCLIConfig(provider) || {}).pkg || '').trim();
}

function createProviderUpgradeDeps(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const processObj = options.processObj || process;
  const spawn = options.spawn || nodeSpawn;
  const aiHomeDir = options.aiHomeDir;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const resolveCliPath = typeof options.resolveCliPath === 'function' ? options.resolveCliPath : () => '';
  const runInstallPlan = typeof options.runInstallPlan === 'function' ? options.runInstallPlan : runInstallPlanAsync;
  const checkUpdateImpl = typeof options.checkManagedAppUpdate === 'function'
    ? options.checkManagedAppUpdate
    : checkManagedAppUpdate;
  const fetchPublishTime = typeof options.fetchPublishTime === 'function'
    ? options.fetchPublishTime
    : fetchNpmPublishTime;

  // 渠道根目录探测里有一次 `npm root -g` 子进程，按实例缓存：目录布局不会在一个 server
  // 生命周期内变来变去，没必要每轮每个 provider 各付一次。
  let cachedRoots = null;
  const getRoots = () => {
    if (!cachedRoots) {
      cachedRoots = resolveInstallRoots({
        fs,
        path,
        processObj,
        spawnSync: options.spawnSync || nodeSpawnSync,
        hostHomeDir: options.hostHomeDir
      });
    }
    return cachedRoots;
  };

  // 本轮 detectChannel 的结论，供验证阶段做「渠道不变」断言。
  const channelMemo = new Map();

  function readFilePrefix(file) {
    try {
      const content = fs.readFileSync(file);
      const prefix = Buffer.isBuffer(content) ? content.subarray(0, FILE_PREFIX_BYTES) : String(content).slice(0, FILE_PREFIX_BYTES);
      return Buffer.isBuffer(prefix) ? prefix.toString('utf8') : prefix;
    } catch (_error) {
      return '';
    }
  }

  function safeRealpath(target) {
    try {
      return fs.realpathSync(target);
    } catch (_error) {
      return target;
    }
  }

  async function probeVersion(cliPath) {
    const target = String(cliPath || '').trim();
    if (!target) return '';
    return probeProviderRuntimeVersion(target, readFilePrefix(target), {
      spawn,
      env: processObj.env,
      platform: String(processObj.platform || process.platform),
      nodeExecutable: String(options.nodeExecPath || processObj.execPath || 'node'),
      powershellExecutable: String(options.powershellExecutable || 'powershell.exe'),
      versionProbeTimeoutMs: Number(options.versionProbeTimeoutMs) || VERSION_PROBE_TIMEOUT_MS
    });
  }

  function inspectChannel(provider) {
    const resolvedPath = String(resolveCliPath(provider) || '').trim();
    const roots = getRoots();
    const packageName = providerPackageName(provider);
    const detected = detectCliChannel({
      fs,
      path,
      resolvedPath,
      standaloneRoots: roots.standaloneRoots,
      npmGlobalRoot: roots.npmGlobalRoot,
      vendorSelfUpdateRoots: roots.vendorSelfUpdateRoots,
      homebrewRoots: roots.homebrewRoots,
      npmPackageDir: npmPackageDirFor(roots.npmGlobalRoot, packageName, { path })
    });
    return {
      ...detected,
      packageName,
      // 官方 install.sh 认 CODEX_INSTALL_DIR 作为 BIN_DIR；它就是可见命令所在的目录。
      installDir: resolvedPath ? path.dirname(resolvedPath) : ''
    };
  }

  async function detectChannel(provider) {
    const detected = inspectChannel(provider);
    channelMemo.set(provider, detected.channel);
    return detected;
  }

  async function checkUpdate(provider) {
    const packageName = providerPackageName(provider);
    const resolvedPath = String(resolveCliPath(provider) || '').trim();
    const installedVersion = await probeVersion(resolvedPath);

    const update = await checkUpdateImpl({
      id: provider,
      provider,
      version: installedVersion,
      pkg: packageName
    }, { processObj, spawn });
    // 查不到远端版本要显式抛：runner 把它记成 check_failed，不改状态也不计熔断。
    if (!update || update.ok === false) {
      throw new Error(String((update && (update.message || update.error)) || 'latest_version_unavailable'));
    }

    const latestVersion = String(update.latestVersion || '').trim();
    let publishedAt = 0;
    if (latestVersion && packageName) {
      const published = await fetchPublishTime(packageName, latestVersion, { processObj, spawn });
      if (published && published.ok) {
        publishedAt = Number(published.publishedAt) || 0;
      } else {
        // soak 闸门唯一的输入没拿到。policy 会据此 SKIP，连续 5 次后升级成 soak_unknown。
        // 这条日志是它从「静默不动」变成「看得见为什么不动」的唯一途径。
        log({
          provider,
          at: now(),
          event: 'publish_time_unavailable',
          version: latestVersion,
          detail: String((published && published.error) || 'unknown')
        });
      }
    }

    return { installedVersion, latestVersion, publishedAt, packageName };
  }

  function checkQuiescence(provider) {
    return checkProviderQuiescence(provider, { fs, path, processObj, aiHomeDir, now });
  }

  async function runPlans(plans, context = {}) {
    let last = { ok: false, error: 'no_plan', stdout: '', stderr: '' };
    for (const plan of Array.isArray(plans) ? plans : []) {
      last = await runInstallPlan(plan, { processObj, spawn });
      // 一条 plan 失败就停：后面的 plan 是同一目标的替代路径，在钉版本场景下没有
      // 「换一条路也行」的语义，继续跑只会把机器推向更说不清的状态。
      if (!last || last.ok !== true) {
        return {
          ok: false,
          error: String((last && last.error) || 'install_failed'),
          stdout: String((last && last.stdout) || ''),
          stderr: String((last && last.stderr) || '')
        };
      }
    }
    return { ok: true, error: '', stdout: String(last.stdout || ''), stderr: String(last.stderr || '') };
  }

  // 渠道漂移断言，对每个候选 provider 一视同仁地跑一遍；有强判据的再往下走。
  function buildStrongVerifiers() {
    const verifiers = {};
    for (const provider of listUpgradeCandidateProviders()) {
      verifiers[provider] = async (context) => {
        const expectedChannel = channelMemo.get(provider);
        if (expectedChannel) {
          const actualChannel = inspectChannel(provider).channel;
          if (actualChannel !== expectedChannel) {
            return {
              verdict: VERDICTS.FAIL,
              detail: `channel_drift:${actualChannel}!=${expectedChannel}`
            };
          }
        }
        const strong = STRONG_VERIFIERS[provider];
        if (typeof strong !== 'function') return { verdict: VERDICTS.PASS, detail: 'channel_stable' };
        return strong({
          ...context,
          fs,
          path,
          spawn,
          cliPath: String(resolveCliPath(provider) || '').trim(),
          verifyTimeoutMs: Number(options.verifyTimeoutMs) || undefined
        });
      };
    }
    return verifiers;
  }

  const verify = createUpgradeVerifier({
    resolveCliPath: async (provider) => resolveCliPath(provider),
    probeVersion,
    realpath: safeRealpath,
    strongVerifiers: buildStrongVerifiers()
  });

  const deps = {
    now,
    log,
    detectChannel,
    checkUpdate,
    checkQuiescence,
    runPlans,
    verify
  };
  // 只在 server 真的接管了 codex CLI hook 时才注入（见文件头第 3 点）。
  if (typeof options.reinstallCodexCliHook === 'function') {
    deps.reinstallCodexCliHook = options.reinstallCodexCliHook;
  }
  return deps;
}

module.exports = {
  STRONG_VERIFIERS,
  VERSION_PROBE_TIMEOUT_MS,
  listUpgradeCandidateProviders,
  providerPackageName,
  createProviderUpgradeDeps
};
