'use strict';
const { createSkillManager } = require('../../native-resources/skill-manager');
const { defaultProviderResourceRegistry: registry } = require('../../native-resources/provider-resource-registry');
const { fail } = require('../../native-resources/skill-package');
const USAGE = [
  'Usage: aih skill <command> [options]', '',
  '  list [--provider <id>] [--json]',
  '  install <skillDir> (--provider <id>|--all-supported) [--json]',
  '  enable <skillId> [--provider <id>] [--json]',
  '  disable <skillId> [--provider <id>] [--json]',
  '  remove <skillId> [--provider <id>] [--json]',
  '  doctor [--provider <id>] [--json]', '',
  '安装后立即启用；enable/disable/remove 省略 provider 时处理该 skill 的所有已安装投影。',
  'Skills 为宿主共享资源，账号启动复用宿主投影。doctor 只检查本机文件，不调用模型。',
  '停用/移除 aih-collab 后，后续启动不会自动重新启用；install 可显式恢复。'
].join('\n');
function parse(args) {
  const options = { positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--all-supported') options.allSupported = true;
    else if (arg === '--provider') {
      if (!args[i + 1] || args[i + 1].startsWith('-') || options.provider) fail('skill_provider_required');
      options.provider = args[++i].toLowerCase();
    } else if (arg.startsWith('-')) fail('skill_option_unknown');
    else options.positional.push(arg);
  }
  if (options.provider && options.allSupported) fail('skill_selector_conflict');
  return options;
}
async function runSkillCommand(rawArgs = [], context = {}) {
  const args = rawArgs.slice(1).map(String);
  const command = args.shift();
  const output = context.consoleImpl || console;
  const commands = ['list', 'install', 'enable', 'disable', 'remove', 'doctor'];
  if (!commands.includes(command) || args.some((arg) => ['--help', '-h'].includes(arg))) {
    output.log(USAGE);
    return 0;
  }
  try {
    const options = parse(args);
    if (options.provider && registry.get(options.provider, 'skill').state === 'unsupported') fail('skill_provider_unsupported');
    if (options.allSupported && command !== 'install') fail('skill_selector_invalid');
    const readOnly = ['list', 'doctor'].includes(command);
    if (options.positional.length !== (readOnly ? 0 : 1)) fail('skill_argument_required');
    const manager = createSkillManager(context);
    let result;
    if (readOnly) result = manager[command](options);
    else {
      const value = options.positional[0];
      let providers;
      if (command === 'install') {
        if (!options.provider && !options.allSupported) fail('skill_provider_required');
        providers = options.provider ? [options.provider] : registry.listProviders().filter((provider) => registry.get(provider, 'skill').state !== 'unsupported');
      } else providers = options.provider ? [options.provider] : manager.list().resources.filter((record) => record.id === value).map((record) => record.provider);
      if (!providers.length) fail('skill_not_installed');
      const results = providers.map((provider) => {
        try { return { ok: true, ...manager[command](value, { provider }) }; }
        catch (error) { return { ok: false, provider, error: error.code || 'skill_operation_failed' }; }
      });
      result = { ok: results.every((item) => item.ok), results };
    }
    if (options.json) output.log(JSON.stringify(result));
    else if (readOnly) {
      output.log(`Skills · revision ${result.revision}${command === 'doctor' ? ` · ${result.healthy ? 'healthy' : 'needs attention'}` : ''}`);
      for (const record of result.resources) output.log(`${record.provider}  ${record.id}  ${record.enabled ? 'enabled' : 'disabled'}  ${record.projection || record.mode}  ${record.target}`);
      if (!result.resources.length) output.log('(no managed skills)');
      for (const provider of result.providers || []) output.log(`${provider.provider}  ${provider.state}  ${provider.reason || ''}`);
    } else for (const record of result.results) output.log(`${record.provider}  ${record.id || ''}  ${record.ok ? command + ': ok' : record.error}  ${record.target || ''}`);
    return result.ok === false || result.healthy === false ? 1 : 0;
  } catch (error) {
    output.error(args.includes('--json') ? JSON.stringify({ ok: false, error: error.code || 'skill_operation_failed' }) : `[aih skill] ${error.code || error.message}`);
    return 1;
  }
}
module.exports = { runSkillCommand };
