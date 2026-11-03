'use strict';

// 常驻命令会话（POSIX）：在一条 SSH 连接上开一个长期存活的 `sh` 通道，命令逐条写进去，
// 用带随机 nonce 的结束标记切分输出。
//
// 为什么要它：每个 exec 都要「开通道 + 发 exec 请求」两个往返，远端还要为每条命令重新起登录
// shell；常驻会话把每次操作压到一个往返（网络稳定时 = RTT + 远端执行时间）。
//
// 协议（每条命令一帧）：
//   ( <command> ) </dev/null 2>&3 3>&-        ← 子 shell：exit / cd / 变量都不会污染会话
//   printf '\n<MARK> %d\n' $?                 ← stdout 结束标记带退出码
//   printf '\n<MARK>\n' >&2                   ← stderr 结束标记（两个流各自有序，都要等到）
// stdin：命令需要输入（写文件的 base64）时用 heredoc 内联，不占会话的 stdin。
//
// 故障语义：超时 / 取消 / 通道异常 → 会话作废（destroy），绝不复用一个状态未知的会话；
// 调用方（ShellPool）会按需新开。

const crypto = require('node:crypto');
const { withDeadline } = require('./deadline');
const { remoteError, fromTransportError } = require('../errors');

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

class ShellSession {
  /**
   * @param {{raw, timers?}} options raw: ssh2 Client（已就绪）
   */
  constructor({ raw, timers }) {
    this.raw = raw;
    this.timers = timers || { setTimeout, clearTimeout };
    this.stream = null;
    this.busy = false;
    this.dead = false;
    this.nonce = crypto.randomBytes(12).toString('hex');
    this.seq = 0;
    this.onStdout = null;
    this.onStderr = null;
    this.onClosed = null;
  }

  /** 打开会话通道（一次往返 + 远端起 sh）。 */
  open({ timeoutMs, label = 'shell open' } = {}) {
    return withDeadline(({ resolve, reject }) => {
      // `exec sh`：不加载交互式配置（.bashrc 的 echo 会污染输出）；stderr 走 fd 3 → 通道 stderr。
      this.raw.exec('exec sh -c \'exec 3>&2; exec sh\'', (error, stream) => {
        if (error) return reject(remoteError('channel_open_failed', '无法在远端打开命令会话', { cause: String(error.message || error) }));
        this.stream = stream;
        stream.on('data', (chunk) => this.onStdout && this.onStdout(chunk));
        stream.stderr.on('data', (chunk) => this.onStderr && this.onStderr(chunk));
        stream.on('error', (streamError) => this.fail(fromTransportError(streamError)));
        stream.once('close', () => this.fail(remoteError('connection_lost', '远端命令会话已关闭')));
        resolve(this);
      });
    }, { timeoutMs, label, timers: this.timers });
  }

  fail(error) {
    if (this.dead) return;
    this.dead = true;
    const notify = this.onClosed;
    this.onClosed = null;
    if (notify) notify(error);
  }

  destroy() {
    this.fail(remoteError('connection_lost', '命令会话已作废'));
    if (this.stream) { try { this.stream.close(); } catch (_error) { /* gone */ } }
    this.stream = null;
  }

  /**
   * 执行一条命令（会话内串行，调用方保证同一时刻只跑一条）。
   * @param {string} command POSIX sh 命令（调用方已转义）
   * @param {{timeoutMs, label?, stdin?: Buffer|string, maxOutputBytes?, signal?}} options
   * @returns {Promise<{code: number|null, signal: null, stdout: Buffer, stderr: Buffer, truncated: boolean}>}
   */
  run(command, options = {}) {
    if (this.dead) return Promise.reject(remoteError('connection_lost', '命令会话已关闭'));
    this.seq += 1;
    const mark = `__AIH_${this.nonce}_${this.seq}__`;
    const limit = options.maxOutputBytes || DEFAULT_OUTPUT_LIMIT;
    const out = new FrameReader(mark, limit);
    const err = new FrameReader(mark, 64 * 1024);
    let script;
    if (options.stdin !== undefined) {
      // stdin 内容一律 base64 后内联 heredoc（base64 字符集不可能撞上结束符）。
      const eof = `AIH_EOF_${this.nonce}`;
      const body = Buffer.from(options.stdin).toString('base64').replace(/(.{76})/g, '$1\n');
      // 远端解码后经管道作为命令的 stdin；管道的退出码就是命令的退出码。
      script = `{ (base64 -d 2>/dev/null || base64 -D) <<'${eof}'\n${body}\n${eof}\n} | ( ${command}\n) 2>&3\n`;
    } else {
      script = `( ${command}\n) </dev/null 2>&3\n`;
    }
    script += `printf '\\n${mark} %d\\n' $?; printf '\\n${mark}\\n' >&3\n`;
    return withDeadline(({ resolve, reject }) => {
      const finish = () => {
        if (!out.done || !err.done) return;
        this.onStdout = null; this.onStderr = null; this.onClosed = null;
        const code = Number.parseInt(out.trailer, 10);
        resolve({ code: Number.isFinite(code) ? code : null, signal: null, stdout: out.output(), stderr: err.output(), truncated: out.truncated });
      };
      this.onStdout = (chunk) => { out.push(chunk); finish(); };
      this.onStderr = (chunk) => { err.push(chunk); finish(); };
      this.onClosed = (error) => reject(error);
      try {
        this.stream.write(script);
      } catch (error) {
        reject(fromTransportError(error));
      }
      // 超时 / 取消：会话里可能还有一条在跑的命令，状态未知 → 整个会话作废。
      return () => this.destroy();
    }, { timeoutMs: options.timeoutMs, label: options.label || 'shell command', signal: options.signal, timers: this.timers });
  }
}

/**
 * 从字节流里按结束标记切出一帧。标记形如 `\n<mark>[ trailer]\n`；标记前那个 `\n` 是我们追加的，
 * 不属于命令输出。超过 limit 的输出丢弃（truncated=true），但仍持续扫描标记。
 */
class FrameReader {
  constructor(mark, limit) {
    this.needle = Buffer.from(`\n${mark}`);
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
    this.pending = Buffer.alloc(0); // 尚未确认「不是标记的一部分」的尾部字节
    this.done = false;
    this.trailer = '';
  }

  push(chunk) {
    if (this.done) return;
    const window = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const at = window.indexOf(this.needle);
    if (at >= 0) {
      const lineEnd = window.indexOf(0x0a, at + this.needle.length);
      if (lineEnd < 0) { this.pending = Buffer.from(window); return; } // 标记行还没收全
      this.append(window.subarray(0, at));
      this.trailer = window.subarray(at + this.needle.length, lineEnd).toString('utf8').trim();
      this.pending = Buffer.alloc(0);
      this.done = true;
      return;
    }
    // 标记可能跨块：末尾留 needle.length-1 字节待下次拼接，其余确认属于输出。
    const hold = Math.min(window.length, this.needle.length - 1);
    this.append(window.subarray(0, window.length - hold));
    this.pending = Buffer.from(window.subarray(window.length - hold));
  }

  append(piece) {
    if (!piece.length) return;
    if (this.size >= this.limit) { this.truncated = true; return; }
    const room = this.limit - this.size;
    const part = piece.length > room ? piece.subarray(0, room) : piece;
    if (part.length < piece.length) this.truncated = true;
    this.chunks.push(Buffer.from(part));
    this.size += part.length;
  }

  output() {
    return Buffer.concat(this.chunks);
  }
}

module.exports = { FrameReader, ShellSession };
