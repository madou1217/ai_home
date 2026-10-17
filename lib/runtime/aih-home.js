'use strict';

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('./host-home');

/**
 * AIH 数据根目录（`<host home>/.ai_home`）的**唯一解析规则**。
 *
 * 优先级（刻意保留三个名字，历史部署脚本都在用）：
 *   显式注入 → AIH_HOME_DIR → AIH_HOME → AI_HOME → <宿主 home>/.ai_home
 *
 * 为什么要收口：这条 `A || B || C` 曾在 4 个模块里各写一遍（CLI paths、provider 门面、
 * 节点库/订阅聚合、node bootstrap），任何一处漏掉 AIH_HOST_HOME 就会在远端部署里
 * “写在一处、服务端在另一处读”。新代码一律调用本函数，不要再手写这串表达式。
 * 三个变量名是**同义别名**（不是三种模式），新增别名必须同时登记进
 * docs/architecture/env-flags.md（`npm run env:inventory -- --write`）。
 */
function resolveAiHomeDir(options = {}) {
  const env = options.env || process.env;
  const pathImpl = options.path || nodePath;
  const injected = String(options.aiHomeDir || '').trim();
  if (injected) return injected;
  const explicit = String(env.AIH_HOME_DIR || env.AIH_HOME || env.AI_HOME || '').trim();
  if (explicit) return explicit;
  return pathImpl.join(
    resolveHostHomeDir({ env, platform: options.platform, os: options.os }),
    '.ai_home'
  );
}

module.exports = {
  resolveAiHomeDir
};
