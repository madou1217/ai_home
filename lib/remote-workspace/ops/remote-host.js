'use strict';

// 一个远程工作区在远端能做的全部事情（Facade）：文件、搜索、命令、git。
//
// 组合关系：
//   ConnectionPool（连接复用 / 熔断 / 延迟）
//     → dialect（POSIX / PowerShell 命令写法，首次连接探测并缓存）
//     → 命令通道策略：POSIX 走常驻命令会话（一次操作一个往返）；Windows 走一次性 exec
//     → fileOps 策略：POSIX 用 sh 命令（读文件 / 列目录都是一个往返，SFTP 要 3~4 个）；
//                     Windows 用 SFTP（Windows OpenSSH 自带），不可用时降级 PowerShell
//     → path-guard（所有路径限定在工作区根目录内）
//
// 可靠性约定：
//   - 只读操作遇到连接层可重试错误，换健康连接自动重试 config.op.readRetries 次；
//   - 写操作不盲重试：带 expectedVersion 时先比版本（防覆盖别人的修改），连接中断后
//     先读回远端现状核对「上次写入是否已生效」，再决定是否重发（幂等）；
//   - 重活（大文件、搜索、长命令）走 bulk 车道，不阻塞交互车道。

const crypto = require('node:crypto');
const { DETECT_COMMAND, parseDetect } = require('./dialect');
const { execOnce } = require('./exec-ops');
const { sftpFileOps } = require('./file-ops-sftp');
const { createExecFileOps } = require('./file-ops-exec');
const { resolveInside } = require('./path-guard');
const { remoteError, isRetryable } = require('../errors');

const BULK_FILE_BYTES = 256 * 1024;

function versionOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
}

class RemoteHost {
  /**
   * @param {{pool, target, root: string, config}} options
   *   target: resolveTarget() 的结果；root: 远端工作区根目录（绝对路径）
   */
  constructor({ pool, target, root, config }) {
    this.pool = pool;
    this.target = target;
    this.root = root;
    this.config = config;
    this.profile = null; // { dialect, os, tools: Set, fileOps }
    this.profiling = null;
  }

  /** 首次使用时探测远端方言与可用工具，结果缓存；探测失败不缓存，下次重试。 */
  async ensureProfile() {
    if (this.profile) return this.profile;
    if (!this.profiling) {
      this.profiling = this.detectProfile().then((profile) => {
        this.profile = profile;
        return profile;
      }).finally(() => { this.profiling = null; });
    }
    return this.profiling;
  }

  async detectProfile() {
    const detected = await this.pool.run(this.target, { kind: 'detect' }, (raw, options) => execOnce(raw, DETECT_COMMAND, options));
    const parsed = parseDetect(detected.stdout.toString('utf8'));
    if (!parsed) throw remoteError('unsupported_remote', '无法识别远端系统（需要 POSIX sh 或 Windows PowerShell）');
    const { dialect, os } = parsed;
    const exec = dialect.id === 'posix' ? this.shellRunner('detect', 'interactive') : this.execRunner('detect', 'interactive');
    const tools = await exec(dialect.probeTools(), {});
    const toolSet = new Set(tools.stdout.toString('utf8').split(/\r?\n/)[0].trim().split(/\s+/).filter(Boolean));
    const commandOps = createExecFileOps(dialect);
    let fileOps = commandOps;
    if (dialect.id !== 'posix') {
      try {
        await this.pool.run(this.target, { kind: 'detect' }, (raw, options) => sftpFileOps.stat(raw, this.root, options));
        fileOps = sftpFileOps;
      } catch (error) {
        if (error.code === 'not_found') throw remoteError('workspace_root_missing', `远端工作区目录不存在：${this.root}`);
        // 其他错误（SFTP 子系统缺失 / 被禁用）：保持命令策略。
      }
    }
    const profile = { dialect, os, tools: toolSet, fileOps };
    if (fileOps === commandOps) {
      try {
        await this.fileCall(profile, 'detect', 'interactive', 'stat', this.root);
      } catch (error) {
        if (error.code === 'not_found') throw remoteError('workspace_root_missing', `远端工作区目录不存在：${this.root}`);
        throw error;
      }
    }
    return profile;
  }

  /** POSIX：命令送进常驻命令会话。 */
  shellRunner(kind, lane) {
    return (command, options = {}) => this.pool.runShell(this.target, { kind, lane, timeoutMs: options.timeoutMs }, command, options);
  }

  /** Windows / 判型前：一次性 exec 通道。 */
  execRunner(kind, lane) {
    return (command, options = {}) => this.pool.run(this.target, { kind, lane, timeoutMs: options.timeoutMs },
      (raw, base) => execOnce(raw, command, { ...base, ...options, timeoutMs: base.timeoutMs }));
  }

  runnerFor(profile, kind, lane) {
    return profile.dialect.id === 'posix' ? this.shellRunner(kind, lane) : this.execRunner(kind, lane);
  }

  /** 调一个文件操作：SFTP 策略拿原始连接上的通道；命令策略拿命令执行器。 */
  fileCall(profile, kind, lane, method, ...args) {
    return this.fileCallWith(profile, kind, lane, method, args, {});
  }

  fileCallWith(profile, kind, lane, method, args, extra) {
    if (profile.fileOps === sftpFileOps) {
      return this.pool.run(this.target, { kind, lane }, (raw, options) => sftpFileOps[method](raw, ...args, { ...options, ...extra }));
    }
    return profile.fileOps[method](this.runnerFor(profile, kind, lane), ...args, extra);
  }

  /** 带只读重试的执行器。 */
  async read(fn) {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (!isRetryable(error) || attempt >= this.config.op.readRetries) throw error;
        attempt += 1;
      }
    }
  }

  async resolve(relPath) {
    const profile = await this.ensureProfile();
    return { profile, ...resolveInside(this.root, relPath, profile.dialect) };
  }

  async stat(relPath) {
    const { profile, abs, rel } = await this.resolve(relPath);
    const info = await this.read(() => this.fileCall(profile, 'stat', 'interactive', 'stat', abs));
    return { path: rel, ...info };
  }

  async listDir(relPath = '') {
    const { profile, abs, rel } = await this.resolve(relPath);
    const entries = await this.read(() => this.fileCall(profile, 'list', 'interactive', 'listDir', abs));
    entries.sort((a, b) => (a.type === 'd') === (b.type === 'd') ? a.name.localeCompare(b.name) : (a.type === 'd' ? -1 : 1));
    return { path: rel, entries };
  }

  async readFile(relPath, { maxBytes } = {}) {
    const { profile, abs, rel } = await this.resolve(relPath);
    const limit = Math.min(maxBytes || this.config.op.readMaxBytes, this.config.op.readMaxBytes);
    const result = await this.read(() => this.fileCallWith(profile, 'read', 'interactive', 'readFile', [abs], { maxBytes: limit }));
    return { path: rel, content: result.content, size: result.size, mtime: result.mtime, version: versionOf(result.content) };
  }

  /**
   * 写文件。
   * @param {{expectedVersion?: string|null}} options
   *   expectedVersion：调用方读到的版本（readFile 返回的 version）；远端当前内容版本不一致即拒绝
   *   （version_conflict），不覆盖别人的修改。null 表示「必须是新文件」。省略则不校验。
   */
  async writeFile(relPath, content, { expectedVersion } = {}) {
    const { profile, abs, rel } = await this.resolve(relPath);
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const target = versionOf(body);
    const lane = body.length > BULK_FILE_BYTES ? 'bulk' : 'interactive';
    // 远端当前内容的版本（不存在为 null）；用于版本校验与断线后的落盘核对。
    const current = () => this.readFile(relPath).then((file) => file.version, (error) => {
      if (error.code === 'not_found') return null;
      throw error;
    });
    if (expectedVersion !== undefined) {
      const now = await current();
      if (now === target) return { path: rel, version: target, unchanged: true };
      if (now !== expectedVersion) {
        throw remoteError('version_conflict', `远端文件已被修改：${rel}`, { expected: expectedVersion, actual: now });
      }
    }
    try {
      const meta = await this.fileCall(profile, 'write', lane, 'writeFile', abs, body);
      return { path: rel, version: target, size: meta.size, mtime: meta.mtime };
    } catch (error) {
      if (!isRetryable(error)) throw error;
      // 连接中断时不知道写入是否已落盘：读回核对，已生效就当成功，否则再写一次。
      const now = await current();
      if (now === target) return { path: rel, version: target, recovered: true };
      const meta = await this.fileCall(profile, 'write', lane, 'writeFile', abs, body);
      return { path: rel, version: target, size: meta.size, mtime: meta.mtime, retried: true };
    }
  }

  async remove(relPath) {
    const { profile, abs, rel } = await this.resolve(relPath);
    if (!rel) throw remoteError('invalid_path', '不能删除工作区根目录');
    await this.fileCall(profile, 'remove', 'interactive', 'remove', abs);
    return { path: rel };
  }

  /** 搜索：在远端执行（rg 优先），结果流式截断，不把文件拉回来搜。 */
  async search(pattern, { maxResults = 200 } = {}) {
    const profile = await this.ensureProfile();
    const exec = this.runnerFor(profile, 'search', 'bulk');
    const result = await this.read(() => exec(profile.dialect.search(this.root, pattern, { maxResults }), { maxOutputBytes: 1024 * 1024 }));
    const matches = result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^(?:\.[\\/])?(.+?):(\d+):(.*)$/.exec(line);
      return match ? { path: match[1].replace(/\\/g, '/'), line: Number(match[2]), text: match[3].slice(0, 400) } : null;
    }).filter(Boolean);
    return { matches, truncated: matches.length >= maxResults || result.truncated };
  }

  /** 在工作区根目录执行命令（AI 工具调用 / git）。长命令走 bulk 车道。 */
  async run(command, { timeoutMs, lane = 'bulk', maxOutputBytes } = {}) {
    const profile = await this.ensureProfile();
    const exec = this.runnerFor(profile, 'exec', lane);
    const result = await exec(profile.dialect.run(this.root, command), {
      ...(timeoutMs ? { timeoutMs } : {}), ...(maxOutputBytes ? { maxOutputBytes } : {})
    });
    return {
      exitCode: result.code,
      signal: result.signal,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      truncated: result.truncated
    };
  }

  async capabilities() {
    const profile = await this.ensureProfile();
    return {
      os: profile.os,
      dialect: profile.dialect.id,
      fileTransport: profile.fileOps.id,
      tools: [...profile.tools].sort(),
      git: profile.tools.has('git')
    };
  }

  status() {
    return this.pool.snapshot(this.target.id);
  }
}

module.exports = { RemoteHost, versionOf };
