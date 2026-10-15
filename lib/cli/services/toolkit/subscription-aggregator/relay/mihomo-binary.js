'use strict';

const { resolveKernelBinary } = require('./kernel-binary');

/**
 * 本机中转的第二内核：mihomo（Clash.Meta 系）。查找顺序与「不自动下载」的原则见 kernel-binary.js。
 *
 * 为什么需要它：sing-box 没有 xhttp 传输、没有 VLESS Encryption（ML-KEM）、没有 ShadowsocksR / Mieru
 * 出站，这几类节点它编不出来；mihomo 全都能编（实测 mihomo -t 通过）。反过来 naive 只有 sing-box 有，
 * 所以两个内核是**互补**关系，边车按节点逐个挑能编的那个（见 kernels/）。
 */

const MANAGED_BINARY_NAME = 'mihomo';
const ENV_VAR = 'AIH_RELAY_MIHOMO_BIN';
// 同一种内核的不同发行名：verge-mihomo-alpha 是 Clash Verge 自带的那份，clash-meta 是旧名。
const ALIASES = Object.freeze(['verge-mihomo-alpha', 'clash-meta', 'clash.meta']);

function binaryNameCandidates(env = {}, platform = process.platform) {
  const { binaryNameCandidates: names } = require('./kernel-binary');
  return [MANAGED_BINARY_NAME, ...ALIASES].flatMap((name) => names(name, env, platform));
}

/** → { path, source } | null。 */
function resolveMihomoBinary(options = {}) {
  return resolveKernelBinary({ baseName: MANAGED_BINARY_NAME, aliases: ALIASES, envVar: ENV_VAR }, options);
}

/** `mihomo -v` 的第一行形如 `Mihomo Meta v1.19.32 darwin arm64 …`；解析不出来返回 ''。 */
function parseMihomoVersion(stdout) {
  const match = /v(\d+\.\d+(?:\.\d+)?)/.exec(String(stdout || ''));
  return match ? match[1] : '';
}

module.exports = {
  ALIASES,
  ENV_VAR,
  MANAGED_BINARY_NAME,
  binaryNameCandidates,
  parseMihomoVersion,
  resolveMihomoBinary
};
