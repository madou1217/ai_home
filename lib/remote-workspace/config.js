'use strict';

// 远程工作区通道的全部可调参数集中在这里（不新增环境变量：项目对公开 env 有硬上限）。
// 调用方只能整体覆盖一份配置对象；各层从注入的 config 读，不各自定义魔法数字。

const DEFAULT_REMOTE_WORKSPACE_CONFIG = Object.freeze({
  connect: Object.freeze({
    readyTimeoutMs: 10000,
    // ssh2 自带的 keepalive 只是兜底；真正判活靠 health 的应用层往返。
    keepaliveIntervalMs: 15000,
    keepaliveCountMax: 3
  }),
  pool: Object.freeze({
    // 交互车道（文件树 / 读文件 / AI 工具调用）与重活车道（大文件 / 长命令 / 搜索）分连接，
    // 重活不会把交互的往返堵住。
    lanes: Object.freeze({ interactive: 1, bulk: 1 }),
    idleCloseMs: 10 * 60 * 1000
  }),
  channel: Object.freeze({
    // sshd 默认 MaxSessions=10；留余量，超出排队。
    maxPerConnection: 8,
    // 其中最多这么多个是常驻命令会话（每个长期占一个通道）；其余留给 sftp / 长命令。
    shellsPerConnection: 4,
    acquireTimeoutMs: 15000
  }),
  health: Object.freeze({
    probeIntervalMs: 5000,
    // 探测超时 = max(floor, rtt 基线 * multiplier)：慢链路不误判，快链路判得快。
    probeTimeoutFloorMs: 1500,
    probeTimeoutMultiplier: 3,
    failuresBeforeDead: 2
  }),
  breaker: Object.freeze({
    failureThreshold: 3,
    openMs: 5000,
    maxOpenMs: 60000
  }),
  reconnect: Object.freeze({
    backoffMs: Object.freeze([500, 1000, 2000, 5000, 10000, 20000, 30000])
  }),
  op: Object.freeze({
    defaultTimeoutMs: 15000,
    readMaxBytes: 2 * 1024 * 1024,
    // 断线后只读操作自动重试次数；写操作不盲重试（见 file-ops 的幂等核对）。
    readRetries: 2
  }),
  telemetry: Object.freeze({
    window: 200
  })
});

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(value, override[key])
      : (override[key] !== undefined ? override[key] : value);
  }
  return Object.freeze(out);
}

function resolveRemoteWorkspaceConfig(override) {
  return mergeConfig(DEFAULT_REMOTE_WORKSPACE_CONFIG, override);
}

module.exports = {
  DEFAULT_REMOTE_WORKSPACE_CONFIG,
  resolveRemoteWorkspaceConfig
};
