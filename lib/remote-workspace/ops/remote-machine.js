'use strict';

// 一台远端机器（不绑定工作区目录）的 Facade：识别系统 / 架构 / 家目录，在用户家目录下执行命令。
// 用于 toolkit 的「远端执行目标」：探测远端装了什么、在远端安装工具。
//
// 与 RemoteHost（工作区）共享同一个连接池：同一条 SSH 连接上的工作区与机器操作复用同一组连接。
// 命令通道：短命令（探测）在 POSIX 上走常驻命令会话（一个往返）；
// 长命令 / 需要流式输出的（安装）走 bulk 车道的一次性 exec 通道，不占住交互车道。

const { DETECT_COMMAND, parseDetect, psEncoded } = require('./dialect');
const { execOnce } = require('./exec-ops');
const { remoteError } = require('../errors');

const PLATFORM_BY_OS = Object.freeze({ darwin: 'macos', linux: 'linux', windows: 'windows' });

const POSIX_FACTS = 'uname -m 2>/dev/null; printf \'%s\\n\' "$HOME"';
const WINDOWS_FACTS = psEncoded('[Console]::Out.WriteLine($env:PROCESSOR_ARCHITECTURE); [Console]::Out.WriteLine([Environment]::GetFolderPath(\'UserProfile\'))');

function normalizeArch(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['x86_64', 'amd64', 'x64'].includes(text)) return 'x64';
  if (['arm64', 'aarch64'].includes(text)) return 'arm64';
  return text || 'unknown';
}

class RemoteMachine {
  /** @param {{pool, target, config}} options */
  constructor({ pool, target, config }) {
    this.pool = pool;
    this.target = target;
    this.config = config;
    this.facts = null;
    this.detecting = null;
  }

  /**
   * 远端事实（首次探测后缓存）：
   *   { dialect, os, platform: 'linux'|'macos'|'windows'|'', arch, home }
   * platform 为空表示不是三大平台之一（如 FreeBSD），toolkit 不提供安装方式。
   */
  async profile() {
    if (this.facts) return this.facts;
    if (!this.detecting) {
      this.detecting = this.detect().then((facts) => {
        this.facts = facts;
        return facts;
      }).finally(() => { this.detecting = null; });
    }
    return this.detecting;
  }

  async detect() {
    const detected = await this.pool.run(this.target, { kind: 'detect' }, (raw, options) => execOnce(raw, DETECT_COMMAND, options));
    const parsed = parseDetect(detected.stdout.toString('utf8'));
    if (!parsed) throw remoteError('unsupported_remote', '无法识别远端系统（需要 POSIX sh 或 Windows PowerShell）');
    const { dialect, os } = parsed;
    const facts = await this.pool.run(this.target, { kind: 'detect' }, (raw, options) => execOnce(raw,
      dialect.id === 'posix' ? POSIX_FACTS : WINDOWS_FACTS, options));
    const [arch, home] = facts.stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim());
    if (!home) throw remoteError('unsupported_remote', '无法读取远端用户家目录');
    return {
      dialect,
      os,
      platform: PLATFORM_BY_OS[String(os).toLowerCase()] || '',
      arch: normalizeArch(arch),
      home
    };
  }

  /**
   * 在远端用户家目录下执行一条命令（命令由调用方按 dialect 构造并转义）。
   * @param {{timeoutMs?, lane?: 'interactive'|'bulk', onOutput?, maxOutputBytes?, stdin?: string|Buffer}} options
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, truncated: boolean}>}
   */
  async exec(command, { timeoutMs, lane = 'interactive', onOutput, maxOutputBytes, stdin } = {}) {
    const { dialect } = await this.profile();
    const extra = {
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
      ...(onOutput ? { onOutput } : {}),
      ...(stdin !== undefined ? { stdin } : {})
    };
    const useSession = dialect.id === 'posix' && lane === 'interactive' && !onOutput;
    const result = useSession
      ? await this.pool.runShell(this.target, { kind: 'machine', lane, timeoutMs }, command, extra)
      : await this.pool.run(this.target, { kind: 'machine', lane, timeoutMs },
        (raw, options) => execOnce(raw, command, { ...options, ...extra }));
    return {
      code: result.code,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      truncated: Boolean(result.truncated)
    };
  }

  status() {
    return this.pool.snapshot(this.target.id);
  }
}

module.exports = { RemoteMachine, normalizeArch };
