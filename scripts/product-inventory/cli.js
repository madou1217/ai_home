'use strict';

const {
  TOP_LEVEL_COMMANDS,
  NESTED_SUBCOMMAND_TABLES,
  PROVIDER_ACTION_SUBCOMMANDS,
  listProviderNames,
  listProviderActions,
  listProviderActionFlags
} = require('../../lib/cli/complete/command-tree');

// Declared commands are candidates for the audit, not proof of executable support.
function collectCliEntries() {
  const entries = new Map();
  const add = (tokens, description, details = {}) => {
    const command = ['aih', ...tokens].join(' ');
    entries.set(command, {
      id: `cli:${command}`,
      surface: 'cli',
      entry: command,
      description: description || '',
      evidence: 'declared_command',
      source: 'lib/cli/complete/command-tree.js',
      ...details
    });
  };
  for (const command of TOP_LEVEL_COMMANDS) {
    const names = [command.name, ...(command.aliases || [])];
    for (const name of names) {
      add([name], command.summary, { aliasOf: name === command.name ? null : command.name });
      for (const child of command.subcommands || []) {
        add([name, child.name], child.summary, { canonical: ['aih', command.name, child.name].join(' ') });
      }
      for (const flag of command.flags || []) add([name, flag], '声明的命令选项');
    }
  }
  for (const [prefix, children] of Object.entries(NESTED_SUBCOMMAND_TABLES)) {
    for (const name of children) add([...prefix.split(' '), name], '声明的嵌套操作');
  }
  for (const provider of listProviderNames()) {
    add([provider], '启动官方客户端', { provider });
    add([provider, '--'], '原生参数逃生门', { provider });
    for (const action of listProviderActions(provider)) {
      add([provider, action.name], action.summary, { provider });
      for (const name of PROVIDER_ACTION_SUBCOMMANDS[action.name] || []) {
        add([provider, action.name, name], 'Provider 操作的子命令', { provider });
      }
      for (const flag of listProviderActionFlags(action.name)) {
        add([provider, action.name, typeof flag === 'string' ? flag : flag.name], 'Provider 操作选项', { provider });
      }
    }
  }
  return [...entries.values()];
}

module.exports = { collectCliEntries };
