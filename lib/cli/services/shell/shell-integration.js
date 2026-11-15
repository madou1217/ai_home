'use strict';

/**
 * `aih shell` 的落地层：把片段写进（或从）用户的 rc 文件里。
 *
 * 纪律（与 `aih edge` 同一套）：
 * 1. `plan` 永远只打印，不写文件；`apply` 才是写。
 * 2. 写入前先备份（`<rc>.aih-backup-<时间戳>`），并且**原子替换**（同目录临时文件 + rename），
 *    绝不用截断写覆盖用户正在用的 rc。
 * 3. 只动 `# >>> aih:shell >>>` 标记之间的那一段，其余内容逐字节保留。
 * 4. `status` 的判断依据是「rc 里的块」与「按当前参数重新生成的块」是否一致，
 *    不额外维护状态文件——避免状态文件和真实文件互相漂移。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');
const crypto = require('node:crypto');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const { readManagedBlock } = require('../../../runtime/managed-text-block');
const { readSnapshot, writeSnapshot } = require('./rc-file');
const { storedSnippetOptions } = require('./snippet-settings');
const { inspectBlock, replaceRcBlock, removeRcBlock } = require('./rc-block');
const {
  SHELL_BLOCK_NAME,
  SHELL_BLOCK_PREFIX,
  SUPPORTED_SHELLS,
  buildSnippet,
  detectShell,
  normalizeSnippetOptions,
  resolveRcFile
} = require('./shell-snippet');

/** 各 shell 的「命令在不在 PATH 上」探测（只看文件名，不执行）：决定 `apply --all` 的范围。 */
const SHELL_BINARIES = Object.freeze({
  zsh: Object.freeze(['zsh']),
  bash: Object.freeze(['bash']),
  fish: Object.freeze(['fish']),
  powershell: Object.freeze(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])
});

function resolveShellBinary(shell, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const env = options.env || process.env;
  const pathImpl = options.path || nodePath;
  const names = SHELL_BINARIES[shell] || [];
  if (!names.length) return '';
  const dirs = String(env.PATH || '').split(pathImpl.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathImpl.join(dir, name);
      try {
        if (fsImpl.existsSync(candidate)) return candidate;
      } catch (_error) {
        /* 继续 */
      }
    }
  }
  return '';
}

/** Reload the actual rc that was written, including ZDOTDIR/custom rc paths. */
function reloadHintFor(shell, rcFile) {
  if (shell === 'fish') return 'exec fish';
  const quoted = shell === 'powershell'
    ? `'${String(rcFile).replace(/'/g, "''")}'`
    : require('../toolkit/environment/plan-builders').shellQuote(rcFile);
  return `${shell === 'powershell' ? '.' : 'source'} ${quoted}`;
}

function readTextIfExists(fsImpl, file) {
  try {
    if (!fsImpl.existsSync(file)) return { exists: false, text: '' };
    return { exists: true, text: fsImpl.readFileSync(file, 'utf8') };
  } catch (_error) {
    return { exists: false, text: '' };
  }
}

function timestampSlug(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeAtomic(fsImpl, file, content) {
  const snapshot = readSnapshot(fsImpl, file);
  // Generated snippets carry their own BOM decision. User rc snapshots retain
  // their original encoding; the two concerns must not prepend the BOM twice.
  const text = String(content);
  const generated = text.replace(/^\uFEFF/, '');
  const bom = text.startsWith('\uFEFF') ? 'efbbbf' : '';
  return writeSnapshot(fsImpl, snapshot, generated, { outputEncoding: 'utf8', outputBom: bom });
}

// rc 里只留一行 source；真正的补全脚本落到独立文件，避免把 200+ 行逻辑塞进
// .zshrc/.bashrc（用户后续维护、备份、换 shell 都不该被这段拖累）。
function snippetExtension(shell) {
  if (shell === 'zsh') return 'zsh';
  if (shell === 'bash') return 'bash';
  if (shell === 'fish') return 'fish';
  if (shell === 'powershell') return 'ps1';
  return '';
}

function resolveSnippetFile(shell, homeDir, rcFile) {
  const extension = snippetExtension(shell);
  if (!extension) return '';
  // One artifact per rc, not per shell: removing a custom rc must never break
  // the default rc (or another custom one) that is still installed.
  const identity = crypto.createHash('sha256').update(nodePath.resolve(rcFile)).digest('hex').slice(0, 20);
  return nodePath.join(homeDir, '.ai_home', 'shell', `aih-${identity}.${extension}`);
}

function quoteDouble(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

/** rc 文件里的唯一一行：带存在性保护，片段文件被删也不会让 shell 启动报错。 */
function buildRcStub(shell, snippetFile) {
  if (shell === 'powershell') {
    const file = `'${String(snippetFile).replace(/'/g, "''")}'`;
    return `if (Test-Path -LiteralPath ${file}) { . ${file} }`;
  }
  if (shell === 'fish') {
    const file = `'${String(snippetFile).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `test -f ${file}; and source ${file}`;
  }
  const file = quoteDouble(snippetFile);
  return `[ -f ${file} ] && . ${file}`;
}

function referencesSnippet(block, shell, file) {
  const quoted = quoteDouble(file);
  const legacyStub = shell === 'powershell' ? `if (Test-Path ${quoted}) { . ${quoted} }`
    : shell === 'fish' ? `test -f ${quoted}; and source ${quoted}`
      : `[ -f ${quoted} ] && . ${quoted}`;
  const known = new Set([buildRcStub(shell, file), legacyStub]);
  return String(block || '').split(/\r?\n/).some((line) => known.has(line.trim()));
}

function createShellIntegrationService(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const env = options.env || process.env;
  // 目标 rc 一律落在**宿主家目录**：在 provider 沙箱会话里（HOME 被投影覆盖）
  // 执行 `aih shell apply` 时，写进投影目录只会让人以为「装了却没生效」。
  const homeDir = String(options.homeDir || resolveHostHomeDir({ env }) || nodeOs.homedir());

  function resolveTarget(shellOption, rcFileOption) {
    const shell = detectShell({ env, shell: shellOption });
    const override = String(rcFileOption || options.rcFile || '').trim();
    if (override) return { shell, rcFile: override };
    const rcFile = shell ? resolveRcFile(shell, { fs: fsImpl, env, homeDir }) : '';
    return { shell, rcFile };
  }

  /** 现状描述：rc 里的受管块 + 独立片段文件 + 按当前参数重新生成的内容。 */
  function describe(options2 = {}) {
    const { shell, rcFile } = resolveTarget(options2.shell, options2.rcFile);
    const snippetFile = shell ? resolveSnippetFile(shell, homeDir, rcFile) : '';
    const snippetStub = snippetFile ? buildRcStub(shell, snippetFile) : '';
    const snippetFileState = snippetFile
      ? readTextIfExists(fsImpl, snippetFile)
      : { exists: false, text: '' };
    let rc = { exists: false, text: '' };
    let rcError = '';
    try {
      if (rcFile) rc = readSnapshot(fsImpl, rcFile);
      inspectBlock(rc.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX });
    } catch (error) {
      rcError = error.message;
    }
    const installedBlock = rc.exists
      ? readManagedBlock(rc.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX })
      : null;
    const installed = installedBlock !== null;
    const legacyFile = nodePath.join(homeDir, '.ai_home', 'shell', `aih.${snippetExtension(shell)}`);
    const settingsText = installed && referencesSnippet(installedBlock, shell, snippetFile) && snippetFileState.exists
      ? snippetFileState.text
      : installed && referencesSnippet(installedBlock, shell, legacyFile) ? readTextIfExists(fsImpl, legacyFile).text : '';
    const explicit = Object.fromEntries(Object.entries(options2).filter(([, value]) => value !== undefined));
    const snippetOptions = normalizeSnippetOptions({ ...storedSnippetOptions(settingsText), ...explicit });
    const snippet = shell ? buildSnippet(shell, snippetOptions) : '';
    const snippetUpToDate = Boolean(snippet) && snippetFileState.exists
      && snippetFileState.text.trim() === snippet.trim();

    return {
      shell,
      rcFile,
      snippetFile,
      snippetOptions,
      snippet,
      snippetStub,
      snippetFileExists: snippetFileState.exists,
      snippetUpToDate,
      rcExists: rc.exists,
      rcError,
      installed,
      upToDate: !rcError && installed
        && installedBlock.split(/\r?\n/).filter((line) => !line.startsWith('# aih-shell-joined-newline: ')).join('\n').trim() === snippetStub.trim()
        && snippetUpToDate
    };
  }

  return {
    resolveTarget,
    /** 某个 shell 的现状（供 status 表格 / doctor 用）。 */
    describeShell(shell, options2 = {}) {
      const info = describe({ ...options2, shell });
      return {
        ...info,
        shellAvailable: Boolean(resolveShellBinary(shell, { fs: fsImpl, env }))
      };
    },
    statusAll(options2 = {}) {
      return SUPPORTED_SHELLS.map((shell) => this.describeShell(shell, options2));
    },
    status(options2 = {}) {
      const info = describe(options2);
      return {
        ok: Boolean(info.shell) && !info.rcError,
        reason: info.rcError || (info.shell ? '' : 'unsupported_shell'),
        shell: info.shell,
        rcFile: info.rcFile,
        snippetFile: info.snippetFile,
        rcExists: info.rcExists,
        installed: info.installed,
        upToDate: info.upToDate,
        snippetUpToDate: info.snippetUpToDate,
        aihBinPath: info.snippetOptions.aihBinPath,
        features: {
          completion: info.snippetOptions.completion,
          typo: info.snippetOptions.typo,
          wrapper: info.snippetOptions.wrapper
        }
      };
    },
    plan(options2 = {}) {
      const info = describe(options2);
      return {
        ok: Boolean(info.shell) && !info.rcError,
        reason: info.rcError || (info.shell ? '' : 'unsupported_shell'),
        shell: info.shell,
        rcFile: info.rcFile,
        snippetFile: info.snippetFile,
        rcExists: info.rcExists,
        installed: info.installed,
        upToDate: info.upToDate,
        content: info.snippetStub,
        snippetContent: info.snippet
      };
    },
    apply(options2 = {}) {
      const info = describe(options2);
      if (!info.shell) return { ok: false, error: 'unsupported_shell' };
      if (info.rcError) return { ok: false, error: 'rc_read_failed', detail: info.rcError, rcFile: info.rcFile };
      if (info.installed && info.upToDate) {
        return { ok: true, changed: false, shell: info.shell, rcFile: info.rcFile,
          snippetFile: info.snippetFile, reason: 'already_up_to_date' };
      }
      let snapshot;
      let after;
      try {
        snapshot = readSnapshot(fsImpl, info.rcFile);
        after = replaceRcBlock(snapshot.text, SHELL_BLOCK_NAME, info.snippetStub, { prefix: SHELL_BLOCK_PREFIX });
      } catch (error) {
        return { ok: false, error: 'rc_read_failed', detail: error.message, rcFile: info.rcFile };
      }
      // Validate the rc before touching the snippet. A malformed block or dangling
      // symlink must not modify either file. The stub is published last.
      try {
        writeAtomic(fsImpl, info.snippetFile, info.snippet);
      } catch (error) {
        return { ok: false, error: 'snippet_write_failed', detail: error.message, snippetFile: info.snippetFile };
      }
      let backupPath = '';
      try {
        ({ backupPath } = writeSnapshot(fsImpl, snapshot, after, { backup: true }));
      } catch (error) {
        return { ok: false, error: 'rc_write_failed', detail: error.message, rcFile: info.rcFile, snippetFile: info.snippetFile };
      }
      return {
        ok: true,
        changed: true,
        shell: info.shell,
        rcFile: info.rcFile,
        snippetFile: info.snippetFile,
        rcCreated: !info.rcExists,
        backupPath,
        reloadHint: reloadHintFor(info.shell, info.rcFile)
      };
    },
    /** `apply --all`：写进「本机装了该 shell」或「rc 已存在」的每一个 shell。 */
    applyAll(options2 = {}) {
      const results = [];
      for (const shell of SUPPORTED_SHELLS) {
        const info = this.describeShell(shell, options2);
        if (!info.shellAvailable && !info.rcExists) {
          results.push({ shell, ok: true, skipped: true, reason: 'shell_not_installed', rcFile: info.rcFile });
          continue;
        }
        results.push(this.apply({ ...options2, shell }));
      }
      return results;
    },
    remove(options2 = {}) {
      const { shell, rcFile } = resolveTarget(options2.shell, options2.rcFile);
      if (!shell) return { ok: false, error: 'unsupported_shell' };
      let snapshot;
      let result;
      try {
        snapshot = readSnapshot(fsImpl, rcFile);
        result = removeRcBlock(snapshot.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX });
      } catch (error) {
        return { ok: false, error: 'rc_read_failed', detail: error.message, shell, rcFile };
      }
      if (!snapshot.exists) return { ok: true, removed: false, shell, rcFile, reason: 'rc_missing' };
      const snippetFile = resolveSnippetFile(shell, homeDir, rcFile);
      // Pre-upgrade snippets were shared across arbitrary rc files. We cannot
      // prove those files have no other owners, so never delete the legacy file.
      const legacyFile = nodePath.join(homeDir, '.ai_home', 'shell', `aih.${snippetExtension(shell)}`);
      const legacyBlock = readManagedBlock(snapshot.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX });
      const legacySharedSnippet = referencesSnippet(legacyBlock, shell, legacyFile) ? legacyFile : '';
      const removeSnippetFile = () => {
        try {
          fsImpl.unlinkSync(snippetFile);
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      };
      if (!result.removed) {
        // No matching block means no ownership proof. Never delete a file
        // merely because this command knows how to derive its name.
        return { ok: true, removed: false, shell, rcFile, snippetFile, reason: 'not_installed' };
      }
      let backupPath = '';
      try {
        ({ backupPath } = writeSnapshot(fsImpl, snapshot, result.text, { backup: true }));
      } catch (error) {
        return { ok: false, error: 'rc_write_failed', detail: String((error && error.message) || error), rcFile, snippetFile };
      }
      let snippetFileRemoved = false;
      try {
        if (referencesSnippet(legacyBlock, shell, snippetFile)) snippetFileRemoved = removeSnippetFile();
      } catch (error) {
        return { ok: false, removed: true, error: 'snippet_remove_failed', detail: error.message,
          shell, rcFile, snippetFile, backupPath };
      }
      return { ok: true, removed: true, shell, rcFile, snippetFile, snippetFileRemoved, backupPath,
        ...(legacySharedSnippet ? { retainedSharedSnippet: legacySharedSnippet } : {}) };
    },
    snippet(options2 = {}) {
      const { shell } = resolveTarget(options2.shell, options2.rcFile);
      if (!shell) return { ok: false, error: 'unsupported_shell' };
      return { ok: true, shell, content: buildSnippet(shell, normalizeSnippetOptions(options2)) };
    }
  };
}

module.exports = {
  SHELL_BINARIES,
  createShellIntegrationService,
  readTextIfExists,
  resolveShellBinary,
  timestampSlug,
  writeAtomic
};
