'use strict';

// SFTP realpath names belong to the server namespace, not the local OS and not
// the exec/PowerShell namespace. Keep one session for resolution and I/O.
const { remoteError } = require('../errors');

const invalid = (code) => remoteError(code, `远端工作区路径校验失败：${code}`);
function join(parent, leaf) { return `${parent.replace(/\/$/, '')}/${leaf}`; }
function inside(root, candidate) { return candidate === root || candidate.startsWith(`${root.replace(/\/$/, '')}/`); }
function canonical(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw invalid('path_query_failed');
  // OpenSSH Windows realpath uses forward slashes too. Do not case-fold names:
  // Windows may host case-sensitive directories.
  return value.length > 1 ? value.replace(/\/$/, '') : value;
}

async function resolveSftpPath(session, root, rel, mode, options, expected = '') {
  const call = async (method, args) => {
    try { return await session.call(method, args, options); }
    catch (error) {
      if (error.code === 2) throw invalid('not_found');
      if (error.code === 3) throw invalid('permission_denied');
      if (typeof error.code === 'string') throw error;
      throw invalid('path_query_failed');
    }
  };
  const rootReal = canonical(await call('realpath', [root]));
  if (expected && rootReal !== expected) throw invalid('workspace_root_changed');
  const rootAttrs = await call('stat', [rootReal]);
  if (!rootAttrs.isDirectory?.()) throw invalid('not_directory');
  const parts = rel.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..') || rel.startsWith('/') || rel.includes('\0')) throw invalid('invalid_path');
  let current = rootReal, target = rootReal, entry = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const last = index === parts.length - 1;
    entry = join(current, parts[index]);
    if (last && mode === 'remove') { target = entry; break; }
    let attrs;
    try { attrs = await call('lstat', [entry]); }
    catch (error) {
      if (error.code !== 'not_found' || mode !== 'replace') throw error;
      if (last) { target = entry; break; }
      // Missing parent creation is authorized only after its canonical parent
      // was proved inside root. EEXIST never skips subsequent verification.
      try { await call('mkdir', [entry]); } catch (mkdirError) {
        if (mkdirError.code !== 'path_query_failed') throw mkdirError;
      }
      attrs = await call('lstat', [entry]);
    }
    try { target = canonical(await call('realpath', [entry])); }
    catch (error) {
      if (attrs.isSymbolicLink?.() && error.code === 'not_found') throw invalid('path_resolution_failed');
      throw error;
    }
    if (!inside(rootReal, target)) throw invalid('path_outside_workspace');
    if (attrs.isSymbolicLink?.()) {
      try { attrs = await call('stat', [target]); }
      catch (error) {
        if (error.code === 'not_found') throw invalid('path_resolution_failed');
        throw error;
      }
    }
    if (!last && !attrs.isDirectory?.()) throw invalid('not_directory');
    current = target;
  }
  if (!parts.length && mode !== 'read') throw invalid('invalid_path');
  return { root: rootReal, target, io: mode === 'read' ? target : entry };
}

module.exports = { resolveSftpPath };
