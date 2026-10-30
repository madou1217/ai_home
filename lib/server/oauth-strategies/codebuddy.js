'use strict';

/**
 * CodeBuddy Code 的登录前准备：**预先信任登录工作目录**。
 *
 * 事故形态（2026-10-30，新增 codebuddy 2 号账号）：WebUI 登录作业把 CLI 起在
 * `<aiHomeDir>/run/login/codebuddy/auth-<jobId>/workspace`，CodeBuddy Code 首启会对该目录弹
 * 「Do you trust the files in this folder?」（1. Trust folder only / 2. Trust parent folder /
 * 3. Trust folder and all subdirectories / 4. No, exit），登录作业就停在这个 Ink 选择框上，
 * 既拿不到 OAuth 结果也不会自己往下走 —— 用户看到的就是「报错」。
 *
 * 事实来源（codebuddy 2.178.1 二进制内实测）：CLI 的 trust 判定是
 *   needsAuthorization(dir) = trustAll || trustedDirectories.some(p => matchTrustPattern(p, dir))
 * 其中 pattern 支持 minimatch 通配（`<dir>/**` 匹配 `<dir>/`），读写的是**用户 settings**
 * （`<CODEBUDDY_CONFIG_DIR>/settings.json` 的 `trustedDirectories`，即用户在 TUI 里选完
 * 任一信任项后 CLI 自己写回的那个键）。真机验证：预写该键后同一目录不再出现信任框，
 * 直接进 TUI；未预写时 4 个选项的框必然出现。
 *
 * 只信任 aih 自己创建的临时登录工作目录（不是用户的项目目录），语义与 gemini 登录策略
 * 自动选「Trust parent folder」一致：登录工作目录由 aih 全权拥有，不该让用户为它做选择。
 */

/**
 * 已知限制（2026-10-30 实测，codebuddy 2.178.1 + 当前网页端）：登录结果传不回 CLI。
 *
 * 作业能走到 `Waiting for auth...`、授权链接也能拿到，但用户在浏览器里真的登录成功
 * （页面显示 `✓ Login Successful!`）之后，CLI 侧收不到任何东西：
 *   1. CLI 进程在等待期间**零出站连接**（12 次采样只有本地 LISTEN），不轮询云端；
 *   2. 它监听的本地端口上没有登录回调路由（`/callback` / `/auth/callback` / `/api/callback`
 *      全返回 `No mapping found`，带 `x-codebuddy-request` 头也一样）；
 *   3. 网页侧 24 个 SPA chunk 里没有任何一处引用 `127.0.0.1`/`localhost`/`x-codebuddy-request`，
 *      `platform=CLI` 分支只渲染静态的 `✓ Login Successful!`（见 started-D5C10ypo.js）；
 *   4. 把 CLI 完全脱离 aih 单独跑，它交给浏览器的 URL 与 aih 捕获的逐字相同。
 * 也就是说这不是 aih 拼错参数，也不是"没等够"：浏览器与 CLI 之间没有可用通道。
 * 等腾讯修好（或 CLI 版本更新带来新的 handoff 机制）后，本文件无需改动即可自动恢复——
 * 只要 CLI 真的把凭据写进作业的假 HOME，作业照常收尾。
 *
 * 目前能出账号的通道只有"本机登录态入库"：`aih codebuddy detect`
 * （对应 CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info）。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { DEFAULT_STRATEGY, createPromptResponder } = require('./base');
const { writeFileAtomic } = require('../../runtime/atomic-file-write');

const TRUST_PROMPT_PATTERN = /Do you trust the files in this folder\?/i;
const SETTINGS_FILE = 'settings.json';

// 信任框之后还有一道必答题：CodeBuddy 首启会让你选站点。
//   Select login method:
//   ❯ Log in via Chinese Site        <- 默认停在第一项
//     Log in via International Site
//     Log in via Enterprise Domain
//     Log in via iOA (Tencent only)
//   (Use ↑↓ to select, Enter to login)
// 没人按键作业就永远停在 starting，连 authorizationUrl 都拿不到。
// 站点归属由 provider 决定（与 aih 的 codebuddy / codebuddycn 两个 provider 一致），
// 真机事实：provider=codebuddy 的账号产物写的是 https://www.codebuddy.ai（国际站）。
// CLI 打印的授权地址形如
//   https://www.codebuddy.ai/login?platform=CLI&state=<uuid>&version=2.178.1
// 它既没有 redirect_uri 也没有 code_challenge，所以通用提取器
// （web-account-auth-oauth-browser.js 的 extractBrowserOAuthHints）认不出来，
// job.authorizationUrl 一直是空 —— WebUI 上连一个可点的授权链接都没有，
// 用户只能看着「Waiting for auth...」发呆。这里按 codebuddy 自己的 URL 形态补一条。
const LOGIN_URL_PATTERN = /https:\/\/(?:www\.)?codebuddy\.(?:ai|cn)\/login\?[^\s"'`\u001b]+/i;
const SITE_MENU_PATTERN = /Select login method/i;
const SITE_MENU_OPTION_PATTERN = /Log in via (?:International|Chinese) Site/i;
// Ink 的下移和回车必须分开写：同一个 tick 里回车读到的还是移动前的选中项。
// 真机标定（codebuddy 2.178.1，node-pty 直接驱动）：间隔 150ms 时菜单只完成了下移、
// 回车被吞掉，作业继续停在菜单上；间隔 800ms 时回车生效，进入「Waiting for auth...」。
const SITE_MENU_DOWN_KEY_DELAY_MS = 900;
// 回车偶尔会被 Ink 的重渲染吞掉（真机：同一个作业 900ms 间隔成功过一次、失败过一次），
// 所以菜单还在就补敲回车，最多补 SITE_MENU_MAX_RETRIES 次；一旦 CLI 开始等授权就立刻停手，
// 免得把多余的回车打进 TUI 输入框。
const SITE_MENU_MAX_RETRIES = 3;
const SITE_MENU_RETRY_INTERVAL_MS = 3000;
const SITE_MENU_ADVANCED_PATTERN = /Waiting for auth|Successfully|Logged in|登录成功/i;

function readSettings(fs, filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/**
 * 登录工作目录要写进 trustedDirectories 的 pattern。
 *
 * 两个形态都要：CLI 显示/匹配用的是它自己解析出来的工作目录（macOS 上 `/tmp/x` 会显示成
 * `/private/tmp/x`），而 aih 手里的是原始路径。两边都加一条 `<dir>/**`，任一形态命中即可。
 */
function buildTrustPatterns(spawnCwd, pathImpl) {
  const cwd = String(spawnCwd || '').trim();
  if (!cwd) return [];
  const patterns = [];
  const add = (value) => {
    const dir = String(value || '').trim().replace(/[\\/]+$/, '');
    if (!dir) return;
    const pattern = `${dir}/**`;
    if (!patterns.includes(pattern)) patterns.push(pattern);
  };
  add(cwd);
  // path.resolve 不解析符号链接，realpath 才拿得到 CLI 眼里的真实路径。
  try {
    if (pathImpl && typeof pathImpl.resolve === 'function') add(pathImpl.resolve(cwd));
  } catch (_error) { /* 解析失败就只用原始路径 */ }
  try {
    const real = nodeFs.realpathSync(cwd);
    add(real);
  } catch (_error) { /* 目录还不存在时忽略 */ }
  return patterns;
}

/**
 * 把登录工作目录写进 `<configDir>/settings.json` 的 trustedDirectories。
 * 幂等：已存在的条目原样保留，只补缺失的两条；其它键（用户/前一次登录写的）一律不动。
 */
function seedFolderTrust(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path;
  const configDir = String(options.configDir || '').trim();
  const spawnCwd = String(options.spawnCwd || '').trim();
  if (!fsImpl || !pathImpl || !configDir || !spawnCwd) return { ok: false, reason: 'inputs_missing', patterns: [] };
  const patterns = buildTrustPatterns(spawnCwd, pathImpl);
  if (!patterns.length) return { ok: false, reason: 'spawn_cwd_missing', patterns: [] };
  try {
    fsImpl.mkdirSync(configDir, { recursive: true });
    const filePath = pathImpl.join(configDir, SETTINGS_FILE);
    const settings = readSettings(fsImpl, filePath);
    const existing = Array.isArray(settings.trustedDirectories) ? settings.trustedDirectories.map((item) => String(item)) : [];
    const merged = [...existing];
    for (const pattern of patterns) {
      if (!merged.includes(pattern)) merged.push(pattern);
    }
    if (merged.length === existing.length) return { ok: true, changed: false, patterns, settingsPath: filePath };
    const next = { ...settings, trustedDirectories: merged };
    writeFileAtomic(fsImpl, filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, changed: true, patterns, settingsPath: filePath };
  } catch (error) {
    return { ok: false, reason: String(error && error.message || error), patterns };
  }
}

// 兜底：settings 写不进去（只读目录 / 内容损坏）时，直接在 PTY 里回车确认默认项
// 「1. Trust folder only」。真机验证：该框默认选中 1，回车即继续进 TUI。
const respondToFolderTrust = createPromptResponder({
  shouldRespond: (logs) => TRUST_PROMPT_PATTERN.test(logs),
  response: '\r',
  stateFlag: '_codebuddyFolderTrustAccepted',
  awaitingState: 'AWAITING_FOLDER_TRUST',
  selectedState: 'FOLDER_TRUST_SELECTED',
  unavailableMessage: '检测到 CodeBuddy 文件夹信任提示，但当前 PTY 不支持自动输入。',
  selectedMessage: '检测到 CodeBuddy 文件夹信任提示，自动确认「1. Trust folder only」。'
});

function extractLoginUrl(logs) {
  const match = String(logs || '').match(LOGIN_URL_PATTERN);
  return match ? match[0] : '';
}

/**
 * 菜单项的键位别名。只覆盖前两项：第三项 Enterprise Domain、第四项 iOA 都需要
 * 再输入域名/工号，自动选择做不到，所以不在这里硬编码。
 */
const SITE_MENU_ALIASES = Object.freeze({
  cn: 0, chinese: 0, 'chinese-site': 0,
  intl: 1, international: 1, 'international-site': 1, global: 1
});

/**
 * 站点归属的判定顺序：显式指定（作业字段 / AIH_CODEBUDDY_SITE）→ provider 默认。
 * provider 默认是实测出来的，不是官方契约：codebuddycn 走国内站，其余走国际站。
 * 显式指定只认 SITE_MENU_ALIASES 里的词，写错了退回默认，不会盲敲。
 */
function resolveSiteIndex(provider, requested) {
  const key = String(requested || '').trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(SITE_MENU_ALIASES, key)) {
    return SITE_MENU_ALIASES[key];
  }
  return String(provider || '').trim().toLowerCase() === 'codebuddycn' ? 0 : 1;
}

/**
 * 站点菜单要敲的键序列。菜单默认停在第一项「Chinese Site」，所以要选第 N 项
 * 就先按 N 次下移，再回车；下移和回车之间必须留 SITE_MENU_DOWN_KEY_DELAY_MS。
 */
function resolveSiteMenuKeys(provider, requested) {
  const index = resolveSiteIndex(provider, requested);
  const keys = [];
  for (let step = 0; step < index; step += 1) {
    keys.push({ value: '\x1b[B', delayMs: 0 });
  }
  keys.push({ value: '\r', delayMs: index > 0 ? SITE_MENU_DOWN_KEY_DELAY_MS : 0 });
  return keys;
}

/**
 * 自动回答站点菜单。返回 true 表示「这次调用认领了这个提示」。
 * 同一个作业只回答一次（job._codebuddySiteSelected），避免后续输出反复触发把回车打进对话里。
 */
function respondToSiteMenu({ job, deps }) {
  if (!job || job.status !== 'running') return false;
  const stripLogs = (text) => (deps && typeof deps.stripAnsi === 'function'
    ? deps.stripAnsi(text || '')
    : String(text || ''));
  const logs = stripLogs(job.logs);

  if (job._codebuddySiteSelected) return false;

  if (!SITE_MENU_PATTERN.test(logs) || !SITE_MENU_OPTION_PATTERN.test(logs)) return false;

  job._codebuddySiteSelected = true;
  const requested = job._codebuddySite
    || (deps && deps.codebuddySite)
    || process.env.AIH_CODEBUDDY_SITE
    || '';
  const siteIndex = resolveSiteIndex(job.provider, requested);
  const keys = resolveSiteMenuKeys(job.provider, requested);
  const log = (message) => {
    if (deps && typeof deps.appendJobLog === 'function') deps.appendJobLog(job, message);
  };

  const ptyProcess = job._ptyProcess;
  if (!ptyProcess || typeof ptyProcess.write !== 'function') {
    log('检测到 CodeBuddy 站点选择菜单，但当前 PTY 不支持自动输入。');
    return true;
  }

  const siteLabel = siteIndex === 0 ? 'Chinese Site' : 'International Site';
  const siteSource = String(requested || '').trim() ? '按指定' : '按 provider 默认';
  log(`检测到 CodeBuddy 站点菜单，${siteSource}自动选择「Log in via ${siteLabel}」。`);

  for (const step of keys) {
    if (!step.delayMs) {
      ptyProcess.write(step.value);
      continue;
    }
    const timer = setTimeout(() => {
      try { ptyProcess.write(step.value); } catch (_error) { /* 进程已退出，忽略 */ }
    }, step.delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  if (deps && deps.states && deps.setAuthProgressState) {
    deps.setAuthProgressState(job, deps.states.LOGIN_METHOD_SELECTED);
  }

  // 用定时器补敲回车，不能靠「下一条日志」触发：回车被吞之后 Ink 就不再重绘，
  // PTY 一片安静，事件驱动的重试永远等不到下一次回调（真机就这样卡住过一次）。
  scheduleSiteMenuRetry({ job, deps, ptyProcess });
  return true;
}

/**
 * 菜单还停着就补敲回车，最多 SITE_MENU_MAX_RETRIES 次。
 * 一旦日志里出现「Waiting for auth」等前进信号立刻收手 —— 历史日志里菜单文字一直都在，
 * 所以判定必须用「有没有前进」，不能用「菜单还在不在」。
 */
function scheduleSiteMenuRetry({ job, deps, ptyProcess }) {
  const stripLogs = (text) => (deps && typeof deps.stripAnsi === 'function'
    ? deps.stripAnsi(text || '')
    : String(text || ''));
  const intervalMs = Number(deps && deps.siteMenuRetryIntervalMs) || SITE_MENU_RETRY_INTERVAL_MS;
  const tick = () => {
    if (job.status !== 'running') return;
    if (SITE_MENU_ADVANCED_PATTERN.test(stripLogs(job.logs))) return;
    if ((job._codebuddySiteRetries || 0) >= SITE_MENU_MAX_RETRIES) return;
    job._codebuddySiteRetries = (job._codebuddySiteRetries || 0) + 1;
    try { ptyProcess.write('\r'); } catch (_error) { return; }
    scheduleNext();
  };
  const scheduleNext = () => {
    const timer = setTimeout(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  scheduleNext();
}

const CODEBUDDY_LOGIN_STRATEGY = {
  prepareLogin({ configDir, spawnCwd, fs, deps }) {
    seedFolderTrust({
      fs,
      path: (deps && deps.path) || nodePath,
      configDir,
      spawnCwd
    });
  },

  buildLoginArgs: DEFAULT_STRATEGY.buildLoginArgs,

  updateProgress({ job, hints, deps }) {
    if (job && !job.authorizationUrl) {
      const logs = deps && typeof deps.stripAnsi === 'function'
        ? deps.stripAnsi(job.logs || '')
        : String(job.logs || '');
      const found = extractLoginUrl(logs);
      if (found) job.authorizationUrl = found;
    }
    return DEFAULT_STRATEGY.updateProgress({ job, hints, deps });
  },

  submitCallback: DEFAULT_STRATEGY.submitCallback,

  handlePrompt({ job, deps }) {
    if (respondToFolderTrust({ job, deps })) return true;
    return respondToSiteMenu({ job, deps });
  }
};

module.exports = {
  CODEBUDDY_LOGIN_STRATEGY,
  SETTINGS_FILE,
  TRUST_PROMPT_PATTERN,
  SITE_MENU_PATTERN,
  LOGIN_URL_PATTERN,
  buildTrustPatterns,
  extractLoginUrl,
  resolveSiteIndex,
  resolveSiteMenuKeys,
  respondToSiteMenu,
  seedFolderTrust
};
