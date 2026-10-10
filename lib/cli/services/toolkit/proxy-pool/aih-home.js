'use strict';

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../../../../runtime/host-home');

/**
 * 节点库与订阅聚合配置的数据目录：与服务端 resolveCliPaths 同一优先级——
 * 显式注入 → AIH_HOME_DIR / AIH_HOME / AI_HOME → <宿主 home>/.ai_home（宿主 home 遵循 AIH_HOST_HOME）。
 * 直接用 os.homedir() 会在 AIH_HOST_HOME 部署下与服务端数据目录分家（写在一处、服务端在另一处读）。
 */
function resolveProxyPoolAiHome(options = {}) {
  const injected = String(options.aiHomeDir || '').trim();
  if (injected) return injected;
  const env = options.env || process.env;
  const explicit = String(env.AIH_HOME_DIR || env.AIH_HOME || env.AI_HOME || '').trim();
  if (explicit) return explicit;
  const pathImpl = options.path || nodePath;
  return pathImpl.join(resolveHostHomeDir({ env, platform: options.platform, os: options.os }), '.ai_home');
}

module.exports = {
  resolveProxyPoolAiHome
};
