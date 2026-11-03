'use strict';

// peer 要操作的对象在**宿主**家目录下（会话、claude 登记、ai_home 库），而 aih 自己
// 的 CLI 可能跑在账号投影里（HOME=<aiHome>/run/auth-projections/<p>/<ref>）。
// 这里集中回答「宿主家目录是哪、要去哪些 claude 配置根里找会话」，
// 命令、补全、扫描共用；投影判定的唯一实现在 runtime/host-home.js。

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { resolveUnprojectedHostHomeDir } = require('../../../runtime/host-home');

// 兼容旧名：peer 层一直叫它 host home。
const resolvePeerHostHome = resolveUnprojectedHostHomeDir;

/** claude 的配置根：环境显式指定 + 宿主 ~/.claude + 各 claude 账号投影里的 .claude。 */
function listClaudeConfigDirs(hostHome, env = process.env) {
  const dirs = [];
  const push = (dir) => {
    const value = String(dir || '').trim();
    if (value && !dirs.includes(value)) dirs.push(value);
  };
  const explicit = String(env.CLAUDE_CONFIG_DIR || '').trim();
  if (explicit) push(explicit);
  if (!hostHome) return dirs;
  push(nodePath.join(hostHome, '.claude'));
  // 两种账号目录：auth-projections（运行沙箱）与 login（登录期）。哪边存在就看哪边。
  for (const root of ['auth-projections', 'login']) {
    const projections = nodePath.join(hostHome, '.ai_home', 'run', root, 'claude');
    try {
      for (const entry of nodeFs.readdirSync(projections, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        push(nodePath.join(projections, entry.name, '.claude'));
      }
    } catch (_error) { /* 该账号目录还不存在就算了 */ }
  }
  return dirs;
}

/** 宿主那份 ai_home（peer 要的是它，而不是当前账号投影里的 .ai_home）。 */
function resolvePeerAiHomeDir(env = process.env, hostHome = '') {
  const explicit = String(env.AIH_HOME_DIR || env.AI_HOME || '').trim();
  if (explicit) return explicit;
  return nodePath.join(hostHome || resolvePeerHostHome(env), '.ai_home');
}

module.exports = {
  resolvePeerHostHome,
  resolvePeerAiHomeDir,
  listClaudeConfigDirs
};
