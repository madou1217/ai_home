'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function runGit(root, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, '--no-optional-locks', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Git command timed out'), { code: 'git_timeout' }));
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    const collect = (target) => (chunk) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const remaining = MAX_OUTPUT_BYTES - bytes;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(accepted);
      bytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      };
      if (code !== 0 && !options.allowFailure) {
        reject(Object.assign(new Error(result.stderr || `git exited ${code}`), { code: 'git_failed', result }));
        return;
      }
      resolve(result);
    });
  });
}

async function getGitSummary(root) {
  const [status, branch, upstream] = await Promise.all([
    runGit(root, ['status', '--porcelain=v1', '-z']),
    runGit(root, ['branch', '--show-current']),
    runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true }),
  ]);
  const files = parsePorcelain(status.stdout);
  const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : '';
  let ahead = 0;
  let behind = 0;
  if (upstreamName) {
    const counts = await runGit(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { allowFailure: true });
    const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
    ahead = Number.isFinite(a) ? a : 0;
    behind = Number.isFinite(b) ? b : 0;
  }
  return { branch: branch.stdout.trim() || 'HEAD', upstream: upstreamName, ahead, behind, files };
}

function parsePorcelain(output) {
  const records = output.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const x = record[0] || ' ';
    const y = record[1] || ' ';
    let filePath = record.slice(3);
    let oldPath;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = records[++i] || undefined;
    }
    files.push({ path: filePath, oldPath, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: x === '?' && y === '?', status: `${x}${y}` });
  }
  return files;
}

async function getGitDiff(root, filePath, staged = false) {
  const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3'];
  if (staged) args.push('--cached');
  args.push('--', filePath);
  const result = await runGit(root, args);
  return { content: result.stdout, truncated: result.truncated };
}

module.exports = { getGitSummary, getGitDiff, __private: { runGit, parsePorcelain } };
