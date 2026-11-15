'use strict';

// Cross-runtime scripts own remote path semantics. This adapter owns framing
// and error translation; it never treats a failed query as permission to write.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { remoteError } = require('../errors');
const { shQuote, psQuote, psEncoded } = require('./dialect');
const scriptsRoot = path.resolve(__dirname, '../../..', 'contracts/workspacepath');
const posix = fs.readFileSync(path.join(scriptsRoot, 'resolve-posix.sh'), 'utf8');
const powershell = fs.readFileSync(path.join(scriptsRoot, 'resolve-powershell.ps1'), 'utf8');
const searchPOSIX = fs.readFileSync(path.join(scriptsRoot, 'search-posix.sh'), 'utf8');
const searchPowerShell = fs.readFileSync(path.join(scriptsRoot, 'search-powershell.ps1'), 'utf8');
const CODES = new Set(['workspace_root_changed', 'invalid_path', 'path_outside_workspace', 'path_resolution_failed', 'path_query_failed', 'not_found', 'not_directory', 'permission_denied']);

function encodedScript(script) {
  const command = psEncoded(script);
  if (command.length <= 7500) return command;
  const encoded = zlib.gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return psEncoded(`$b=[Convert]::FromBase64String(${psQuote(encoded)});$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);try{&([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$g.Dispose();$m.Dispose()}`);
}

function resolverCommand(dialect, root, rel, mode, expected = '') {
  if ([root, rel].some((value) => value.includes('\0'))) throw remoteError('invalid_path', '路径含非法字符');
  if (dialect.id === 'posix') return `sh -c ${shQuote(posix)} aih-workspace-path ${shQuote(root)} ${shQuote(rel)} ${shQuote(mode)} ${shQuote(expected)}`;
  if (dialect.id === 'powershell') return encodedScript(`$root=${psQuote(root)};$rel=${psQuote(rel)};$mode=${psQuote(mode)};$expected=${psQuote(expected)};${powershell}`);
  throw remoteError('path_resolution_unsupported', '远端不支持真实路径校验');
}

async function resolveWorkspacePath(run, dialect, root, rel, mode = 'read', expected = '') {
  const result = await run(resolverCommand(dialect, root, rel, mode, expected), { maxOutputBytes: 64 * 1024 });
  if (result.truncated) throw remoteError('path_query_failed', '远端路径校验响应不完整');
  if (result.code !== 0) {
    const entry = result.stderr.toString('utf8').split(/\r?\n/).find((line) => line.startsWith('AIH_PATH:'));
    const code = entry?.slice('AIH_PATH:'.length);
    throw remoteError(CODES.has(code) ? code : 'path_query_failed', `远端工作区路径校验失败：${CODES.has(code) ? code : 'path_query_failed'}`);
  }
  const fields = result.stdout.toString('utf8').split('\0');
  if (fields.length !== 4 || fields[3] !== '' || fields.slice(0, 3).some((value) => !value)) throw remoteError('path_query_failed', '远端路径校验响应格式错误');
  return { root: fields[0], target: fields[1], io: fields[2] };
}

function searchCommand(root, pattern, maximum, dialect) {
  if (dialect?.id === 'powershell') return encodedScript(`$root=${psQuote(root)};$pattern=${psQuote(pattern)};$maximum=${Number(maximum)};$preferRg=$true;$skipIgnored=$true;${searchPowerShell}`);
  return `cd ${shQuote(root)} && sh -c ${shQuote(searchPOSIX)} aih-workspace-search ${shQuote(pattern)} ${Number(maximum)} 1 50`;
}

module.exports = { resolveWorkspacePath, searchCommand };
