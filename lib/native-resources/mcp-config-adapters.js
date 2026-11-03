'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TOML = require('smol-toml');
const jsonc = require('jsonc-parser');
const { isDeepStrictEqual } = require('node:util');
const { requireMcp } = require('./mcp-errors');
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const commandEntry = server => ({ command: server.command, args: server.args || [], ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}), ...(server.cwd ? { cwd: server.cwd } : {}) });
const FORMATS = Object.freeze({
  'toml-stdio': { key: 'mcp_servers', toml: true, encode: commandEntry },
  'json-stdio': { key: 'mcpServers', encode: server => ({ type: 'stdio', ...commandEntry(server) }) },
  'json-command': { key: 'mcpServers', encode: commandEntry },
  'json-cline': { key: 'mcpServers', encode: server => ({ transport: { type: 'stdio', ...commandEntry(server) } }) },
  'json-opencode': { key: 'mcp', encode: server => ({ type: 'local', command: [server.command, ...(server.args || [])], enabled: true, ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}) }) }
});
function readText(file) {
  try {
    const stat = fs.lstatSync(file);
    requireMcp(stat.isFile() && !stat.isSymbolicLink(), 'mcp_config_file_conflict');
    requireMcp(stat.size <= 4 * 1024 * 1024, 'mcp_config_limit');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function createMcpConfigAdapter(format) {
  const spec = FORMATS[format];
  requireMcp(spec, 'mcp_config_format_unsupported');
  function read(file) {
    const text = readText(file);
    let document;
    try {
      if (spec.toml) document = TOML.parse(text);
      else {
        const errors = [];
        document = jsonc.parse(text || '{}', errors, { allowTrailingComma: true });
        requireMcp(!errors.length, 'mcp_config_invalid');
      }
      requireMcp(object(document) && (own(document, spec.key) === undefined || object(own(document, spec.key))), 'mcp_config_invalid');
    } catch (_) { requireMcp(false, 'mcp_config_invalid'); }
    return { text, document, servers: own(document, spec.key) || {} };
  }
  function range(text, name) {
    const begin = `# aih-mcp:${name}:begin`;
    const end = `# aih-mcp:${name}:end`;
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (start < 0 && finish < 0) return null;
    requireMcp(start >= 0 && finish > start && text.indexOf(begin, start + begin.length) < 0 && text.indexOf(end, finish + end.length) < 0, 'mcp_config_marker_invalid');
    return { start, end: finish + end.length + (text[finish + end.length] === '\n' ? 1 : 0) };
  }
  function update(file, name, entry, previousEntry) {
    const { text, servers } = read(file);
    const current = own(servers, name);
    if (current !== undefined) {
      requireMcp(previousEntry !== undefined, 'mcp_target_conflict');
      requireMcp(isDeepStrictEqual(current, previousEntry), 'mcp_target_modified');
    }
    if (isDeepStrictEqual(current, entry)) return;
    let next;
    if (spec.toml) {
      const span = range(text, name);
      requireMcp(current === undefined || span, 'mcp_target_modified');
      const retained = span ? text.slice(0, span.start) + text.slice(span.end) : text;
      if (entry === undefined) next = retained;
      else next = retained + (retained && !retained.endsWith('\n') ? '\n' : '') + `# aih-mcp:${name}:begin\n` + TOML.stringify({ [spec.key]: { [name]: entry } }) + `# aih-mcp:${name}:end\n`;
    } else {
      next = jsonc.applyEdits(text || '{}', jsonc.modify(text || '{}', [spec.key, name], entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    }
    if (next !== text) atomicWrite(file, next);
  }
  return { encode: spec.encode, read, update, supportsCwd: format !== 'json-opencode' };
}
module.exports = { createMcpConfigAdapter, FORMATS };
