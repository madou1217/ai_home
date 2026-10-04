'use strict';

// `aih plugin <command>`。
//
// 离线命令（不需要 aih server）：validate、pack。
// 运行时命令一律交给正在运行的 aih server（它独占 Plugin Host）：install、list、enable、disable、
// uninstall、call、doctor。CLI 自己不拉宿主，避免出现「CLI 一个宿主、服务端一个宿主」两份运行时。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildArtifact } = require('./artifact');
const { validateManifest } = require('../sdk/manifest');
const { PluginError } = require('../sdk/errors');
const { createPluginHostSupervisor } = require('../host/supervisor');
const { readServerConfig } = require('../../server/server-config-store');
const { buildServerUrl } = require('../../server/server-defaults');

const USAGE = [
  'Usage: aih plugin <command> [options]',
  '',
  '  validate <dir> [--load]          校验插件目录的 plugin.json；--load 在一次性宿主里试加载',
  '  pack <dir> [out.aih-plugin]      打包成离线插件包',
  '  install <file.aih-plugin>        安装插件包（校验摘要后接受）',
  '  list                             已安装插件、实例与运行状态',
  '  enable <pluginId> [--instance <id>] [--version <v>] [--config-json <json>]',
  '  disable <instanceId> [--remove]  停用实例（--remove 同时删除实例配置）',
  '  uninstall <pluginId> [--version <v>]',
  '  call <contributionId> [--value-json <json>]   调试调用一个贡献项',
  '  doctor                           检查制品、实例与运行时',
  '',
  '  通用选项：--json  以 JSON 输出；--expected-revision <n>  并发保护'
].join('\n');

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : String(args[index + 1] === undefined ? '' : args[index + 1]);
}

function positional(args, index) {
  const values = [];
  for (let position = 0; position < args.length; position += 1) {
    if (args[position].startsWith('--')) {
      if (!['--json', '--load', '--remove'].includes(args[position])) position += 1;
      continue;
    }
    values.push(args[position]);
  }
  return values[index];
}

function parseJsonOption(args, name) {
  const value = option(args, name);
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch (_error) { throw new PluginError('plugin_json_invalid', `${name} 不是合法 JSON`); }
}

function readManifest(dir) {
  const file = path.join(path.resolve(dir), 'plugin.json');
  if (!fs.existsSync(file)) throw new PluginError('plugin_manifest_missing', `${dir} 下没有 plugin.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { throw new PluginError('plugin_manifest_invalid', 'plugin.json 不是合法 JSON'); }
}

// 一次性宿主：临时 socket、用完即停，与 aih server 的宿主和插件状态无关。
async function loadOnce(dir, manifest) {
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'aihv-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-validate-${path.basename(base)}` : path.join(base, 'h.sock');
  const supervisor = createPluginHostSupervisor({ aiHomeDir: base, socketPath });
  try {
    const prepared = (await supervisor.call('prepare', {
      generation: 1,
      plugins: [{ instanceId: manifest.pluginId, manifest, entryPath: path.join(path.resolve(dir), ...manifest.entry.split('/')) }]
    })).value;
    return prepared;
  } finally {
    await supervisor.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function createServerClient(context) {
  const aiHomeDir = context.aiHomeDir;
  const config = readServerConfig({ fs, aiHomeDir });
  const key = String(context.managementKey || process.env.AIH_SERVER_MANAGEMENT_KEY || config.managementKey || '').trim();
  // 服务端监听在通配地址时，本机 CLI 走回环地址连接。
  const host = ['', '0.0.0.0', '::', '[::]'].includes(String(config.host || '').trim()) ? '127.0.0.1' : config.host;
  // serverBaseUrl 只供测试指向隔离的临时服务端。
  const base = context.serverBaseUrl ? `${String(context.serverBaseUrl).replace(/\/+$/, '')}/v0/plugins` : buildServerUrl({ ...config, host }, '/v0/plugins');
  const fetchImpl = context.fetchImpl || fetch;
  return async function request(method, route, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new PluginError('plugin_server_unreachable', `连不上 aih server（${base}）：${error.cause?.code || error.message}。请先运行 aih server start`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new PluginError(payload.error || `http_${response.status}`, payload.message || payload.error || `HTTP ${response.status}`);
      error.diagnostics = payload.diagnostics || [];
      throw error;
    }
    return payload;
  };
}

function render(command, result) {
  if (command === 'list') {
    const lines = [`revision ${result.revision} · 运行时 ${result.runtime?.state || 'unknown'} · 代次 ${result.runtime?.activeGeneration || 0}`];
    for (const item of result.installed || []) lines.push(`  已安装 ${item.pluginId}@${item.version}  ${item.digest.slice(0, 12)}`);
    for (const item of result.instances || []) lines.push(`  实例 ${item.instanceId} → ${item.pluginId}@${item.version}  ${item.enabled ? '已启用' : '已停用'}`);
    if (!(result.installed || []).length) lines.push('  （没有已安装的插件）');
    return lines.join('\n');
  }
  if (command === 'doctor') {
    if (result.healthy) return `插件状态正常（revision ${result.revision}）`;
    return ['发现问题：', ...(result.issues || []).map((issue) => `  ${issue.code}  ${issue.pluginId || issue.instanceId || ''} ${issue.detail || ''}`)].join('\n');
  }
  return JSON.stringify(result, null, 2);
}

async function runPluginCommand(rawArgs = [], context = {}) {
  const args = (Array.isArray(rawArgs) ? rawArgs.slice(1) : []).map(String);
  const command = String(args[0] || 'help');
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const output = context.consoleImpl || console;
  try {
    let result;
    if (command === 'help' || command === '--help' || command === '-h') {
      output.log(USAGE);
      return 0;
    }
    if (command === 'validate') {
      const dir = positional(rest, 0);
      if (!dir) throw new PluginError('plugin_args_invalid', '用法：aih plugin validate <dir> [--load]');
      const manifest = validateManifest(readManifest(dir));
      result = { ok: true, pluginId: manifest.pluginId, version: manifest.version, contributes: manifest.contributes.map((item) => item.id) };
      if (rest.includes('--load')) {
        const prepared = await loadOnce(dir, manifest);
        if (prepared.state !== 'prepared') {
          const error = new PluginError('plugin_candidate_rejected', '试加载失败');
          error.diagnostics = prepared.diagnostics || [];
          throw error;
        }
        result.loaded = { contributions: prepared.contributions };
      }
    } else if (command === 'pack') {
      const dir = positional(rest, 0);
      if (!dir) throw new PluginError('plugin_args_invalid', '用法：aih plugin pack <dir> [out.aih-plugin]');
      const manifest = validateManifest(readManifest(dir));
      const out = positional(rest, 1) || path.resolve(`${manifest.pluginId}-${manifest.version}.aih-plugin`);
      const built = buildArtifact(dir, out);
      result = { ok: true, file: built.file, digest: built.digest, bytes: built.bytes, files: built.files.length };
    } else {
      const request = createServerClient(context);
      const expectedRevision = option(rest, '--expected-revision');
      if (command === 'install') {
        const file = positional(rest, 0);
        if (!file) throw new PluginError('plugin_args_invalid', '用法：aih plugin install <file.aih-plugin>');
        result = await request('POST', '/install', { file: path.resolve(file) });
      } else if (command === 'list' || command === 'status') {
        result = await request('GET', '');
      } else if (command === 'doctor') {
        result = await request('GET', '/doctor');
      } else if (command === 'enable') {
        result = await request('POST', '/enable', {
          pluginId: positional(rest, 0), instanceId: option(rest, '--instance'), version: option(rest, '--version'),
          configuration: parseJsonOption(rest, '--config-json'), expectedRevision
        });
      } else if (command === 'disable') {
        result = await request('POST', '/disable', { instanceId: positional(rest, 0), remove: rest.includes('--remove'), expectedRevision });
      } else if (command === 'uninstall') {
        result = await request('POST', '/uninstall', { pluginId: positional(rest, 0), version: option(rest, '--version'), expectedRevision });
      } else if (command === 'call') {
        result = await request('POST', '/invoke', { contributionId: positional(rest, 0), value: parseJsonOption(rest, '--value-json') });
      } else {
        throw new PluginError('plugin_command_unknown', `未知子命令 ${command}\n${USAGE}`);
      }
    }
    output.log(json ? JSON.stringify(result, null, 2) : render(command === 'status' ? 'list' : command, result));
    return 0;
  } catch (error) {
    const failure = { ok: false, error: error.code || 'plugin_error', message: error.message, diagnostics: error.diagnostics || [] };
    if (json) output.log(JSON.stringify(failure, null, 2));
    else {
      output.error(`\x1b[31m[aih] plugin ${command} 失败：${error.message}\x1b[0m`);
      for (const item of failure.diagnostics) output.error(`  ${item.code}  ${item.instanceId || ''} ${item.detail || ''}`);
    }
    return 1;
  }
}

module.exports = { runPluginCommand, USAGE };
