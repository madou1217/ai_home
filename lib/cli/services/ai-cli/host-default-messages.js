'use strict';

/**
 * set-default / unset-default 的用户提示（失败原因 + 补救、接管手改、网关不可达）。
 * 失败时把宿主同步的底层错误原文与补救建议一起打出来，而不是只给一个原因码。
 * 补救表按底层错误码查（数据声明，新增错误码只加一行）。
 */
const HOST_DEFAULT_REMEDIES = Object.freeze({
  invalid_claude_settings: 'Fix the JSON in ~/.claude/settings.json (top level and "env" must be objects), then retry.',
  invalid_opencode_config: 'Fix the JSON/JSONC in the OpenCode config file, then retry.',
  invalid_opencode_config_after_edit: 'Fix the JSON/JSONC in the OpenCode config file, then retry.',
  invalid_kimi_gateway_block: 'Remove the broken "ai-home managed AIH Server profile" block from the Kimi config.toml, then retry.',
  opencode_gateway_provider_conflict: 'Rename or remove your own provider entry named "aih" in the OpenCode config, then retry.',
  kimi_gateway_provider_conflict: 'Rename or remove your own "aih-server" provider/model entries in the Kimi config.toml, then retry.',
  opencode_gateway_models_unavailable: 'Start the AIH server (`aih server start`) and let it discover models, then retry.',
  host_config_not_regular_file: 'The host config is a symlink or not a regular file; replace it with a regular file, then retry.',
  gateway_default_host_config_changed: 'The host config was edited outside aih; run the explicit `set-default` / `unset-default` command to take it over.',
  invalid_gateway_default_state: 'The aih state file next to the host config is corrupt; run the explicit `set-default` command to rebuild it.',
  host_sync_unavailable: 'Host config sync is not wired in this context; run the command from the aih CLI.'
});

function readErrorCode(message) {
  const text = String(message || '').trim();
  return /^[a-z0-9_]+$/.test(text) ? text : '';
}

function formatHostSyncFailure(result) {
  const reason = result && result.reason ? String(result.reason) : 'unknown_error';
  const detail = result && result.error ? String(result.error).trim() : '';
  const code = readErrorCode(detail) || reason;
  const remedy = HOST_DEFAULT_REMEDIES[code] || HOST_DEFAULT_REMEDIES[reason] || '';
  const cause = detail && detail !== reason ? `${reason}: ${detail}` : reason;
  return remedy ? `${cause}. ${remedy}` : cause;
}

/**
 * 显式命令接管了外部手改时的提示行（stderr）。返回要打印的行（可能为空数组）。
 */
function formatHostConfigTakeover(takeover, cliName) {
  if (!takeover) return [];
  const fileName = takeover.fileName || 'host config';
  const lines = [];
  if (takeover.stateReset) {
    lines.push(`${fileName}: the aih default state file was unreadable; rebuilt it from the current file.`);
  } else if (takeover.externallyChanged) {
    lines.push(takeover.adoptedAsBaseline
      ? `${fileName} was edited outside aih; taking over. Your edited version is kept as the baseline that switching back restores.`
      : `${fileName} was edited outside aih but still points at the AIH gateway; taking over and keeping the previous baseline.`);
  }
  const residual = Array.isArray(takeover.residualOverrides) ? takeover.residualOverrides : [];
  if (residual.length > 0) {
    lines.push(`${fileName} still sets ${residual.join(', ')}; the bare ${cliName} CLI will use those instead of the selected login. Remove them, or run \`aih ${cliName} set-default\` to use AIH Server.`);
  }
  return lines;
}

/**
 * 宿主配置改为经 AIH 网关（AIH Server 默认、API key 账号钉选 relay）时，宿主上裸跑的 CLI
 * 依赖网关在线。用一个短超时的子进程探测 /readyz（路由层是同步的），只提示、不自动启动。
 * 返回 { reachable: true|false|null }：null 表示无法探测（不打扰用户）。
 */
const READYZ_PROBE_SCRIPT = [
  "const http=require('node:http');",
  "const req=http.get(process.argv[1],{timeout:Number(process.argv[2])},(res)=>{res.resume();process.exit(res.statusCode<500?0:2);});",
  "req.on('timeout',()=>{req.destroy();process.exit(1);});",
  "req.on('error',()=>process.exit(1));"
].join('');

function probeGatewayReachable({ spawnSync, execPath, rootUrl, timeoutMs = 800 } = {}) {
  if (typeof spawnSync !== 'function' || !rootUrl) return { reachable: null };
  let readyzUrl;
  try {
    readyzUrl = new URL('/readyz', rootUrl).toString();
  } catch (_error) {
    return { reachable: null };
  }
  try {
    const result = spawnSync(execPath || process.execPath, ['-e', READYZ_PROBE_SCRIPT, readyzUrl, String(timeoutMs)], {
      stdio: 'ignore',
      timeout: timeoutMs + 1500
    });
    if (!result || result.error || typeof result.status !== 'number') return { reachable: null };
    if (result.status === 0) return { reachable: true };
    return { reachable: false, notReady: result.status === 2 };
  } catch (_error) {
    return { reachable: null };
  }
}

function formatGatewayDownWarning(cliName, rootUrl, probe) {
  if (!probe || probe.reachable !== false) return '';
  const state = probe.notReady ? 'is not ready' : 'is not reachable';
  return `The AIH server at ${rootUrl} ${state}; the bare ${cliName} CLI now goes through it and will fail until it runs (\`aih server start\`).`;
}

module.exports = {
  HOST_DEFAULT_REMEDIES,
  formatGatewayDownWarning,
  formatHostConfigTakeover,
  formatHostSyncFailure,
  probeGatewayReachable
};
