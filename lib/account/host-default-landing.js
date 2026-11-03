'use strict';

// 「默认账号未指定 ⇒ AIH Server 作为默认」的落点收敛（唯一实现处）。
//
// 与 CLI `aih <provider> set-default`（不带账号号）语义一致：宿主同步到无钉选
// 网关档（model_provider = aih_server + 本机网关地址），并把档位记成 aih_server。
// 这样「默认账号被取消 / 删除 / 停用」时，裸跑 CLI 与桌面 App 仍走网关，而不是
// 回落到账号直连上游或宿主自带 OAuth。
//
// 只有网关 profile 受支持的 provider（codex/claude/opencode/kimi）存在这一档；
// 其余 provider 没有「AIH Server 默认」可落，原样返回不写任何文件。

const { listProvidersByCapability } = require('../provider-catalog');
const {
  AIH_SERVER_PROFILE_ID,
  readDefaultProviderProfile,
  writeDefaultProviderProfile
} = require('./default-account-store');

const GATEWAY_PROFILE_PROVIDERS = new Set(listProvidersByCapability('gatewayProfile'));

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function supportsAihServerDefault(provider) {
  return GATEWAY_PROFILE_PROVIDERS.has(normalizeProvider(provider));
}

// 返回已落地的档位（'aih_server'）或空串：读取口径与启动链路
// （codex-default-cli-launcher / CLI 隐式档位）保持一致。
function readAihServerDefault(fs, aiHomeDir, provider) {
  if (!fs || !aiHomeDir || !supportsAihServerDefault(provider)) return '';
  return readDefaultProviderProfile(fs, aiHomeDir, normalizeProvider(provider));
}

// 「AIH Server 档位」的唯一写入处：provider:default:<provider> = aih_server。
// 与 `codex-default-cli-launcher` 的读取口径成对：命中该档位 ⇒ 走网关连接串；
// 档位与默认账号都缺席 ⇒ authMode passthrough（正是要避免的裸跑直连态）。
// 只记档位，不碰默认账号指针（各调用方按自己的作用域清理）。
function writeAihServerDefaultSlot(fs, aiHomeDir, provider) {
  const normalizedProvider = normalizeProvider(provider);
  if (!fs || !aiHomeDir || !supportsAihServerDefault(normalizedProvider)) return false;
  writeDefaultProviderProfile(fs, aiHomeDir, normalizedProvider, AIH_SERVER_PROFILE_ID);
  return true;
}

// 幂等落点：宿主同步成功后才记档位，绝不留「档位说 AIH Server、宿主指向别处」
// 的错配；同步不可用或失败时明确返回 ok:false，由调用方决定是否透出。
function landOnAihServerDefault(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const provider = normalizeProvider(options.provider);
  const syncGlobalConfigToHost = options.syncGlobalConfigToHost;
  if (!supportsAihServerDefault(provider)) {
    return { ok: true, landed: false, reason: 'gateway_profile_not_supported' };
  }
  if (!fs || !aiHomeDir) {
    return { ok: false, landed: false, reason: 'host_scope_unavailable' };
  }
  const alreadyLanded = readAihServerDefault(fs, aiHomeDir, provider) === AIH_SERVER_PROFILE_ID;
  if (typeof syncGlobalConfigToHost !== 'function') {
    return { ok: false, landed: false, reason: 'host_sync_unavailable' };
  }
  const syncResult = syncGlobalConfigToHost(provider, '', { gateway: true });
  if (!syncResult || !syncResult.ok) {
    return {
      ok: false,
      landed: false,
      reason: String((syncResult && syncResult.reason) || 'gateway_config_sync_failed')
    };
  }
  try {
    writeAihServerDefaultSlot(fs, aiHomeDir, provider);
  } catch (error) {
    return {
      ok: false,
      landed: false,
      reason: 'default_provider_profile_write_failed',
      message: String((error && error.message) || error)
    };
  }
  return { ok: true, landed: true, provider, profile: AIH_SERVER_PROFILE_ID, alreadyLanded };
}

module.exports = {
  landOnAihServerDefault,
  readAihServerDefault,
  supportsAihServerDefault,
  writeAihServerDefaultSlot
};
