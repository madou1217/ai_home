'use strict';

// Work 会话的工作区检查点（每轮对话前一次快照）与撤销：本机项目与远程工作区同一套机制。
//
//   快照：用临时 index（GIT_INDEX_FILE）把工作区当前状态（含未跟踪、不含 .gitignore 的文件）
//         写成 tree → commit-tree → refs/aih/checkpoints/<session>/<seq>。
//         不碰用户的暂存区、分支、HEAD、stash；内容没变时复用上一个检查点（不新增 ref）。
//   撤销：把工作区恢复到某个检查点：read-tree 到临时 index → checkout-index 写回文件，
//         并删除「检查点之后新增、且不被 .gitignore 忽略」的文件。恢复前先给当前状态再拍一个
//         检查点（kind=pre-restore），撤销本身也可撤销。
//
// 执行面是策略（Strategy）：local 用 child_process 跑 sh，remote 经 RemoteHost.run 在远端跑 sh。
// 两边执行的是同一段 POSIX sh 脚本（git plumbing），所以行为一致。工作区不是 git 仓库 / 没装 git
// 时检查点静默跳过（返回 null），不阻塞对话。Windows 远端暂不支持（PowerShell 方言）。

const { spawn } = require('node:child_process');
const path = require('node:path');

const REF_ROOT = 'refs/aih/checkpoints';
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sessionSegment(sessionId) {
  const value = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  if (!SAFE_SEGMENT.test(value)) throw Object.assign(new Error('invalid session id'), { code: 'invalid_session_id' });
  return value;
}

// 公共前缀：确认是 git 工作区，准备临时 index（退出时清理）。
const PRELUDE = [
  'command -v git >/dev/null 2>&1 || { echo AIH_NO_GIT; exit 0; }',
  'top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo AIH_NO_REPO; exit 0; }',
  'cd "$top" || exit 3',
  // 临时 index 放在 .git 内（同文件系统，不进工作区）；先复制用户 index 作种子（只做 stat 增量，大仓库也快），
  // 用户 index 本身不被修改。git 拒绝 0 字节 index，没有种子时让 git 从空开始。
  'gitdir=$(git rev-parse --absolute-git-dir) || exit 4',
  'tmp="$gitdir/aih-ckpt-index.$$"',
  'trap \'rm -f "$tmp" "$tmp.lock"\' EXIT',
  'if [ -f "$gitdir/index" ]; then cp "$gitdir/index" "$tmp" 2>/dev/null || rm -f "$tmp"; else rm -f "$tmp"; fi',
  'export GIT_INDEX_FILE="$tmp"',
  'export GIT_AUTHOR_NAME=aih GIT_AUTHOR_EMAIL=aih@localhost GIT_COMMITTER_NAME=aih GIT_COMMITTER_EMAIL=aih@localhost'
].join('\n');

/** 拍快照：输出 `AIH_CKPT <commit> <tree> <reused>`。 */
function snapshotScript(sessionSeg, label) {
  return `${PRELUDE}
git add -A -- . >/dev/null 2>&1 || exit 5
tree=$(git write-tree) || exit 6
last=$(git for-each-ref --sort=-creatordate --count=1 --format='%(objectname)' ${shQuote(`${REF_ROOT}/${sessionSeg}/`)})
if [ -n "$last" ] && [ "$(git rev-parse "$last^{tree}" 2>/dev/null)" = "$tree" ]; then echo "AIH_CKPT $last $tree 1"; exit 0; fi
parent=$(git rev-parse -q --verify HEAD 2>/dev/null)
commit=$(printf '%s\\n' ${shQuote(label)} | git commit-tree "$tree" \${parent:+-p "$parent"}) || exit 7
seq=$(date +%s)$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' ')
git update-ref ${shQuote(`${REF_ROOT}/${sessionSeg}/`)}"$seq" "$commit" || exit 8
echo "AIH_CKPT $commit $tree 0"`;
}

/** 列出检查点：每行 `AIH_REF <refname> <commit> <unix> <subject>`。 */
function listScript(sessionSeg) {
  return `${PRELUDE}
git for-each-ref --sort=-creatordate --format='AIH_REF %(refname) %(objectname) %(creatordate:unix) %(subject)' ${shQuote(`${REF_ROOT}/${sessionSeg}/`)}`;
}

/** 某检查点相对当前工作区的变更文件（name-status）。 */
function diffScript(commit) {
  return `${PRELUDE}
git add -A -- . >/dev/null 2>&1 || exit 5
now=$(git write-tree) || exit 6
echo AIH_DIFF
git diff-tree -r --name-status ${shQuote(commit)}^{tree} "$now"`;
}

/** 恢复到检查点：写回检查点里的文件，删除之后新增（未被忽略）的文件。 */
function restoreScript(commit) {
  return `${PRELUDE}
git cat-file -e ${shQuote(`${commit}^{tree}`)} 2>/dev/null || { echo AIH_NO_CHECKPOINT; exit 0; }
git add -A -- . >/dev/null 2>&1 || exit 5
now=$(git write-tree) || exit 6
git diff-tree -r --diff-filter=A --name-only -z ${shQuote(commit)}^{tree} "$now" | xargs -0 rm -f -- 2>/dev/null
git read-tree ${shQuote(commit)}^{tree} || exit 9
git checkout-index -a -f || exit 10
# 用户 index 的 stat 缓存因文件被改写而过期：刷新它（只更新 stat 信息，不改暂存内容）。
GIT_INDEX_FILE="$gitdir/index" git update-index -q --refresh >/dev/null 2>&1
echo AIH_RESTORED`;
}

function parseMarker(stdout) {
  const text = String(stdout || '');
  if (text.includes('AIH_NO_GIT')) return { skipped: 'git_not_installed' };
  if (text.includes('AIH_NO_REPO')) return { skipped: 'not_a_git_repository' };
  return null;
}

// ── 执行面（Strategy）────────────────────────────────────────────────

function createLocalRunner(projectPath) {
  return (script) => new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

function createRemoteRunner(host) {
  return async (script) => {
    const result = await host.run(`sh -c ${shQuote(script)}`, { lane: 'bulk', timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * 按项目路径选执行面：远程工作区影子目录 → 远端；否则本机目录。
 * @returns {{ kind: 'local'|'remote', run: (script: string) => Promise<{code, stdout, stderr}> } | null}
 */
function resolveCheckpointRunner({ fs: fsImpl, aiHomeDir, projectPath }) {
  const value = String(projectPath || '').trim();
  if (!value || !path.isAbsolute(value)) return null;
  const { workspaceIdFromProjectPath, loadWorkspace } = require('./remote-session-bridge');
  const workspaceId = workspaceIdFromProjectPath(aiHomeDir, value);
  if (workspaceId) {
    if (!loadWorkspace(fsImpl, aiHomeDir, workspaceId)) return null;
    const { getRemoteWorkspaceService } = require('../remote-workspace');
    const host = getRemoteWorkspaceService({ fs: fsImpl, aiHomeDir }).host(workspaceId);
    return { kind: 'remote', run: createRemoteRunner(host) };
  }
  try {
    if (!fsImpl.statSync(value).isDirectory()) return null;
  } catch (_error) {
    return null;
  }
  return { kind: 'local', run: createLocalRunner(value) };
}

function failure(result, code) {
  const detail = String(result.stderr || result.stdout || '').trim().slice(-400);
  return Object.assign(new Error(detail || `${code} (exit ${result.code})`), { code });
}

class WorkspaceCheckpoints {
  constructor(runner) {
    this.runner = runner;
  }

  /** 拍检查点；不可用（非 git / 无 git）返回 { skipped }。 */
  async snapshot(sessionId, { label = 'aih checkpoint' } = {}) {
    const result = await this.runner.run(snapshotScript(sessionSegment(sessionId), label));
    const skipped = parseMarker(result.stdout);
    if (skipped) return skipped;
    const match = /AIH_CKPT ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([01])/.exec(result.stdout);
    if (result.code !== 0 || !match) throw failure(result, 'checkpoint_failed');
    return { commit: match[1], tree: match[2], reused: match[3] === '1' };
  }

  async list(sessionId) {
    const result = await this.runner.run(listScript(sessionSegment(sessionId)));
    const skipped = parseMarker(result.stdout);
    if (skipped) return { ...skipped, checkpoints: [] };
    if (result.code !== 0) throw failure(result, 'checkpoint_list_failed');
    const checkpoints = result.stdout.split('\n').map((line) => {
      const match = /^AIH_REF (\S+) ([0-9a-f]{40,64}) (\d+) ?(.*)$/.exec(line.trim());
      return match ? { ref: match[1], commit: match[2], createdAt: Number(match[3]) * 1000, label: match[4] } : null;
    }).filter(Boolean);
    return { checkpoints };
  }

  /** 检查点 → 当前工作区的变更（撤销会影响哪些文件）。 */
  async changes(commit) {
    if (!/^[0-9a-f]{40,64}$/.test(String(commit))) throw Object.assign(new Error('invalid checkpoint'), { code: 'invalid_checkpoint' });
    const result = await this.runner.run(diffScript(commit));
    const skipped = parseMarker(result.stdout);
    if (skipped) return { ...skipped, files: [] };
    if (result.code !== 0) throw failure(result, 'checkpoint_diff_failed');
    const body = result.stdout.split('AIH_DIFF\n')[1] || '';
    const files = body.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status.charAt(0), path: rest.join('\t') };
    });
    return { files };
  }

  /** 恢复到检查点（先给当前状态拍 pre-restore 检查点）。 */
  async restore(sessionId, commit) {
    if (!/^[0-9a-f]{40,64}$/.test(String(commit))) throw Object.assign(new Error('invalid checkpoint'), { code: 'invalid_checkpoint' });
    const before = await this.snapshot(sessionId, { label: 'aih pre-restore' });
    if (before.skipped) return before;
    const result = await this.runner.run(restoreScript(commit));
    if (result.stdout.includes('AIH_NO_CHECKPOINT')) throw Object.assign(new Error('检查点不存在'), { code: 'checkpoint_not_found' });
    if (result.code !== 0 || !result.stdout.includes('AIH_RESTORED')) throw failure(result, 'checkpoint_restore_failed');
    return { restored: commit, preRestore: before.commit };
  }
}

function openWorkspaceCheckpoints(options) {
  const runner = resolveCheckpointRunner(options);
  return runner ? Object.assign(new WorkspaceCheckpoints(runner), { kind: runner.kind }) : null;
}

module.exports = {
  REF_ROOT,
  WorkspaceCheckpoints,
  openWorkspaceCheckpoints,
  resolveCheckpointRunner,
  __private: { snapshotScript, restoreScript, listScript, diffScript, sessionSegment }
};
