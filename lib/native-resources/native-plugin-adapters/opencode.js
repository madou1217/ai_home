'use strict';
const fs = require('node:fs');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const { requireMcp } = require('../mcp-errors');
const { stat, atomicWrite, ensureOwned, removeOwned, directoryStatus } = require('../native-plugin-files');
function readConfig(ctx, record) {
  const root = path.join(ctx.hostHomeDir, '.config/opencode');
  const file = record?.configFile || [path.join(root, 'opencode.jsonc'), path.join(root, 'opencode.json')].find(x => stat(x)) || path.join(root, 'opencode.json');
  const info = stat(file);
  requireMcp(!info || (info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024), 'native_plugin_config_conflict');
  const text = info ? fs.readFileSync(file, 'utf8') : '{}';
  const errors = [];
  const doc = jsonc.parse(text, errors, { allowTrailingComma: true });
  requireMcp(!errors.length && doc && typeof doc === 'object' && !Array.isArray(doc) && (doc.plugin === undefined || Array.isArray(doc.plugin)), 'native_plugin_config_invalid');
  return { file, text, values: doc.plugin || [] };
}
function updateConfig(config, values) {
  const next = jsonc.applyEdits(config.text, jsonc.modify(config.text, ['plugin'], values, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  if (next !== config.text) atomicWrite(config.file, next);
}
module.exports = {
  target: (ctx, id) => path.join(ctx.hostHomeDir, '.config/opencode/plugins', id),
  install(ctx, pkg, record, previous) {
    const config = readConfig(ctx, previous);
    requireMcp(previous || !config.values.includes(record.target), 'native_plugin_target_conflict');
    ensureOwned(pkg, record, previous);
    if (!config.values.includes(record.target)) updateConfig(config, [...config.values, record.target]);
    record.configFile = config.file;
    return { status: 'projected' };
  },
  disable(ctx, _pkg, record) {
    const config = readConfig(ctx, record);
    requireMcp(directoryStatus(record) !== 'modified', 'native_plugin_target_modified');
    updateConfig(config, config.values.filter(value => value !== record.target));
    removeOwned(record);
  },
  inspect(ctx, record) {
    const config = readConfig(ctx, record);
    const status = directoryStatus(record);
    const configured = config.values.includes(record.target);
    if (status === 'present' && configured) return 'present';
    if (status === 'absent' && !configured) return 'absent';
    return 'modified';
  }
};
