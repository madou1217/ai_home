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
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const {
  readManagedBlock,
  removeManagedBlock,
  replaceManagedBlock
} = require('../../../runtime/managed-text-block');
const {
  SHELL_BLOCK_NAME,
  SHELL_BLOCK_PREFIX,
  buildSnippet,
  detectShell,
  normalizeSnippetOptions,
  resolveRcFile
} = require('./shell-snippet');

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
  const dir = nodePath.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.aih-tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, content, { mode: 0o644 });
  fsImpl.renameSync(tmp, file);
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

  /** 现状描述：rc 里的受管块 + 按当前参数重新生成的块。 */
  function describe(options2 = {}) {
    const { shell, rcFile } = resolveTarget(options2.shell, options2.rcFile);
    const snippetOptions = normalizeSnippetOptions(options2);
    const snippet = shell ? buildSnippet(shell, snippetOptions) : '';
    const rc = rcFile ? readTextIfExists(fsImpl, rcFile) : { exists: false, text: '' };
    const installedBlock = rc.exists
      ? readManagedBlock(rc.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX })
      : null;
    const installed = installedBlock !== null;
    return {
      shell,
      rcFile,
      rcExists: rc.exists,
      installed,
      upToDate: installed && installedBlock.trim() === snippet.trim(),
      snippetOptions,
      snippet
    };
  }

  return {
    resolveTarget,
    status(options2 = {}) {
      const info = describe(options2);
      return {
        ok: Boolean(info.shell),
        reason: info.shell ? '' : 'unsupported_shell',
        shell: info.shell,
        rcFile: info.rcFile,
        rcExists: info.rcExists,
        installed: info.installed,
        upToDate: info.upToDate,
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
        ok: Boolean(info.shell),
        reason: info.shell ? '' : 'unsupported_shell',
        shell: info.shell,
        rcFile: info.rcFile,
        rcExists: info.rcExists,
        installed: info.installed,
        upToDate: info.upToDate,
        content: info.snippet
      };
    },
    apply(options2 = {}) {
      const info = describe(options2);
      if (!info.shell) return { ok: false, error: 'unsupported_shell' };
      if (info.installed && info.upToDate) {
        return { ok: true, changed: false, shell: info.shell, rcFile: info.rcFile, reason: 'already_up_to_date' };
      }
      const before = info.rcExists ? readTextIfExists(fsImpl, info.rcFile).text : '';
      const after = replaceManagedBlock(before, SHELL_BLOCK_NAME, info.snippet, { prefix: SHELL_BLOCK_PREFIX });
      let backupPath = '';
      try {
        if (info.rcExists) {
          backupPath = `${info.rcFile}.aih-backup-${timestampSlug()}`;
          fsImpl.copyFileSync(info.rcFile, backupPath);
        }
        writeAtomic(fsImpl, info.rcFile, after);
      } catch (error) {
        return {
          ok: false,
          error: 'rc_write_failed',
          detail: String((error && error.message) || error),
          rcFile: info.rcFile
        };
      }
      return {
        ok: true,
        changed: true,
        shell: info.shell,
        rcFile: info.rcFile,
        rcCreated: !info.rcExists,
        backupPath,
        reloadHint: info.shell === 'zsh' ? 'source ~/.zshrc' : 'source ~/.bashrc'
      };
    },
    remove(options2 = {}) {
      const { shell, rcFile } = resolveTarget(options2.shell, options2.rcFile);
      if (!shell) return { ok: false, error: 'unsupported_shell' };
      const rc = readTextIfExists(fsImpl, rcFile);
      if (!rc.exists) return { ok: true, removed: false, shell, rcFile, reason: 'rc_missing' };
      const result = removeManagedBlock(rc.text, SHELL_BLOCK_NAME, { prefix: SHELL_BLOCK_PREFIX });
      if (!result.removed) return { ok: true, removed: false, shell, rcFile, reason: 'not_installed' };
      let backupPath = '';
      try {
        backupPath = `${rcFile}.aih-backup-${timestampSlug()}`;
        fsImpl.copyFileSync(rcFile, backupPath);
        writeAtomic(fsImpl, rcFile, result.text);
      } catch (error) {
        return { ok: false, error: 'rc_write_failed', detail: String((error && error.message) || error), rcFile };
      }
      return { ok: true, removed: true, shell, rcFile, backupPath };
    },
    snippet(options2 = {}) {
      const { shell } = resolveTarget(options2.shell, options2.rcFile);
      if (!shell) return { ok: false, error: 'unsupported_shell' };
      return { ok: true, shell, content: buildSnippet(shell, normalizeSnippetOptions(options2)) };
    }
  };
}

module.exports = {
  createShellIntegrationService,
  readTextIfExists,
  timestampSlug,
  writeAtomic
};
