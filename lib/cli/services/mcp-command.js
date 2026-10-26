'use strict';
const fs = require('node:fs');
const { createMcpManager } = require('../../native-resources/mcp-manager');
const { defaultProviderResourceRegistry: registry } = require('../../native-resources/provider-resource-registry');
const { requireMcp } = require('../../native-resources/mcp-errors');
const USAGE = [
  'Usage: aih mcp <command> [options]', '',
  '  list [--provider <id>] [--json]',
  '  add <name> --command <file> [--arg <value> ...] (--provider <id>|--all-supported)',
  '             [--cwd <absolute-dir>] [--env-file <private.json>] [--json]',
  '  test <name> [--provider <id>] [--json]',
  '  tools <name> [--provider <id>] [--json]',
  '  call <name> <tool> [--args-json <json>] [--provider <id>] [--json]',
  '  enable|disable|remove <name> [--provider <id>] [--json]',
  '  doctor [--provider <id>] [--json]', '',
  'add 保存定义，enable 写入原生配置。test/tools/call 直接运行本地 stdio server；停用原生投影后仍可诊断。',
  '省略 provider 时操作同名的已登记资源。env-file 为环境变量键值 JSON，状态仅显示键名。',
  '命令参数可能包含凭据；list/doctor 仅显示参数数量。'
].join('\n');
const COMMANDS = new Set(['list', 'add', 'test', 'tools', 'call', 'enable', 'disable', 'remove', 'doctor']);
function parse(args, command) {
  const result = { positional: [], args: [] };
  const allowed = new Set(['--json', '--provider', ...(command === 'add' ? ['--command', '--arg', '--cwd', '--env-file', '--all-supported'] : []), ...(command === 'call' ? ['--args-json'] : [])]);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('-')) { result.positional.push(token); continue; }
    requireMcp(allowed.has(token), 'mcp_option_unknown');
    if (token === '--json') result.json = true;
    else if (token === '--all-supported') result.allSupported = true;
    else {
      requireMcp(args[i + 1] !== undefined, 'mcp_option_value_required');
      const key = { '--provider': 'provider', '--command': 'command', '--cwd': 'cwd', '--env-file': 'envFile', '--args-json': 'argsJson' }[token];
      if (token === '--arg') result.args.push(args[++i]);
      else {
        requireMcp(result[key] === undefined && !args[i + 1].startsWith('--'), 'mcp_option_value_required');
        result[key] = args[++i];
      }
    }
  }
  requireMcp(!(result.provider && result.allSupported), 'mcp_selector_conflict');
  if (result.provider) result.provider = result.provider.toLowerCase();
  return result;
}
async function runMcpCommand(rawArgs = [], context = {}) {
  const args = rawArgs.slice(1).map(String);
  const command = args.shift();
  const output = context.consoleImpl || console;
  if (!COMMANDS.has(command) || args.includes('--help') || args.includes('-h')) { output.log(USAGE); return 0; }
  try {
    const options = parse(args, command);
    requireMcp(options.positional.length === (['list', 'doctor'].includes(command) ? 0 : command === 'call' ? 2 : 1), 'mcp_argument_required');
    const manager = createMcpManager(context);
    let result;
    if (['list', 'doctor'].includes(command)) result = manager[command](options);
    else {
      const name = options.positional[0];
      let server;
      let toolArgs;
      if (command === 'add') {
        requireMcp(options.provider || options.allSupported, 'mcp_provider_required');
        let env;
        if (options.envFile) {
          requireMcp(fs.statSync(options.envFile).size <= 65536, 'mcp_definition_limit');
          try { env = JSON.parse(fs.readFileSync(options.envFile, 'utf8')); } catch (_) { requireMcp(false, 'mcp_env_invalid'); }
        }
        server = { command: options.command, args: options.args, cwd: options.cwd, env };
      }
      if (command === 'call') {
        try { toolArgs = JSON.parse(options.argsJson || '{}'); } catch (_) { requireMcp(false, 'mcp_tool_arguments_invalid'); }
      }
      const providers = options.provider ? [options.provider] : options.allSupported
        ? registry.listProviders().filter(provider => registry.get(provider, 'mcp').projection)
        : manager.list().resources.filter(record => record.id === name).map(record => record.provider);
      requireMcp(providers.length, 'mcp_not_installed');
      const results = [];
      for (const provider of providers) {
        try {
          const selection = { provider, signal: context.signal };
          const value = command === 'add' ? manager.add(name, server, selection)
            : command === 'call' ? await manager.call(name, options.positional[1], toolArgs, selection)
              : await manager[command](name, selection);
          results.push({ ok: true, provider, result: value });
        } catch (error) { results.push({ ok: false, provider, error: error.code || 'mcp_operation_failed' }); }
      }
      result = { ok: results.every(item => item.ok), results };
    }
    output.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return result.ok === false || result.healthy === false ? 1 : 0;
  } catch (error) {
    output.error(args.includes('--json') ? JSON.stringify({ ok: false, error: error.code || 'mcp_operation_failed' }) : `[aih mcp] ${error.code || 'mcp_operation_failed'}`);
    return 1;
  }
}
module.exports = { runMcpCommand };
