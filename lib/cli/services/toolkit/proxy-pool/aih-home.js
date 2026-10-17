'use strict';

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../../../../runtime/host-home');
const { resolveAiHomeDir } = require('../../../../runtime/aih-home');

/**
 * 节点库与订阅聚合配置的数据目录：与服务端 resolveCliPaths 同一优先级——
 * 显式注入 → AIH_HOME_DIR / AI_HOME → <宿主 home>/.ai_home（宿主 home 遵循 AIH_HOST_HOME）。
 * 直接用 os.homedir() 会在 AIH_HOST_HOME 部署下与服务端数据目录分家（写在一处、服务端在另一处读）。
 */
function resolveProxyPoolAiHome(options = {}) {
  // 唯一规则在 lib/runtime/aih-home.js（含 AIH_HOME_DIR / AI_HOME 别名与 AIH_HOST_HOME）。
  return resolveAiHomeDir({
    aiHomeDir: options.aiHomeDir,
    env: options.env,
    path: options.path,
    platform: options.platform,
    os: options.os
  });
}

module.exports = {
  resolveProxyPoolAiHome
};
