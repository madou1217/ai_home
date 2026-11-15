'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { normalizeSessionProjectPath } = require('../runtime/session-project-scope');

// CLI scope belongs to the launching process, not the shared app-server's cwd.
// --all is opt-in; -C/--cd must also scope the app-server, not only the TUI.
function resolveCodexSessionListScope(args, cwd) {
  const tokens = Array.isArray(args) ? args.map(String) : [];
  let directory = String(cwd || '').trim();
  let allProjects = false;
  const valueFlags = new Set([
    '-c', '--config', '-m', '--model', '-p', '--profile', '--enable', '--disable',
    '--remote', '--remote-auth-token-env', '-a', '--ask-for-approval', '-s', '--sandbox',
    '-i', '--image', '--add-dir', '--local-provider'
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') break;
    if (token === '--all') allProjects = true;
    else if (token === '-C' || token === '--cd') {
      if (tokens[index + 1]) directory = path.resolve(directory, tokens[++index]);
    } else if (token.startsWith('--cd=')) {
      directory = path.resolve(directory, token.slice('--cd='.length));
    } else if (token.startsWith('-C') && token.length > 2) {
      directory = path.resolve(directory, token.slice(2));
    } else if (valueFlags.has(token)) index += 1;
  }
  return { cwd: directory, injectCwd: !allProjects };
}

function withCodexAllProjectsUrl(remoteUrl) {
  const url = new URL(remoteUrl);
  url.searchParams.set('aih_all_projects', '1');
  return url.toString();
}

// Missing/relative/non-string cwd is not an implicit host-wide request. Keep
// the all-projects intent in proxy contexts after stripping it from native RPC.
function readCodexSessionCwd(processObj = process) {
  try {
    const cwd = typeof processObj.cwd === 'function' ? processObj.cwd() : '';
    // Node may cache getcwd even after the directory was removed.
    return cwd && fs.statSync(cwd).isDirectory() ? cwd : '';
  } catch (_error) {
    // getcwd can fail after the launch directory was removed. Do not turn that
    // condition into a host-wide thread list or crash the shared proxy.
    return '';
  }
}

function resolveCodexThreadListScope(params = {}) {
  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
  return {
    cwd: normalizeSessionProjectPath(cwd) ? cwd : '',
    allProjects: params.allProjects === true
  };
}

module.exports = { resolveCodexSessionListScope, withCodexAllProjectsUrl, resolveCodexThreadListScope, readCodexSessionCwd };
