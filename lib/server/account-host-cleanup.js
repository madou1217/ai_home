'use strict';

// 账号删除的宿主清理契约：Go 的删除事务通过回环管理面调用这里。
//
// 为什么需要这条通道：Go 的删除事务只掌握 aih.db 与账号投影；tmux 持久会话、
// 账号 socket 与登记文件只有 Node 有完整语义（socket 名由 persistent-session
// 派生、陈旧登记由 persistent-session-registry 判定）。matrix §5.3 把「进程、
// tmux、keychain、桌面 hook 仍只有 Node」列为明确缺口：只删库不清理宿主，会
// 留下攥着已删凭据的进程。
//
// 两段式契约，由调用方按事务位置选择：
//   verify(provider, accountRef)  —— 事务提交前调用，必须成功才能继续。
//     有活着的写入者就如实列出（调用方据此中止删除；账号事实还在，可重试），
//     探测无法确认时同样失败关闭；已经退出的陈旧登记顺手清掉。
//   cleanup(provider, accountRef) —— 事务提交后调用，幂等、可重试。
//     此时账号已经不存在，账号 socket 上的残留会话只可能攥着已删凭据，整个
//     服务端按 socket 回收；失败逐项上报而不是抛异常，重试即可。
//
// 安全边界：socket 名是 aih-<provider>-<accountRef>，一个账号一个 tmux 服务端，
// 所以 kill-server 不会波及其他账号；登记里出现非规范 socket（历史/手写登记）
// 时只杀登记点名的会话，绝不整服务端回收。

const nodeFs = require('node:fs');
const { isAccountRef } = require('../account/public-account-ref');
const persistentSession = require('../runtime/persistent-session');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');

const TMUX_COMMAND_TIMEOUT_MS = 1500;
const MAX_PROVIDER_LENGTH = 64;
// 只接受持久会话登记用的字符集：socket 与会话名都会进入 tmux argv，
// 不能给任何 shell 元字符或路径分隔符留位置。
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider || provider.length > MAX_PROVIDER_LENGTH) return '';
  return SAFE_KEY_PATTERN.test(provider) ? provider : '';
}

// normalizeTarget 按删除合同校验目标；provider 与账号引用任一不合法都返回 null。
function normalizeTarget(providerRaw, accountRefRaw) {
  const provider = normalizeProvider(providerRaw);
  const accountRef = String(accountRefRaw || '').trim();
  if (!provider || !isAccountRef(accountRef)) return null;
  return { provider, accountRef };
}

function createServiceError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// probeSocket 探测一个 tmux socket 的三态：alive / absent / unknown。
// unknown 包裹「没有 tmux 引擎」「命令超时」「输出无法判断」，调用方必须
// fail-closed：无法确认的会话仍可能攥着待删除账号的凭据。
function probeSocket(spawnSyncImpl, tmux, socket) {
  if (!tmux || tmux.available !== true) return { status: 'unknown', sessions: [] };
  let probe = null;
  try {
    probe = spawnSyncImpl(tmux.command, ['-u', '-L', socket, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: TMUX_COMMAND_TIMEOUT_MS
    });
  } catch (_error) {
    return { status: 'unknown', sessions: [] };
  }
  if (probe && !probe.error && probe.status === 0) {
    const sessions = String(probe.stdout || '')
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    return { status: 'alive', sessions };
  }
  if (persistentSession.isMissingServerProbe(probe)) return { status: 'absent', sessions: [] };
  return { status: 'unknown', sessions: [] };
}

function killServer(spawnSyncImpl, tmux, socket) {
  try {
    spawnSyncImpl(tmux.command, ['-u', '-L', socket, 'kill-server'], {
      stdio: 'ignore',
      timeout: TMUX_COMMAND_TIMEOUT_MS
    });
  } catch (_error) { /* 复探会给出真实结论，这里不吞不抛 */ }
}

function killSession(spawnSyncImpl, tmux, socket, session) {
  try {
    spawnSyncImpl(tmux.command, ['-u', '-L', socket, 'kill-session', '-t', session], {
      stdio: 'ignore',
      timeout: TMUX_COMMAND_TIMEOUT_MS
    });
  } catch (_error) { /* 同上：以复探为准 */ }
}

/**
 * createAccountHostCleanupService 组装宿主清理；所有外部依赖都可注入，
 * 测试用 temp HOME 与假 tmux 即可覆盖三态。
 */
function createAccountHostCleanupService(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const spawnSyncImpl = options.spawnSync || require('node:child_process').spawnSync;
  const sessionModule = options.persistentSession || persistentSession;
  const registry = options.persistentSessionRegistry || persistentSessionRegistry;

  function listAccountEntries(provider, accountRef, { strict }) {
    const entries = registry.listEntries(aiHomeDir, { fs: fsImpl, strict });
    return (Array.isArray(entries) ? entries : []).filter((entry) => (
      entry && entry.gateway !== true
      && entry.provider === provider
      && entry.accountRef === accountRef
    ));
  }

  // canonicalSocket 是派生 socket；派生失败说明账号引用/Provider 不合规，
  // 由 normalizeTarget 提前挡掉，这里只做兜底。
  function canonicalSocket(provider, accountRef) {
    try {
      return sessionModule.deriveSocket(provider, accountRef);
    } catch (_error) {
      return '';
    }
  }

  function detectTmux() {
    try {
      return sessionModule.detectTmux({ spawnSync: spawnSyncImpl });
    } catch (_error) {
      return { available: false };
    }
  }

  /**
   * verify 在删除提交前确认宿主上没有仍然活着的写入者。
   *
   * 返回 { blockers, reaped, sockets }；blockers 非空表示调用方必须中止删除。
   * 探测不确定时抛 account_host_state_unknown（同样对应「不能删」）。
   */
  function verify(providerRaw, accountRefRaw) {
    const target = normalizeTarget(providerRaw, accountRefRaw);
    if (!target) throw createServiceError('account_host_cleanup_invalid_target', '删除目标无效');
    if (!aiHomeDir) throw createServiceError('account_host_cleanup_unavailable', '缺少 AIH 数据根');

    let entries = [];
    try {
      entries = listAccountEntries(target.provider, target.accountRef, { strict: true });
    } catch (cause) {
      const error = createServiceError('account_host_state_unknown', '持久会话登记不可读');
      error.cause = cause;
      throw error;
    }

    const tmux = detectTmux();
    const canonical = canonicalSocket(target.provider, target.accountRef);
    const sockets = new Set(entries.map((entry) => entry.socket).filter(Boolean));
    // 没有引擎时只核对登记：登记说没有会话就放行（与 Node 既有语义一致），
    // 不能因为「这台机器没装 tmux」把所有账号的删除都判成不可验证。
    if (canonical && tmux.available === true) sockets.add(canonical);

    const probes = new Map();
    const blockers = [];
    let reaped = 0;
    let probeUncertain = false;
    for (const socket of sockets) {
      const probe = probeSocket(spawnSyncImpl, tmux, socket);
      if (probe.status === 'unknown') probeUncertain = true;
      probes.set(socket, probe);
    }

    // 登记逐条对账：精确会话还活着才是占用；服务端不在 / 会话已退出都算陈旧，
    // 当场清掉，避免它们在下一次删除时再次拦住。
    const registeredBySocket = new Map();
    for (const entry of entries) {
      registeredBySocket.set(entry.socket, (registeredBySocket.get(entry.socket) || new Set()).add(entry.session));
      const probe = probes.get(entry.socket) || { status: 'unknown', sessions: [] };
      // 探测不确定的条目在函数末尾统一抛 503，不当成「占用」上报。
      if (probe.status === 'unknown') continue;
      if (probe.status === 'absent' || !probe.sessions.includes(entry.session)) {
        // 只统计真正删掉的登记：文件已被别的流程清掉时 reaped 不该虚增。
        if (registry.removeEntry(aiHomeDir, entry.socket, entry.session, { fs: fsImpl })) {
          reaped += 1;
        }
        continue;
      }
      blockers.push({
        kind: 'persistent_session',
        label: '挂起的持久会话（tmux）',
        provider: target.provider,
        session: entry.session,
        socket: entry.socket,
        uncertain: false
      });
    }

    // 账号 socket 上还有登记之外的会话：socket 是账号私有的，这些同样是写入者。
    // 登记缺一条不能当成「没有占用」——否则删除会漏掉一个攥着凭据的进程。
    for (const socket of sockets) {
      const probe = probes.get(socket);
      if (!probe || probe.status !== 'alive') continue;
      const registered = registeredBySocket.get(socket) || new Set();
      for (const session of probe.sessions) {
        if (registered.has(session)) continue;
        blockers.push({
          kind: 'persistent_session',
          label: '挂起的持久会话（tmux）',
          provider: target.provider,
          session,
          socket,
          uncertain: false,
          unregistered: true
        });
      }
    }

    // 探测不确定与活会话是两种不同的事实：前者不能靠「强制删除」解决，
    // 必须让调用方看到 account_host_state_unknown（503），而不是 409。
    if (probeUncertain) {
      throw createServiceError('account_host_state_unknown', '无法确认宿主会话已经退出');
    }
    return {
      ok: blockers.length === 0,
      provider: target.provider,
      accountRef: target.accountRef,
      blockers,
      reaped,
      sockets: [...sockets]
    };
  }

  /**
   * cleanup 在账号事实提交后回收宿主残留。
   *
   * 账号已经不存在：规范 socket 直接整服务端回收（一个账号一个服务端），
   * 非规范 socket 只杀登记点名的会话。返回逐项结果，ok=false 表示还有没收干净
   * 的目标，调用方可以原样重试（本函数幂等）。
   */
  function cleanup(providerRaw, accountRefRaw) {
    const target = normalizeTarget(providerRaw, accountRefRaw);
    if (!target) throw createServiceError('account_host_cleanup_invalid_target', '删除目标无效');
    if (!aiHomeDir) throw createServiceError('account_host_cleanup_unavailable', '缺少 AIH 数据根');

    let entries = [];
    let registryError = '';
    try {
      entries = listAccountEntries(target.provider, target.accountRef, { strict: false });
    } catch (cause) {
      registryError = String((cause && cause.message) || cause || 'registry_unreadable');
    }

    const tmux = detectTmux();
    const canonical = canonicalSocket(target.provider, target.accountRef);
    const sockets = new Set(entries.map((entry) => entry.socket).filter(Boolean));
    // 没有 tmux 引擎就没有可回收的服务端；登记里的 socket 仍会逐条如实上报。
    if (canonical && tmux.available === true) sockets.add(canonical);

    const results = [];
    for (const socket of sockets) {
      const probe = probeSocket(spawnSyncImpl, tmux, socket);
      if (probe.status === 'unknown') {
        // 状态未知时不动 tmux，也不删登记：登记是重试时唯一能定位会话的记录。
        results.push({ socket, action: 'skipped_unknown', sessions: [], removed: 0 });
        continue;
      }
      if (probe.status === 'absent') {
        const removed = registry.removeEntriesForSocket(aiHomeDir, socket, { fs: fsImpl });
        results.push({ socket, action: 'absent', sessions: [], removed });
        continue;
      }
      if (socket === canonical) {
        killServer(spawnSyncImpl, tmux, socket);
      } else {
        for (const entry of entries) {
          if (entry.socket !== socket) continue;
          if (!SAFE_KEY_PATTERN.test(String(entry.session || ''))) continue;
          killSession(spawnSyncImpl, tmux, socket, entry.session);
        }
      }
      const after = probeSocket(spawnSyncImpl, tmux, socket);
      if (after.status === 'absent') {
        const removed = registry.removeEntriesForSocket(aiHomeDir, socket, { fs: fsImpl });
        results.push({ socket, action: 'killed', sessions: probe.sessions, removed });
        continue;
      }
      // 复探仍看到会话（或无法确认）：登记保留，交给下一次重试。
      results.push({
        socket,
        action: 'kill_failed',
        sessions: after.status === 'alive' ? after.sessions : probe.sessions,
        removed: 0,
        reason: after.status === 'alive' ? 'persistent_session_still_alive' : 'probe_unknown'
      });
    }

    return {
      // 只有「确定收干净了」才算成功：kill_failed 与 skipped_unknown 都会让
      // 调用方看到 degraded，同一请求可以原样重试。
      ok: results.every((row) => row.action === 'killed' || row.action === 'absent') && !registryError,
      provider: target.provider,
      accountRef: target.accountRef,
      results,
      ...(registryError ? { registryError } : {})
    };
  }

  return { verify, cleanup };
}

module.exports = {
  createAccountHostCleanupService,
  normalizeTarget
};
