'use strict';

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const { resolveCliPath: resolveDefaultCliPath } = require('../runtime/platform-runtime');
const { execFileSync } = require('node:child_process');

function parseCodexClientVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

// Codex 官方客户端的 originator 形如 codex_cli_rs / codex_exec。只接受这个前缀，
// 避免把普通 HTTP 客户端自带的 UA 当成 Codex 版本证据（与 Go 的
// codexidentity.codexOriginatorPattern 保持一致）。
const CODEX_ORIGINATOR_PATTERN = /^codex_[a-z0-9_]{1,48}$/;

// codexVersionFromRequestHeaders 从入站 Codex 请求头提取客户端版本。
//
// 网关对上游冒充的是「正在调用它的那个客户端」：客户端 UA 是 0.167.2，而网关自报
// Version 0.158.0 时，上游会按 Version 判定 gpt-6.1-* 不可用 —— 但真正受限的是
// 自报值，不是客户端能力。Go 侧在入口用 VersionFromClientHeaders + Resolver.Observe
// 学这个值；Node 侧此前只靠本机 CLI 探测，探测一失败就退回 floor，
// 因而出现「同一请求 UA 与 Version 自相矛盾」的 400（2026-11-13 真机）。
//
// 只认 originator 合法且 UA 以 "<originator>/" 开头的请求，其余返回空串。
function codexVersionFromRequestHeaders(headers = {}) {
  const readHeader = (name) => {
    if (!headers || typeof headers !== 'object') return '';
    const direct = headers[name];
    if (Array.isArray(direct)) return String(direct[0] || '').trim();
    if (direct != null) return String(direct).trim();
    const matched = Object.keys(headers).find((key) => String(key).toLowerCase() === name);
    return matched ? String(headers[matched] || '').trim() : '';
  };
  const originator = readHeader('originator');
  const userAgent = readHeader('user-agent');
  if (!CODEX_ORIGINATOR_PATTERN.test(originator)) return '';
  if (!userAgent.startsWith(originator + '/')) return '';
  const token = userAgent.slice(originator.length + 1).split(/[\s(]/)[0];
  return parseCodexClientVersion(token);
}

// codexProbeCandidates 返回按可信度排序的 Codex CLI 候选路径。
//
// 为什么不能只解析一个命令：网关以 systemd / launchd 常驻时 PATH 往往只有系统目录，
// 而 Codex 官方安装器把可执行文件放在用户目录（~/.local/bin、standalone 包目录）。
// 只依赖 PATH + 登录 shell 回落时，服务环境里 `codex --version` 会直接 ENOENT，
// 探测失败就退回协议 floor（当时是 0.158.0），而按 client_version 下发的新模型（gpt-6.1-*）
// 会被上游统一拒成 400「model is not supported when using Codex with a ChatGPT account」
// —— 目录说可用、请求全失败（2026-11-13 真机事故）。
//
// 顺序：显式配置 > AIH_CODEX_BIN > PATH 解析 > 用户级常见安装目录。
// 与 Go 侧 codexidentity.probeCommands 保持同一组兜底位置，避免两套运行时对
// 「本机 Codex 是哪个版本」给出不同答案。
function codexProbeCandidates(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const platform = String(options.platform || processObj.platform || process.platform);
  const candidates = [];
  const push = (value) => {
    const command = String(value || '').trim();
    if (!command) return;
    // 同一路径可能同时来自 PATH 与用户目录扫描；去重避免重复起子进程。
    if (candidates.some((item) => item === command)) return;
    candidates.push(command);
  };

  push(options.codexCommand);
  push(env.AIH_CODEX_BIN);

  const resolvePath = typeof options.resolveCliPath === 'function'
    ? options.resolveCliPath
    : resolveDefaultCliPath;
  if (typeof resolvePath === 'function') {
    try {
      push(resolvePath('codex', { env, platform }));
    } catch (_error) {}
  }

  const hostHomeDir = String(
    options.hostHomeDir || env.AIH_HOST_HOME || os.homedir() || ''
  ).trim();
  if (hostHomeDir) {
    for (const relative of [
      ['.local', 'bin', 'codex'],
      ['.codex', 'packages', 'standalone', 'current', 'bin', 'codex'],
      ['.npm-global', 'bin', 'codex'],
      ['.volta', 'bin', 'codex'],
      ['.local', 'share', 'pnpm', 'codex']
    ]) {
      push(nodePath.join(hostHomeDir, ...relative));
    }
  }
  return candidates;
}

// resolveCodexCommand 保留单值语义（日志/直连调试用），返回首选候选。
function resolveCodexCommand(options = {}) {
  const candidates = codexProbeCandidates(options);
  return candidates[0] || 'codex';
}

// probeCodexClientVersion 依次探测候选，返回其中最高的合法版本。
//
// 单个候选失败（不存在、超时、输出不是版本号）只跳过该候选：用户目录里的
// standalone 包可能损坏，而 PATH 上的 shim 仍然可用；反过来也一样。取最大值而
// 不是第一个成功值，是为了处理「PATH 上是旧版、standalone 目录是新版」的常见布局。
function probeCodexClientVersion(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const platform = String(options.platform || processObj.platform || process.platform);
  // 超时从 1s 抬到 3s：codex 是 node 垫片（aih 的 CLI hook），冷启动实测 0.2–1.1s，
  // 服务重启/CLI 自动升级窗口里会超过 1s。超时失败会直接掉到协议 floor，
  // 代价是整整一个模型族的 400，远高于多等两秒。
  const timeoutMs = Math.max(
    250,
    Number(options.timeoutMs) || (platform === 'win32' ? 5000 : 3000)
  );
  let best = '';
  for (const command of codexProbeCandidates(options)) {
    // 绝对路径先做存在性检查：用户级兜底目录在多数机器上并不存在，直接 spawn 会白付
    // 一次进程创建（Windows 上尤其贵）；裸命令名（codex）仍交给 exec 解析 PATH。
    if ((command.includes('/') || command.includes('\\')) && !fs.existsSync(command)) continue;
    // Windows 上 codex 是 .cmd 垫片（含 aih 包装器），execFileSync 直接执行会 EINVAL，
    // 版本探测永远失败 → 网关自报最低版本，按版本下发的新模型被上游拒。先解析成
    // node + 脚本再执行（与 Node 宿主既有处理一致）。
    const target = platform === 'win32'
      ? resolveWindowsUpstreamSpawn(command, ['--version'], { platform, env })
      : { command, args: ['--version'], envPatch: {}, windowsVerbatimArguments: false };
    try {
      const exec = options.execFileSync || execFileSync;
      const raw = exec(target.command, target.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        env: { ...env, ...(target.envPatch || {}) },
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments === true
      });
      const parsed = parseCodexClientVersion(raw);
      if (parsed && (!best || compareCodexClientVersions(parsed, best) > 0)) {
        best = parsed;
      }
    } catch (_error) {
      // 候选不可用不构成结论：继续试下一个，全部失败才由调用方决定回落策略。
    }
  }
  return best;
}

function detectCodexClientVersion(options = {}) {
  const configured = parseCodexClientVersion(options.codexClientVersion || '');
  if (configured) return configured;
  return probeCodexClientVersion(options);
}

// 与 Go 侧 codexidentity.Floor 一致：所有版本来源都拿不到时的兜底下限，
// 不是编码器形状的版本锁（请求形状由模型档案决定，见 Go 的 requestProfileForModel）。
//
// OAuth 目录/额度按 client_version 判定兼容性：
//   - 0.158.0 是编码器形状的实测基线（Codex CLI 0.158.0-alpha.2.1）；
//   - 但它低于 gpt-6.1-* 的目录门槛（实测 0.158 必 400、0.167.2 正常），
//     继续拿它兜底只会在冷启动 / 探测失败时把新模型打成 400。
// 因此下限跟齐线上真实流量已验证的 0.167.2；更高版本仍由探测、Go 学习值、入站 UA 抬高。
const CODEX_CLIENT_VERSION_FLOOR = '0.167.2';
const CACHE_TTL_MS = 60 * 60 * 1000;
// A missing service PATH is recoverable (the CLI may be installed or the
// resolver may become usable after a restart). Never keep the protocol floor
// for an hour after a failed probe: retry quickly while retaining the normal
// hourly refresh for a successfully detected CLI.
const FAILED_DETECT_CACHE_TTL_MS = 5 * 1000;
// 失败后的强制重探有最小间隔：一次请求里多个账号连续失败时只付一次探测成本。
const FORCED_REFRESH_MIN_INTERVAL_MS = 5 * 1000;

let cached = { version: '', at: 0, detected: false };
// lastGood 是进程内的单调高水位：一旦成功探测到更高版本，后续瞬时探测失败
// （超时 / 升级窗口里 shim 暂时不可执行）绝不能把自报版本拉回协议下限。
// 这是 2026-11-13 事故的直接根因：目录用高版本探测、请求用低版本自报，
// 上游按请求头 `Version` 判模型兼容性，gpt-6.1-* 必然 400。
let lastGood = '';
let lastForcedRefreshAt = 0;

function compareCodexClientVersions(left, right) {
  const a = String(left || '').split('.').map((part) => Number(part) || 0);
  const b = String(right || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

// maxCodexClientVersion 返回非空版本中的最大者；全空时返回空串。
function maxCodexClientVersion(...versions) {
  let best = '';
  for (const value of versions) {
    const parsed = parseCodexClientVersion(value);
    if (parsed && (!best || compareCodexClientVersions(parsed, best) > 0)) best = parsed;
  }
  return best;
}

// observeCodexClientVersion 把「真实调用方自报的版本」并入高水位。
//
// 语义与 Go 的 Resolver.Observe 一致：只升不降。它比本机探测更可信 —— 正在发请求的
// 客户端就是上游要校验的那个客户端，它的版本一定与自己的请求兼容。Node 宿主在
// codex-adapter 入口调用本函数，保证自报 Version 不会低于正在服务的客户端。
function observeCodexClientVersion(version) {
  const parsed = parseCodexClientVersion(version);
  if (!parsed) return lastGood;
  lastGood = maxCodexClientVersion(lastGood, parsed);
  if (compareCodexClientVersions(parsed, cached.version) > 0) {
    // 保留 cached.at：观察值不延长「本机 CLI 探测」的 TTL，只抬高下界。
    cached = { ...cached, version: parsed, detected: true, at: cached.at || Date.now() };
  }
  return lastGood;
}

// atLeastCodexClientVersionFloor 取探测值与最低版本中较大者：PATH 上的独立 CLI 可能比
// 兜底下限更旧（本机实测 0.154 的旧版），自报旧版本会让 OAuth 目录缺新模型。
function atLeastCodexClientVersionFloor(version) {
  const parsed = parseCodexClientVersion(version);
  if (!parsed || compareCodexClientVersions(parsed, CODEX_CLIENT_VERSION_FLOOR) < 0) return CODEX_CLIENT_VERSION_FLOOR;
  return parsed;
}

// readLearnedCodexVersion 读取 Go 侧已学习到的最新客户端版本（run/client-versions.json）。
//
// Go 的 RuntimeResolver 会把「从真实客户端请求头学到的最高版本」持久化到这里。Node 宿主
// 自己也维护 lastGood，但进程重启后内存清空：如果重启瞬间 CLI 探测又失败，只靠 floor
// 会再次复现 2026-11-13 的 400。因此启动/刷新时把 Go 的学习值并入下界，两边共用同一份
// 事实，不新增第二份持久化文件。
function readLearnedCodexVersion(aiHomeDir) {
  const home = String(aiHomeDir || '').trim();
  if (!home) return '';
  try {
    const raw = fs.readFileSync(nodePath.join(home, 'run', 'client-versions.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parseCodexClientVersion(parsed && parsed.codex);
  } catch (_error) {
    return '';
  }
}

// 探测结果的磁盘快照：内存缓存只在进程内有效，每次 server 重启都要重新起子进程，
// 实测 0.25–0.9s（codex 是 node 垫片，冷启动更慢）。快照不存 TTL，而是存「CLI 身份」：
// 候选路径的存在性 + size + mtime。身份没变时重复探测必然得到同一个版本号，直接复用；
// CLI 升级 / 换安装位置 / PATH 变化都会改变身份，下一次调用立刻重探。
const PROBE_SNAPSHOT_FILE_VERSION = 1;

function probeSnapshotPath(aiHomeDir) {
  const home = String(aiHomeDir || '').trim();
  if (!home) return '';
  return nodePath.join(home, 'run', 'codex-client-version.json');
}

// probeIdentity 只看文件元数据，不起子进程；与 probeCodexClientVersion 用同一组候选。
function probeIdentity(options = {}) {
  const parts = [];
  for (const command of codexProbeCandidates(options)) {
    let descriptor = 'missing';
    try {
      const stat = fs.statSync(command);
      descriptor = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch (_error) {
      descriptor = 'missing';
    }
    parts.push(`${command}=${descriptor}`);
  }
  return parts.join('|');
}

function readProbeSnapshot(aiHomeDir) {
  const file = probeSnapshotPath(aiHomeDir);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== PROBE_SNAPSHOT_FILE_VERSION) return null;
    const version = parseCodexClientVersion(data.clientVersion);
    if (!version) return null;
    return {
      version,
      identity: String(data.identity || ''),
      detectedAt: Number(data.detectedAt) || 0
    };
  } catch (_error) {
    return null;
  }
}

function writeProbeSnapshot(aiHomeDir, snapshot) {
  const file = probeSnapshotPath(aiHomeDir);
  if (!file || !snapshot || !snapshot.version) return;
  try {
    const previous = readProbeSnapshot(aiHomeDir);
    if (previous && previous.version === snapshot.version && previous.identity === snapshot.identity) return;
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const payload = JSON.stringify({
      version: PROBE_SNAPSHOT_FILE_VERSION,
      clientVersion: snapshot.version,
      identity: snapshot.identity,
      detectedAt: snapshot.detectedAt
    }) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_error) {
    // 纯加速层：目录不可写、磁盘满都退回原来的每次探测路径。
  }
}

// getCodexClientVersion 返回本机 CLI 版本（CLI 身份变化时重新探测：CLI 会自动更新），
// 结果单调不降：不低于协议 floor、不低于已学习版本、不低于本进程见过的最好值。
function getCodexClientVersion(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const ttl = cached.detected ? CACHE_TTL_MS : FAILED_DETECT_CACHE_TTL_MS;
  if (!cached.version || now - cached.at >= ttl) {
    // 人工锁定优先：显式配置存在时既不探测也不读快照。
    const configured = parseCodexClientVersion(options.codexClientVersion || '');
    const identity = configured ? '' : probeIdentity(options);
    const snapshot = configured ? null : readProbeSnapshot(options.aiHomeDir);
    const fromSnapshot = Boolean(snapshot && identity && snapshot.identity === identity);
    // detectCodexClientVersion 保留「人工锁定优先」语义：显式配置存在时不再探测。
    const detected = fromSnapshot ? snapshot.version : detectCodexClientVersion(options);
    const learned = readLearnedCodexVersion(options.aiHomeDir);
    // 探测成功：并入 floor / 学习值 / 高水位，取最大。
    // 探测失败：只用已知事实（floor / 学习值 / 高水位），绝不因为一次失败主动降级。
    const known = maxCodexClientVersion(
      CODEX_CLIENT_VERSION_FLOOR,
      atLeastCodexClientVersionFloor(detected),
      learned,
      lastGood
    );
    if (detected) {
      lastGood = maxCodexClientVersion(lastGood, known);
      // 只持久化「探测到的 CLI 版本」，不写合并后的 known：快照描述的是本机 CLI 事实。
      if (!configured && !fromSnapshot) {
        writeProbeSnapshot(options.aiHomeDir, { version: detected, identity, detectedAt: now });
      }
    }
    cached = {
      version: known || CODEX_CLIENT_VERSION_FLOOR,
      at: now,
      detected: Boolean(detected)
    };
  }
  return cached.version;
}

// refreshCodexClientVersion 强制重新探测一次并立即返回新版本。
//
// 使用场景：上游明确回了「该模型在 ChatGPT 账号上不可用」，而账号目录里明明有这个模型
// —— 这说明自报版本和目录版本不一致。下一次 attempt 必须用修正后的版本重发，否则
// 换号也是同一个 400。带最小间隔，避免一次请求里 4 个账号各探测一次。
function refreshCodexClientVersion(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (now - lastForcedRefreshAt < FORCED_REFRESH_MIN_INTERVAL_MS) {
    return getCodexClientVersion(options);
  }
  lastForcedRefreshAt = now;
  // 只清缓存，不写 lastGood：上一次的成功高水位仍然是有效下界。
  cached = { version: '', at: 0, detected: false };
  return getCodexClientVersion({ ...options, now: () => now });
}

function resetCodexClientVersionCacheForTest() {
  cached = { version: '', at: 0, detected: false };
  lastGood = '';
  lastForcedRefreshAt = 0;
}

module.exports = {
  CODEX_CLIENT_VERSION_FLOOR,
  atLeastCodexClientVersionFloor,
  codexProbeCandidates,
  compareCodexClientVersions,
  codexVersionFromRequestHeaders,
  getCodexClientVersion,
  maxCodexClientVersion,
  observeCodexClientVersion,
  probeCodexClientVersion,
  readLearnedCodexVersion,
  refreshCodexClientVersion,
  resetCodexClientVersionCacheForTest,
  detectCodexClientVersion,
  parseCodexClientVersion,
  resolveCodexCommand
};
